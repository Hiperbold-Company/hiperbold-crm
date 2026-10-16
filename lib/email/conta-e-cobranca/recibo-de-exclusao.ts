/**
 * O recibo da exclusão dos dados de uma organização (ADM-01, migration 0959), SÓ para o operador da instalação.
 *
 * Fora da fila `billing_emails_enviados` de propósito: aquela fila é por organização (`organization_id` com
 * cascata) e a organização acabou de ser excluída, então a linha da fila sumiria junto. O recibo sai direto,
 * uma vez, para quem recebe a cópia dos avisos (`EMAIL_DE_COPIA_DOS_AVISOS`, ou os administradores da
 * plataforma), um envio por endereço, em português e com a marca da instalação. Melhor esforço: a prova da
 * exclusão é a linha `org.data_purged` da auditoria, não o e-mail; falha aqui vira log e nunca desfaz nada.
 * Só contagens: nenhum dado de contato.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { marcaDaSaida } from "@/lib/branding/saida";
import { buildExclusaoDeDadosConcluidaEmail } from "@/lib/email/templates/exclusao-de-dados-concluida";
import { emailConfigurado, sendEmail } from "@/lib/email/roteador";
import { env } from "@/lib/env";
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { logger } from "@/lib/logger";

import { destinatariosDaCopiaDoOperador, mascararEmail, type DepsDoEnvio } from "./enviar";

export interface DadosDoRecibo {
  nomeDaOrganizacao: string;
  origem: "automatica" | "manual";
  motivo: "cancelada" | "suspensa" | "manual";
  contatos: number;
  conversas: number;
  mensagens: number;
  negocios: number;
  arquivosApagados: number;
  conexoesEncerradas: number;
  registrosFiscaisArquivados: number;
  usuariosRemovidos: number;
  usuariosMantidos: number;
}


/** Devolve quantos endereços receberam. Nunca lança. */
export async function enviarReciboDeExclusao(
  admin: SupabaseClient,
  dados: DadosDoRecibo,
  deps?: Partial<{
    enviar: typeof sendEmail;
    destinatarios: () => Promise<string[]>;
    configurado: () => Promise<boolean>;
  }>,
): Promise<number> {
  try {
    const configurado = deps?.configurado ?? emailConfigurado;
    if (!(await configurado())) return 0;
    const destinatarios =
      deps?.destinatarios ??
      (() =>
        destinatariosDaCopiaDoOperador({
          admin,
          sendEmail,
          emailConfigurado,
          marcaDaSaida,
          appUrl: env.NEXT_PUBLIC_APP_URL.replace(/\/$/, ""),
          configuracaoDaCopia: async () => (await valorDaInstalacao("EMAIL_DE_COPIA_DOS_AVISOS")).valor,
        }));
    const enderecos = await destinatarios();
    if (enderecos.length === 0) return 0;

    const marca = await marcaDaSaida(null);
    const url = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/admin/sistema/exclusoes`;
    const mensagem = buildExclusaoDeDadosConcluidaEmail({
      marca,
      idioma: "pt-BR",
      empresa: marca.nome,
      url,
      ...dados,
    });
    const enviar = deps?.enviar ?? sendEmail;
    let enviados = 0;
    for (const para of enderecos) {
      try {
        const r = await enviar({
          to: para,
          subject: mensagem.subject,
          html: mensagem.html,
          text: mensagem.text,
          fromName: marca.nome,
          tags: [{ name: "tipo", value: "ADM-01" }],
        });
        if (r.ok) enviados++;
        else logger.warn("[exclusao] recibo não saiu", { para: mascararEmail(para), motivo: r.error });
      } catch (erro) {
        logger.warn("[exclusao] envio do recibo lançou", {
          para: mascararEmail(para),
          motivo: erro instanceof Error ? erro.message.replace(/\S+@\S+/g, "***").slice(0, 120) : "erro",
        });
      }
    }
    return enviados;
  } catch (erro) {
    logger.warn("[exclusao] recibo falhou", {
      motivo: erro instanceof Error ? erro.message.replace(/\S+@\S+/g, "***").slice(0, 120) : "erro",
    });
    return 0;
  }
}
