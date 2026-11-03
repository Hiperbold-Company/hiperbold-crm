/**
 * A fila de respostas a comentários do Instagram (migration 0991), consumida
 * pelo cron `meta-social-fila` a cada minuto.
 *
 * Regras, nesta ordem de importância:
 *  1. NUNCA enviar em dobro. A linha é reservada (`na_fila` → `enviando`) antes
 *     do envio, e só a reserva que mudou a linha envia. Primeiro envia, depois
 *     grava: se a gravação falhar, a linha fica `enviando` e não é reenviada —
 *     depois de `TRAVADA_APOS_MS` ela vira `falhou` ("sem confirmação").
 *  2. A resposta privada sai ANTES da pública do mesmo comentário. Responder em
 *     público antes deixa o comentário inelegível para a privada (erro 2534025,
 *     de um sistema em produção; NÃO CONFIRMADO NA DOC). A pública espera
 *     enquanto houver privada `na_fila` ou `enviando`.
 *  3. Teto por conta: `TETO_DE_RESPOSTAS_PRIVADAS_POR_HORA` privadas nos
 *     últimos 60 minutos. A pública não entra na conta (outro endpoint).
 *  4. Limite da Meta (códigos 4, 17, 32, 613 ou HTTP 429) reagenda com espera
 *     crescente e não é falha. Comentário com 7 dias ou mais, ou 2534025, vira
 *     `expirada`. Token recusado marca a sessão para reconectar (o mesmo
 *     tratamento do envio do Direct) e a linha espera.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { CHANNEL_PROVIDER_META_SOCIAL } from "../capabilities";
import { codigoDaFalhaDeEnvio, marcarTokenInvalido } from "./adapter";
import { comentarioVencido } from "./comentarios";
import { TETO_DE_RESPOSTAS_PRIVADAS_POR_HORA, type TipoDaFilaDeEnvio } from "./comentarios-contrato";
import { HOST_GRAPH_FACEBOOK, VERSAO_DA_GRAPH_SOCIAL } from "./constantes";
import { registrarEnvio } from "./envios";
import { ErroDaMeta, chamarMeta } from "./oauth";

const GRAPH = `${HOST_GRAPH_FACEBOOK}/${VERSAO_DA_GRAPH_SOCIAL}`;
const HORA_MS = 60 * 60 * 1000;
const MINUTO_MS = 60 * 1000;

/** Linhas lidas por rodada. A rodada é de minuto em minuto. */
export const LOTE_DA_FILA = 200;
/** `enviando` há mais que isto: a rodada que reservou morreu no meio. */
export const TRAVADA_APOS_MS = 10 * MINUTO_MS;
/** Falha de rede antes de desistir. Limite da Meta não conta aqui. */
export const MAX_TENTATIVAS_DE_REDE = 5;
/** Espera quando a Meta recusa o token: o tempo de alguém reconectar. */
export const ESPERA_DO_TOKEN_MS = 30 * MINUTO_MS;

/** Códigos de limite de chamadas da Graph API. */
const CODIGOS_DE_LIMITE: ReadonlySet<number> = new Set([4, 17, 32, 613]);
/** Comentário já não aceita resposta privada (de um sistema em produção). */
export const CODIGO_COMENTARIO_INELEGIVEL = 2534025;

export function ehErroDeLimite(err: ErroDaMeta): boolean {
  return err.status === 429 || (err.codigoDaMeta !== null && CODIGOS_DE_LIMITE.has(err.codigoDaMeta));
}

/** 2, 4, 8… minutos, até 1 hora. */
export function esperaCrescente(tentativas: number): number {
  return Math.min(Math.pow(2, Math.max(1, tentativas)) * MINUTO_MS, HORA_MS);
}

export interface RequisicaoDaFila {
  url: string;
  json?: Record<string, unknown>;
  form?: Record<string, string>;
}

/**
 * Resposta privada: POST /<PAGE_ID>/messages com `recipient.comment_id` e o
 * token da Página. Sem Página (login unificado), /<IG_ID>/messages com o
 * token do usuário do sistema: NÃO CONFIRMADO NA DOC (a doc só mostra a Página).
 * https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies
 */
