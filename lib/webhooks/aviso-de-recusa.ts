/**
 * Aviso na Central quando uma fonte de captação RECUSA um lead (decisão do dono
 * do produto, 17/10/2026).
 *
 * Quem publicou o formulário só descobria a recusa se abrisse "Leads recebidos";
 * o lead perdido era silencioso. Agora toda recusa — corpo inválido, sem campo
 * reconhecível, assinatura, verificação de segurança, erro ao criar, limite do
 * plano — abre UM aviso por fonte por dia, com o motivo da primeira recusa do dia.
 *
 * Deduplicação (organização + `kind` + título): o título carrega o NOME da fonte
 * e o DIA (fuso America/Sao_Paulo, o mesmo de `aviso-limite-de-leads.ts`), então
 * uma rajada de recusas no mesmo dia vira um aviso só e, se amanhã continuar
 * recusando, nasce outro. Não filtra por `status`: quem resolveu o aviso de manhã
 * não ganha outro igual à tarde. Duas fontes com o MESMO nome dividem o aviso.
 *
 * `kind = 'other'` e sem `ref_*`: a Central mostra o texto, sem botão de destino
 * (o corpo diz onde olhar). O limite do plano continua com o aviso próprio da
 * organização (`avisarLimiteDeLeadsAtingido`); este é por FONTE.
 *
 * A leitura-antes-de-inserir sozinha deixava a corrida passar (duas recusas ao
 * mesmo tempo gravavam dois avisos): o índice único parcial da migration 0965
 * fecha a corrida e o `23505` do INSERT é tratado como "já existe".
 *
 * Nunca lança, nunca leva dado do lead: só o nome da fonte e o motivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

const FUSO = "America/Sao_Paulo";
const TAMANHO_MAXIMO_DO_NOME = 80;

/** dd/mm/aaaa no fuso de São Paulo, sem passar idioma ao formatador (é chave de dedup). */
export function diaDoAviso(agora: Date): string {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(agora);
  const parte = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? "";
  return `${parte("day")}/${parte("month")}/${parte("year")}`;
}

export function tituloDoAvisoDeRecusa(nomeDaFonte: string, agora: Date): string {
  return `A fonte ${nomeDaFonte.slice(0, TAMANHO_MAXIMO_DO_NOME)} recusou um lead em ${diaDoAviso(agora)}`;
}

export function corpoDoAvisoDeRecusa(nomeDaFonte: string, motivoLegivel: string): string {
  const limpo = motivoLegivel.trim().replace(/\.+$/, "");
  const motivo = limpo.charAt(0).toLowerCase() + limpo.slice(1);
  return `A fonte ${nomeDaFonte.slice(0, TAMANHO_MAXIMO_DO_NOME)} recusou um lead: ${motivo}. Veja em Webhooks › Leads recebidos.`;
}

export async function avisarRecusaDaFonte(
  admin: SupabaseClient,
  entrada: { organizationId: string; sourceName: string; motivoLegivel: string },
  agora: Date = new Date(),
): Promise<void> {
  const titulo = tituloDoAvisoDeRecusa(entrada.sourceName, agora);
  try {
    const { data: linhas, error: erroLeitura } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", entrada.organizationId)
      .eq("kind", "other")
      .eq("title", titulo)
      .limit(1);
    if (erroLeitura) {
      // Sem saber se já existe, não insere (evita duplicar às cegas).
      logger.warn("aviso-de-recusa: leitura falhou, aviso NÃO gravado", {
        organization_id: entrada.organizationId,
        detail: erroLeitura.message.slice(0, 160),
      });
      return;
    }
    if (linhas && linhas.length > 0) return;

    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: entrada.organizationId,
      kind: "other",
      severity: "warn",
      title: titulo,
      body: corpoDoAvisoDeRecusa(entrada.sourceName, entrada.motivoLegivel),
    });
    // 23505 = o índice único `agent_inbox_items_aviso_de_recusa_dia_uq` (migration 0965)
    // recusou a segunda linha do mesmo dia: duas recusas simultâneas passam juntas pela
    // leitura acima, e só o banco serializa. É o "on conflict do nothing" — o aviso do dia
    // já existe, nada a fazer e nada a logar.
    if (error && error.code !== "23505") {
      logger.warn("aviso-de-recusa: aviso não gravado", {
        organization_id: entrada.organizationId,
        detail: error.message.slice(0, 160),
      });
    }
  } catch (err) {
    logger.warn("aviso-de-recusa: aviso não gravado", {
      organization_id: entrada.organizationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
  }
}
