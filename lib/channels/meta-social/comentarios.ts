/**
 * Comentários do Instagram pelo canal social oficial (migration 0991):
 * leitura do webhook, gravação com o evento, e as três ações que a automação
 * usa (resposta privada, resposta pública, conferir se segue).
 *
 * O canal só oferece as peças. Palavra-chave, exigir que siga, esperar a
 * resposta da pessoa, criar contato ou negócio: tudo isso é da automação.
 * Contrato: docs/specs/instagram-comentarios-contrato.md.
 *
 * A organização NUNCA vem do corpo de nada: no webhook, sai da sessão achada
 * pela conta do `entry.id` assinado; nas ações, é o parâmetro que quem chama
 * resolveu de fonte confiável (sessão, token, execução da automação), e toda
 * consulta filtra por ela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { CHANNEL_PROVIDER_META_SOCIAL } from "../capabilities";
import {
  PRAZO_DA_RESPOSTA_PRIVADA_MS,
  TETO_DO_TEXTO_DA_RESPOSTA_BYTES,
  type TipoDaFilaDeEnvio,
} from "./comentarios-contrato";
import { HOST_GRAPH_FACEBOOK, VERSAO_DA_GRAPH_SOCIAL } from "./constantes";
import type { SessaoMetaSocial } from "./ingest";
import { chamarMeta } from "./oauth";
import type { EnvelopeMetaSocial } from "./webhook";

const GRAPH = `${HOST_GRAPH_FACEBOOK}/${VERSAO_DA_GRAPH_SOCIAL}`;

// ─── Leitura do webhook (pura) ─────────────────────────────────────────────

export interface ComentarioDoWebhook {
  /** `entry.id`: a NOSSA conta do Instagram. */
  contaId: string;
  commentId: string;
  texto: string | null;
  autorId: string;
  autorUsuario: string | null;
  mediaId: string | null;
  mediaProductType: string | null;
  /** `entry.time` (hora do aviso); a doc não traz a hora do comentário no webhook. */
  criadoNaMetaEm: string | null;
}

const idDaMeta = z.union([z.string().min(1), z.number()]).transform(String);
const valorDoComentario = z
  .object({
    // Login unificado / Facebook Login: `comment_id`. Login do Instagram: `id`.
    // https://developers.facebook.com/docs/instagram-platform/webhooks/examples
    comment_id: idDaMeta.optional(),
    id: idDaMeta.optional(),
    text: z.string().optional(),
    parent_id: idDaMeta.optional(),
    from: z.object({ id: idDaMeta, username: z.string().optional() }).loose().optional(),
    media: z
      .object({ id: idDaMeta.optional(), media_product_type: z.string().optional() })
      .loose()
      .optional(),
  })
  .loose();