export function requisicaoDaRespostaPrivada(input: {
  contaId: string;
  paginaId: string | null;
  commentId: string;
  texto: string;
}): RequisicaoDaFila {
  const alvo = input.paginaId ?? input.contaId;
  return {
    url: `${GRAPH}/${encodeURIComponent(alvo)}/messages`,
    json: { recipient: { comment_id: input.commentId }, message: { text: input.texto } },
  };
}

/**
 * Resposta pública: POST /<COMMENT_ID>/replies com `message`. A doc pede token
 * de usuário; com o token da Página é NÃO CONFIRMADO NA DOC.
 * https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies
 */
export function requisicaoDaRespostaPublica(commentId: string, texto: string): RequisicaoDaFila {
  return { url: `${GRAPH}/${encodeURIComponent(commentId)}/replies`, form: { message: texto } };
}

export interface ResumoDaFila {
  examinadas: number;
  enviadas: number;
  /** Voltaram para a fila: teto da conta, limite da Meta, rede, token. */
  reagendadas: number;
  /** Públicas esperando a privada do mesmo comentário. */
  aguardando: number;
  expiradas: number;
  falharam: number;
  /** `enviando` esquecidas por uma rodada que morreu, marcadas `falhou`. */
  destravadas: number;
}

interface LinhaDaFila {
  id: string;
  organization_id: string;
  channel_session_id: string;
  tipo: TipoDaFilaDeEnvio;
  comment_id: string;
  texto: string;
  tentativas: number;
  criado_em: string;
}

interface Credencial {
  contaId: string;
  paginaId: string | null;
  token: string;
}

interface ContextoDaSessao {
  credencial: Credencial | null | undefined;
  /** Privadas que ainda cabem nesta hora; `undefined` = ainda não medido. */
  orcamento: number | undefined;
  /** Quando a privada mais velha da janela sai dela (e abre uma vaga). */
  liberaEm: string | null;
  /** Até quando cada tipo desta sessão está parado nesta rodada. */
  pausa: Partial<Record<TipoDaFilaDeEnvio, string>>;
}

async function credencialDaSessao(
  admin: SupabaseClient,
  organizationId: string,
  sessionId: string,
): Promise<Credencial | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, meta_social_platform, meta_social_account_id, meta_social_token_encrypted, meta_social_page_id")
    .eq("organization_id", organizationId)
    .eq("id", sessionId)
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .is("archived_at", null)
    .limit(1);
  if (error) throw new Error("meta_social_session_lookup_failed");
  const s = (
    (data ?? []) as {
      meta_social_platform: string;
      meta_social_account_id: string | null;
      meta_social_token_encrypted: string | null;
      meta_social_page_id?: string | null;
    }[]
  )[0];
  if (!s || s.meta_social_platform !== "instagram" || !s.meta_social_account_id || !s.meta_social_token_encrypted)
    return null;
  const token = await decryptWebhookSecret(admin, s.meta_social_token_encrypted);
  if (!token) return null;
  return { contaId: s.meta_social_account_id, paginaId: s.meta_social_page_id ?? null, token };
}

/** Privadas que esta sessão enviou nos últimos 60 minutos, e quando a mais velha sai da janela. */
async function medirAJanela(
  admin: SupabaseClient,
  linha: LinhaDaFila,
  agora: Date,
): Promise<{ enviadas: number; liberaEm: string | null }> {
  const desde = new Date(agora.getTime() - HORA_MS).toISOString();
  const { data, error } = await admin
    .from("meta_social_fila_de_envio")
    .select("enviada_em")
    .eq("organization_id", linha.organization_id)
    .eq("channel_session_id", linha.channel_session_id)
    .eq("tipo", "resposta_privada")
    .eq("status", "enviada")
    .gte("enviada_em", desde)
    .order("enviada_em", { ascending: true })
    .limit(TETO_DE_RESPOSTAS_PRIVADAS_POR_HORA);
  if (error) throw new Error("meta_social_queue_window_failed");
  const linhas = (data ?? []) as { enviada_em: string }[];
  const maisVelha = linhas[0]?.enviada_em;
  return {
    enviadas: linhas.length,
    liberaEm: maisVelha ? new Date(Date.parse(maisVelha) + HORA_MS).toISOString() : null,
  };
}

