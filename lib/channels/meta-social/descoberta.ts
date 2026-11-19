/**
 * A descoberta das contas que um token da Meta alcança, e a conexão das que a
 * pessoa escolheu — UM caminho, usado pelo callback do OAuth, pela listagem da
 * escolha e pela confirmação (`app/api/v1/channels/meta-social/selecao`).
 *
 * Por que compartilhar (D-242): com duas ou mais contas o callback não conecta
 * nada; guarda só o token-fonte e o MODO da descoberta num cookie selado
 * (`selecao.ts`) e a tela pergunta quais contas são desta empresa. A listagem
 * e a confirmação redescobrem com o mesmo token e o mesmo modo. Se cada um
 * descobrisse do seu jeito, a tela poderia mostrar uma conta e a confirmação
 * conectar outra.
 *
 * O modo é o ramo que achou as contas no callback, e a redescoberta NÃO cai
 * para outro plano: quem foi achado pela Página continua pela Página.
 *   - `instagram_sistema`: token do usuário do sistema (SUAT); contas do
 *     `assigned_instagram_accounts`, ou do `debug_token` quando a lista vem vazia.
 *     Todas com o MESMO token.
 *   - `instagram_pagina`: token de usuário LONGO; contas pela Página que as
 *     possui, cada uma com o token da Página.
 *   - `messenger`: token de usuário LONGO; cada Página com o token dela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AppOAuth } from "./config";
import type { PlataformaMetaSocial } from "./constantes";
import type { MotivoDaVolta } from "./motivos";
import {
  contasInstagramConcedidas,
  contasInstagramPeloDebugToken,
  paginasComInstagram,
  paginasMessenger,
  type ContaDaMeta,
} from "./oauth";
import type { ModoDaDescoberta } from "./selecao";
import { ConexaoRecusada, conectarConta, type Ator } from "./store";

/** Uma conta achada, com o token que ela usa para enviar e assinar o webhook. */
export interface ContaDescoberta {
  conta: ContaDaMeta;
  token: string;
  paginaId: string | null;
}

/** O que o diagnóstico de `nenhuma_conta_instagram` conta da descoberta pelo SUAT (sem segredo). */
export interface PistasDoSistema {
  /** Quantas contas o `assigned_instagram_accounts` trouxe, ou `null` se a chamada falhou. */
  assigned: number | null;
  planoB: { escopos: string[]; alvos: Record<string, number> } | null;
  planoBFalhou: boolean;
}

/** Instagram pelo SUAT: `assigned_instagram_accounts` e, vazio, o `debug_token` (plano B). */
export async function descobrirPeloSistema(
  app: AppOAuth,
  token: string,
): Promise<{ contas: ContaDescoberta[]; pistas: PistasDoSistema }> {
  const assigned = await contasInstagramConcedidas(token).catch(() => null);
  let concedidas = assigned ?? [];
  let planoB: Awaited<ReturnType<typeof contasInstagramPeloDebugToken>> | null = null;
  let planoBFalhou = false;
  if (concedidas.length === 0) {
    planoB = await contasInstagramPeloDebugToken(app, token).catch(() => {
      planoBFalhou = true;
      return null;
    });
    concedidas = planoB?.contas ?? [];
  }
  return {
    contas: concedidas.map((conta) => ({ conta, token, paginaId: null })),
    pistas: {
      assigned: assigned ? assigned.length : null,
      planoB: planoB ? { escopos: planoB.escopos, alvos: planoB.alvos } : null,
      planoBFalhou,
    },
  };
}

/** Instagram pela Página (plano C). `null` = a listagem das Páginas falhou. */
export async function descobrirPelasPaginas(
  token: string,
): Promise<{ contas: ContaDescoberta[]; vistas: number } | null> {
  const r = await paginasComInstagram(token).catch(() => null);
  if (!r) return null;
  return {
    vistas: r.vistas,
    contas: r.paginas.map((p) => ({ conta: p.conta, token: p.token, paginaId: p.paginaId })),
  };
}

/** Messenger: as Páginas concedidas. Falha da Meta sobe como `ErroDaMeta`. */
export async function descobrirMessenger(token: string): Promise<ContaDescoberta[]> {
  const paginas = await paginasMessenger(token);
  return paginas.map((p) => ({ conta: { id: p.id, nome: p.nome, usuario: null }, token: p.token, paginaId: null }));
}

/** Refaz a descoberta pelo modo gravado na escolha pendente. */
export async function redescobrir(modo: ModoDaDescoberta, app: AppOAuth, token: string): Promise<ContaDescoberta[]> {
  if (modo === "instagram_sistema") return (await descobrirPeloSistema(app, token)).contas;
  if (modo === "instagram_pagina") return (await descobrirPelasPaginas(token))?.contas ?? [];
  return descobrirMessenger(token);
}

export interface ResultadoDaConexao {
  conectadas: number;
  recusadas: number;
  /** A recusa que a pessoa resolve primeiro (limite do plano tem precedência); `null` sem recusa. */
  primeiraRecusa: MotivoDaVolta | null;
}

/**
 * Conecta cada conta com `conectarConta` (que é quem assina o webhook na Meta).
 * A conta que estourar o limite do plano, ou estiver em outra organização, não
 * derruba as outras. Erro que não é recusa sobe.
 */
export async function conectarDescobertas(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    plataforma: PlataformaMetaSocial;
    contas: ContaDescoberta[];
    expiraEm: string | null;
    ator: Ator;
    autorizadorId: string | null;
    empresaId: string | null;
  },
): Promise<ResultadoDaConexao> {
  let conectadas = 0;
  let recusadas = 0;
  let primeiraRecusa: MotivoDaVolta | null = null;
  for (const c of input.contas) {
    try {
      await conectarConta(admin, {
        organizationId: input.organizationId,
        plataforma: input.plataforma,
        conta: c.conta,
        token: c.token,
        expiraEm: input.expiraEm,
        ator: input.ator,
        autorizadorId: input.autorizadorId,
        empresaId: input.empresaId,
        paginaId: c.paginaId,
      });
      conectadas += 1;
    } catch (err) {
      if (!(err instanceof ConexaoRecusada)) throw err;
      recusadas += 1;
      // Limite do plano tem precedência na mensagem: é o que a pessoa resolve.
      if (primeiraRecusa === null || err.motivo === "limite_do_plano") primeiraRecusa = err.motivo;
    }
  }
  return { conectadas, recusadas, primeiraRecusa };
}