function dataDoEntryTime(t: unknown): string | null {
  const n = typeof t === "number" ? t : Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  // A doc mostra `entry.time` em segundos e em milissegundos conforme o exemplo.
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

/**
 * Os comentários NOVOS de primeiro nível de um envelope do Instagram.
 * Ignorados, sem virar erro (a Meta reentrega o que não recebe 2xx):
 *  - objeto que não é `instagram` (comentário de Página do Facebook é outro campo);
 *  - `live_comments` (a resposta privada só vale durante a transmissão);
 *  - comentário da própria conta (`from.id` = `entry.id`): é a nossa resposta pública;
 *  - resposta a comentário (`parent_id`): a resposta pública só vai ao primeiro nível,
 *    e responder a conversa entre pessoas leria como spam. Decisão do canal; a doc
 *    da resposta privada não fala de comentário aninhado.
 */
export function lerComentariosMetaSocial(envelope: EnvelopeMetaSocial): ComentarioDoWebhook[] {
  if (envelope.object !== "instagram") return [];
  const out: ComentarioDoWebhook[] = [];
  for (const entry of envelope.entry) {
    const contaId = entry.id;
    if (!contaId) continue;
    const e = entry as { field?: unknown; value?: unknown; time?: unknown; changes?: unknown[] };
    // Dois formatos: `changes[]` (login unificado) e `field`/`value` direto na
    // entrada (o exemplo do login do Instagram na doc).
    const valores: unknown[] = [
      ...(e.changes ?? []).flatMap((c) => {
        const o = c as { field?: unknown; value?: unknown };
        return o && o.field === "comments" && o.value ? [o.value] : [];
      }),
      ...(e.field === "comments" && e.value ? [e.value] : []),
    ];
    for (const bruto of valores) {
      const lido = valorDoComentario.safeParse(bruto);
      if (!lido.success) continue;
      const v = lido.data;
      const commentId = v.comment_id ?? v.id;
      const autorId = v.from?.id;
      if (!commentId || !autorId) continue;
      if (autorId === contaId) continue;
      if (v.parent_id) continue;
      out.push({
        contaId,
        commentId,
        texto: v.text ?? null,
        autorId,
        autorUsuario: v.from?.username ?? null,
        mediaId: v.media?.id ?? null,
        mediaProductType: v.media?.media_product_type ?? null,
        criadoNaMetaEm: dataDoEntryTime(e.time),
      });
    }
  }
  return out;
}

// ─── Gravação + evento ─────────────────────────────────────────────────────

export interface DesfechoDoComentario {
  status: "ingested" | "duplicate";
  reason: "comentario";
}

/**
 * Grava o comentário e emite `instagram.comentario_recebido`, numa transação só
 * (`fn_meta_social_registrar_comentario`). Repetido (a Meta reentrega) volta
 * `duplicate` sem evento novo. Falha do banco LANÇA: a rota devolve 500 e a
 * reentrega da Meta refaz.
 */
export async function ingerirComentario(
  admin: SupabaseClient,
  sessao: SessaoMetaSocial,
  c: ComentarioDoWebhook,
): Promise<DesfechoDoComentario> {
  const { data, error } = await admin.rpc("fn_meta_social_registrar_comentario", {
    p_organization_id: sessao.organizationId,
    p_channel_session_id: sessao.id,
    p_comment_id: c.commentId,
    p_media_id: c.mediaId,
    p_media_product_type: c.mediaProductType,
    p_autor_id: c.autorId,
    p_autor_usuario: c.autorUsuario,
    p_texto: c.texto,
    p_criado_na_meta_em: c.criadoNaMetaEm,
  });
  if (error) throw new Error("meta_social_comment_insert_failed");
  return { status: data ? "ingested" : "duplicate", reason: "comentario" };
}

// ─── As ações ──────────────────────────────────────────────────────────────

export type StatusDoPedido = "na_fila" | "ja_pedida" | "expirada" | "nao_encontrado";

/** Texto vazio ou acima de `TETO_DO_TEXTO_DA_RESPOSTA_BYTES`: as ações LANÇAM com esta mensagem. */
export const ERRO_TEXTO_INVALIDO = "meta_social_texto_invalido";

export interface PedidoDeResposta {
  /** Resolvida de fonte confiável por quem chama; nunca de corpo de requisição. */
  organizationId: string;
  commentId: string;
  texto: string;
  /** Origem do pedido, livre (ex.: id da execução da automação). */
  pedidoPor?: string | null;
}

/** Para teste. */
export interface OpcoesDaAcao {
  agora?: Date;
  fetcher?: typeof fetch;
}

interface LinhaDoComentario {
  id: string;
  channel_session_id: string;
  criado_na_meta_em: string | null;
  recebido_em: string;
  resposta_privada_status: string;
}

/** A hora que conta para o prazo de 7 dias: a da Meta, ou a da chegada. */
export function horaDoComentario(c: Pick<LinhaDoComentario, "criado_na_meta_em" | "recebido_em">): number {
  return Date.parse(c.criado_na_meta_em ?? c.recebido_em);
}

export function comentarioVencido(
  c: Pick<LinhaDoComentario, "criado_na_meta_em" | "recebido_em">,
  agora: Date,
): boolean {
  const t = horaDoComentario(c);
  return !Number.isFinite(t) || agora.getTime() - t >= PRAZO_DA_RESPOSTA_PRIVADA_MS;
}

function textoValido(texto: unknown): string | null {
  if (typeof texto !== "string") return null;
  const t = texto.trim();
  if (!t || Buffer.byteLength(t, "utf8") > TETO_DO_TEXTO_DA_RESPOSTA_BYTES) return null;
  return t;
}

async function comentarioDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
  commentId: string,
): Promise<LinhaDoComentario | null> {
  const { data, error } = await admin
    .from("meta_social_comentarios")
    .select("id, channel_session_id, criado_na_meta_em, recebido_em, resposta_privada_status")
    .eq("organization_id", organizationId)
    .eq("comment_id", commentId)
    .limit(1);
  if (error) throw new Error("meta_social_comment_lookup_failed");
  return ((data ?? []) as LinhaDoComentario[])[0] ?? null;
}

async function enfileirar(
  admin: SupabaseClient,
  organizationId: string,
  comentario: LinhaDoComentario,
  tipo: TipoDaFilaDeEnvio,
  commentId: string,
  texto: string,
  pedidoPor: string | null | undefined,
): Promise<"na_fila" | "ja_pedida"> {
  const { error } = await admin.from("meta_social_fila_de_envio").insert({
    organization_id: organizationId,
    channel_session_id: comentario.channel_session_id,
    tipo,
    comment_id: commentId,
    texto,
    pedido_por: pedidoPor ? String(pedidoPor).slice(0, 200) : null,
  });
  if (error?.code === "23505") return "ja_pedida";
  if (error) throw new Error("meta_social_queue_insert_failed");
  return "na_fila";
}