async function atualizarLinha(admin: SupabaseClient, linha: LinhaDaFila, campos: Record<string, unknown>, agora: Date) {
  const { error } = await admin
    .from("meta_social_fila_de_envio")
    .update({ ...campos, atualizado_em: agora.toISOString() })
    .eq("organization_id", linha.organization_id)
    .eq("id", linha.id);
  if (error) {
    logger.error("[meta-social.fila] linha da fila não atualizada", {
      organization_id: linha.organization_id,
      codigo: error.code,
    });
  }
}

async function atualizarComentario(
  admin: SupabaseClient,
  linha: LinhaDaFila,
  campos: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from("meta_social_comentarios")
    .update(campos)
    .eq("organization_id", linha.organization_id)
    .eq("comment_id", linha.comment_id);
  if (error) {
    logger.warn("[meta-social.fila] estado do comentário não gravado", {
      organization_id: linha.organization_id,
      codigo: error.code,
    });
  }
}

/** Reserva a linha para esta rodada. `false` = outra rodada já a pegou. */
async function reservar(admin: SupabaseClient, linha: LinhaDaFila, agora: Date): Promise<boolean> {
  const { data, error } = await admin
    .from("meta_social_fila_de_envio")
    .update({ status: "enviando", tentativas: linha.tentativas + 1, atualizado_em: agora.toISOString() })
    .eq("organization_id", linha.organization_id)
    .eq("id", linha.id)
    .eq("status", "na_fila")
    .select("id");
  if (error) throw new Error("meta_social_queue_claim_failed");
  return (data ?? []).length === 1;
}

async function destravar(admin: SupabaseClient, agora: Date): Promise<number> {
  const limite = new Date(agora.getTime() - TRAVADA_APOS_MS).toISOString();
  const { data, error } = await admin
    .from("meta_social_fila_de_envio")
    .update({ status: "falhou", erro: "envio_sem_confirmacao", atualizado_em: agora.toISOString() })
    .eq("status", "enviando")
    .lt("atualizado_em", limite)
    .select("id, organization_id, tipo, comment_id");
  if (error) throw new Error("meta_social_queue_unstick_failed");
  const linhas = (data ?? []) as Pick<LinhaDaFila, "id" | "organization_id" | "tipo" | "comment_id">[];
  for (const l of linhas) {
    if (l.tipo !== "resposta_privada") continue;
    await atualizarComentario(admin, l as LinhaDaFila, {
      resposta_privada_status: "falhou",
      resposta_privada_erro: "envio_sem_confirmacao",
    });
  }
  return linhas.length;
}

type Desfecho = "enviada" | "reagendada" | "aguardando" | "expirada" | "falhou" | "pulada";

/**
 * Uma rodada da fila. Lança só se a leitura da fila falhar; o erro de UMA
 * linha não interrompe as outras.
 */
export async function processarFilaMetaSocial(
  admin: SupabaseClient,
  agora: Date = new Date(),
  fetcher?: typeof fetch,
): Promise<ResumoDaFila> {
  const resumo: ResumoDaFila = {
    examinadas: 0,
    enviadas: 0,
    reagendadas: 0,
    aguardando: 0,
    expiradas: 0,
    falharam: 0,
    destravadas: await destravar(admin, agora),
  };

  const { data, error } = await admin
    .from("meta_social_fila_de_envio")
    .select("id, organization_id, channel_session_id, tipo, comment_id, texto, tentativas, criado_em")
    .eq("status", "na_fila")
    .lte("proxima_tentativa_em", agora.toISOString())
    .order("criado_em", { ascending: true })
    .limit(LOTE_DA_FILA);
  if (error) throw new Error("meta_social_queue_read_failed");
  // Privadas antes das públicas: a pública do mesmo comentário, na mesma
  // rodada, já encontra a privada resolvida.
  const linhas = ((data ?? []) as LinhaDaFila[]).sort(
    (a, b) => Number(a.tipo === "resposta_publica") - Number(b.tipo === "resposta_publica"),
  );

  const contextos = new Map<string, ContextoDaSessao>();
  for (const linha of linhas) {
    resumo.examinadas += 1;
    let ctx = contextos.get(linha.channel_session_id);
    if (!ctx) {
      ctx = { credencial: undefined, orcamento: undefined, liberaEm: null, pausa: {} };
      contextos.set(linha.channel_session_id, ctx);
    }
    let d: Desfecho;
    try {
      d = await processarLinha(admin, linha, ctx, agora, fetcher);
    } catch (err) {
      // Erro NOSSO (banco) antes do envio: a linha fica como estava e a
      // próxima rodada tenta de novo.
      logger.error("[meta-social.fila] linha não processada", {
        organization_id: linha.organization_id,
        detalhe: err instanceof Error ? err.message.slice(0, 200) : "erro",
      });
      d = "pulada";
    }
    if (d === "enviada") resumo.enviadas += 1;
    else if (d === "reagendada") resumo.reagendadas += 1;
    else if (d === "aguardando") resumo.aguardando += 1;
    else if (d === "expirada") resumo.expiradas += 1;
    else if (d === "falhou") resumo.falharam += 1;
  }
  return resumo;
}

async function processarLinha(
  admin: SupabaseClient,
  linha: LinhaDaFila,
  ctx: ContextoDaSessao,
  agora: Date,
  fetcher: typeof fetch | undefined,
): Promise<Desfecho> {
  const privada = linha.tipo === "resposta_privada";

  const pausa = ctx.pausa[linha.tipo];
  if (pausa) {
    await atualizarLinha(admin, linha, { proxima_tentativa_em: pausa }, agora);
    return "reagendada";
  }

  if (privada) {
    const { data: cs, error: ec } = await admin
      .from("meta_social_comentarios")
      .select("criado_na_meta_em, recebido_em")
      .eq("organization_id", linha.organization_id)
      .eq("comment_id", linha.comment_id)
      .limit(1);
    if (ec) throw new Error("meta_social_comment_lookup_failed");
    const c = ((cs ?? []) as { criado_na_meta_em: string | null; recebido_em: string }[])[0];
    if (!c || comentarioVencido(c, agora)) {
      await atualizarLinha(admin, linha, { status: "expirada", erro: c ? "prazo_de_7_dias" : "comentario_desconhecido" }, agora);
      if (c) await atualizarComentario(admin, linha, { resposta_privada_status: "expirada" });
      return "expirada";
    }
    if (ctx.orcamento === undefined) {
      const janela = await medirAJanela(admin, linha, agora);
      ctx.orcamento = TETO_DE_RESPOSTAS_PRIVADAS_POR_HORA - janela.enviadas;
      ctx.liberaEm = janela.liberaEm;
    }
    if (ctx.orcamento <= 0) {
      const ate = ctx.liberaEm ?? new Date(agora.getTime() + MINUTO_MS).toISOString();
      ctx.pausa.resposta_privada = ate;
      await atualizarLinha(admin, linha, { proxima_tentativa_em: ate }, agora);
      return "reagendada";
    }
  } else {
    // A pública espera a privada do mesmo comentário sair (ou falhar, ou expirar).
    const { data: ps, error: ep } = await admin
      .from("meta_social_fila_de_envio")
      .select("status, proxima_tentativa_em")
      .eq("organization_id", linha.organization_id)
      .eq("tipo", "resposta_privada")
      .eq("comment_id", linha.comment_id)
      .limit(1);
    if (ep) throw new Error("meta_social_queue_order_failed");
    const p = ((ps ?? []) as { status: string; proxima_tentativa_em: string }[])[0];
    if (p && (p.status === "na_fila" || p.status === "enviando")) {
      const umMinuto = agora.getTime() + MINUTO_MS;
      const ate = new Date(Math.max(umMinuto, Date.parse(p.proxima_tentativa_em) || 0)).toISOString();
      await atualizarLinha(admin, linha, { proxima_tentativa_em: ate }, agora);
      return "aguardando";
    }
  }

  if (ctx.credencial === undefined) {
    ctx.credencial = await credencialDaSessao(admin, linha.organization_id, linha.channel_session_id);
  }
  const cred = ctx.credencial;
  if (!cred) {
    await atualizarLinha(admin, linha, { status: "falhou", erro: "conta_indisponivel" }, agora);
    if (privada)
      await atualizarComentario(admin, linha, { resposta_privada_status: "falhou", resposta_privada_erro: "conta_indisponivel" });
    return "falhou";
  }

  if (!(await reservar(admin, linha, agora))) return "pulada";
  const tentativas = linha.tentativas + 1;

  const req = privada
    ? requisicaoDaRespostaPrivada({ contaId: cred.contaId, paginaId: cred.paginaId, commentId: linha.comment_id, texto: linha.texto })
    : requisicaoDaRespostaPublica(linha.comment_id, linha.texto);

  let resposta: Record<string, unknown>;
  try {
    resposta = await chamarMeta(
      privada ? "resposta_privada" : "resposta_publica",
      req.url,
      { token: cred.token, ...(req.json ? { json: req.json } : { form: req.form }) },
      fetcher,
    );
  } catch (err) {
    if (!(err instanceof ErroDaMeta)) throw err;
    return tratarErroDaMeta(admin, linha, ctx, err, tentativas, agora);
  }

  // Saiu. Daqui em diante, nada reenvia: falha de gravação deixa a linha
  // `enviando`, e a rodada seguinte a destrava como falha sem confirmação.
  const idDaMeta =
    typeof resposta.message_id === "string"
      ? resposta.message_id
      : typeof resposta.id === "string"
        ? resposta.id
        : null;
  const quando = agora.toISOString();
  await atualizarLinha(admin, linha, { status: "enviada", enviada_em: quando, resultado_id: idDaMeta, erro: null }, agora);
  if (privada) {
    ctx.orcamento = (ctx.orcamento ?? 1) - 1;
    ctx.liberaEm ??= new Date(agora.getTime() + HORA_MS).toISOString();
    await atualizarComentario(admin, linha, {
      resposta_privada_status: "enviada",
      resposta_privada_mid: idDaMeta,
      resposta_privada_em: quando,
      resposta_privada_erro: null,
    });
    // O eco desta DM chega pelo webhook do Direct: registrado como envio
    // nosso, ele não vira mensagem "respondida pelo celular" (que pausaria a IA).
    if (idDaMeta) {
      await registrarEnvio(admin, {
        organizationId: linha.organization_id,
        channelSessionId: linha.channel_session_id,
        mid: idDaMeta,
      });
    }
  } else {
    await atualizarComentario(admin, linha, { resposta_publica_id: idDaMeta, resposta_publica_em: quando });
  }
  return "enviada";
}