/**
 * Pede a resposta privada (Direct) a um comentário. Uma por comentário, em até
 * 7 dias. Vai para a fila; o cron `meta-social-fila` envia no ritmo da conta.
 */
export async function pedirRespostaPrivada(
  admin: SupabaseClient,
  pedido: PedidoDeResposta,
  opcoes: OpcoesDaAcao = {},
): Promise<{ status: StatusDoPedido }> {
  const agora = opcoes.agora ?? new Date();
  const texto = textoValido(pedido.texto);
  if (!texto) throw new Error(ERRO_TEXTO_INVALIDO);
  const c = await comentarioDaOrganizacao(admin, pedido.organizationId, pedido.commentId);
  if (!c) return { status: "nao_encontrado" };
  if (c.resposta_privada_status === "expirada") return { status: "expirada" };
  if (c.resposta_privada_status !== "nao_pedida") return { status: "ja_pedida" };
  if (comentarioVencido(c, agora)) {
    await admin
      .from("meta_social_comentarios")
      .update({ resposta_privada_status: "expirada" })
      .eq("organization_id", pedido.organizationId)
      .eq("id", c.id)
      .eq("resposta_privada_status", "nao_pedida");
    return { status: "expirada" };
  }
  const r = await enfileirar(admin, pedido.organizationId, c, "resposta_privada", pedido.commentId, texto, pedido.pedidoPor);
  if (r === "na_fila") {
    const { error } = await admin
      .from("meta_social_comentarios")
      .update({ resposta_privada_status: "na_fila" })
      .eq("organization_id", pedido.organizationId)
      .eq("id", c.id)
      .eq("resposta_privada_status", "nao_pedida");
    // A fila é a fonte do envio; o estado do comentário é espelho e o cron o
    // regrava ao enviar. Falhar aqui não desfaz o pedido.
    if (error) logger.warn("[meta-social.comentarios] estado do comentário não gravado", { codigo: error.code });
  }
  return { status: r };
}

/**
 * Pede a resposta PÚBLICA no comentário. Também pela fila: o cron só a envia
 * depois que a resposta privada do mesmo comentário saiu, falhou ou expirou
 * (responder em público antes deixa o comentário inelegível para a privada).
 * Sem privada pedida, envia na próxima rodada.
 */
export async function responderNoComentario(
  admin: SupabaseClient,
  pedido: PedidoDeResposta,
): Promise<{ status: Exclude<StatusDoPedido, "expirada"> }> {
  const texto = textoValido(pedido.texto);
  if (!texto) throw new Error(ERRO_TEXTO_INVALIDO);
  const c = await comentarioDaOrganizacao(admin, pedido.organizationId, pedido.commentId);
  if (!c) return { status: "nao_encontrado" };
  return {
    status: await enfileirar(admin, pedido.organizationId, c, "resposta_publica", pedido.commentId, texto, pedido.pedidoPor),
  };
}

const IGSID = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * A pessoa segue a conta? Chamada direta à Meta, sem fila (não é resposta
 * privada, não conta no teto de 750/h).
 * GET /<IGSID>?fields=is_user_follow_business com o token da conta.
 * https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/user-profile
 *
 * `null` = não deu para saber: sessão de outra organização ou sem token, ou a
 * Meta recusou. A doc diz que o perfil só é liberado DEPOIS que a pessoa manda
 * mensagem à conta (ou toca num ice breaker); quem só comentou devolve erro
 * ("User consent is required"). A automação decide o que fazer com `null`.
 */
export async function conferirSeSegue(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; autorId: string },
  opcoes: OpcoesDaAcao = {},
): Promise<{ segue: boolean | null }> {
  if (!IGSID.test(input.autorId)) return { segue: null };
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, meta_social_platform, meta_social_token_encrypted")
    .eq("organization_id", input.organizationId)
    .eq("id", input.channelSessionId)
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .is("archived_at", null)
    .limit(1);
  if (error) return { segue: null };
  const s = ((data ?? []) as { meta_social_platform: string; meta_social_token_encrypted: string | null }[])[0];
  if (!s || s.meta_social_platform !== "instagram" || !s.meta_social_token_encrypted) return { segue: null };
  const token = await decryptWebhookSecret(admin, s.meta_social_token_encrypted);
  if (!token) return { segue: null };
  try {
    const r = await chamarMeta(
      "instagram_segue",
      `${GRAPH}/${encodeURIComponent(input.autorId)}?fields=is_user_follow_business`,
      { token },
      opcoes.fetcher,
    );
    return { segue: typeof r.is_user_follow_business === "boolean" ? r.is_user_follow_business : null };
  } catch {
    return { segue: null };
  }
}