async function tratarErroDaMeta(
  admin: SupabaseClient,
  linha: LinhaDaFila,
  ctx: ContextoDaSessao,
  err: ErroDaMeta,
  tentativas: number,
  agora: Date,
): Promise<Desfecho> {
  const privada = linha.tipo === "resposta_privada";
  const voltarParaAFila = async (esperaMs: number, erro: string) => {
    const ate = new Date(agora.getTime() + esperaMs).toISOString();
    await atualizarLinha(admin, linha, { status: "na_fila", proxima_tentativa_em: ate, erro }, agora);
    return ate;
  };

  if (ehErroDeLimite(err)) {
    ctx.pausa[linha.tipo] = await voltarParaAFila(esperaCrescente(tentativas), `limite_da_meta:${err.codigoDaMeta ?? err.status}`);
    return "reagendada";
  }
  if (privada && err.codigoDaMeta === CODIGO_COMENTARIO_INELEGIVEL) {
    await atualizarLinha(admin, linha, { status: "expirada", erro: `inelegivel:${CODIGO_COMENTARIO_INELEGIVEL}` }, agora);
    await atualizarComentario(admin, linha, { resposta_privada_status: "expirada" });
    return "expirada";
  }
  const codigo = codigoDaFalhaDeEnvio(err, "instagram");
  if (codigo === "meta_social_token_invalid") {
    await marcarTokenInvalido(admin, linha.organization_id, linha.channel_session_id);
    const ate = await voltarParaAFila(ESPERA_DO_TOKEN_MS, codigo);
    ctx.pausa.resposta_privada = ate;
    ctx.pausa.resposta_publica = ate;
    return "reagendada";
  }
  if (err.status === null && tentativas < MAX_TENTATIVAS_DE_REDE) {
    await voltarParaAFila(esperaCrescente(tentativas), "rede");
    return "reagendada";
  }
  const erro = `${codigo}:${err.codigoDaMeta ?? err.status ?? "rede"}`;
  await atualizarLinha(admin, linha, { status: "falhou", erro }, agora);
  if (privada) await atualizarComentario(admin, linha, { resposta_privada_status: "falhou", resposta_privada_erro: erro });
  return "falhou";
}
