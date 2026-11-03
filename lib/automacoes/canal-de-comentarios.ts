/**
 * PONTO DE TROCA entre as automações e o canal de COMENTÁRIOS do Instagram.
 *
 * O resto das automações (gatilho `instagram_comment`, blocos "Responder em
 * privado", "Responder no comentário" e "Confere se segue") importa SÓ daqui.
 * O canal mora em `lib/channels/` e está sendo construído por outro trabalho;
 * enquanto `lib/channels/meta-social/comentarios.ts` não existe, as três
 * funções do contrato abaixo são um STUB com as assinaturas exatas: devolvem
 * "nao_encontrado" / `null` e registram no logger que o canal ainda não está
 * ligado. Os blocos saem por "Erro" / "Não deu para saber" — nunca fingem envio.
 *
 * TROCAR pelo import de @/lib/channels/meta-social/comentarios quando existir:
 *
 *   export { pedirRespostaPrivada, responderNoComentario, conferirSeSegue, ERRO_TEXTO_INVALIDO } from "@/lib/channels/meta-social/comentarios";
 *   export type { StatusDoPedido, PedidoDeResposta, OpcoesDaAcao } from "@/lib/channels/meta-social/comentarios";
 *   export { EVENTO_COMENTARIO_RECEBIDO, ENTIDADE_DO_EVENTO_COMENTARIO, TETO_DO_TEXTO_DA_RESPOSTA_BYTES } from "@/lib/channels/meta-social/comentarios-contrato";
 *   export type { EventoComentarioRecebido } from "@/lib/channels/meta-social/comentarios-contrato";
 *
 * e apagar o stub. Nada mais muda: os nomes e os tipos são os do contrato
 * (branch do canal, `docs/specs/instagram-comentarios-contrato.md`).
 *
 * `identidadeDoComentarista` NÃO é do contrato do canal: é a ponte para achar o
 * contato do comentarista pela identidade social que a ingestão do Direct já
 * grava em `contacts.social_identity` (`<rede>:<conta>:<cliente>`, ver
 * `identidadeSocial` em `lib/channels/meta-social/ingest.ts`). Mora aqui para
 * que nenhuma feature leia coluna do canal por conta própria.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// STUB — TROCAR pelo import de @/lib/channels/meta-social/comentarios quando existir
// (nomes e tipos copiados do contrato: comentarios.ts e comentarios-contrato.ts)
// ---------------------------------------------------------------------------

/** O tipo do evento emitido no `event_log` a cada comentário novo. */
export const EVENTO_COMENTARIO_RECEBIDO = "instagram.comentario_recebido";
/** `event_log.entity_kind` desse evento; `entity_id` = `meta_social_comentarios.id`. */
export const ENTIDADE_DO_EVENTO_COMENTARIO = "instagram_comment";
/** Teto do texto de uma resposta, em bytes UTF-8 (o mesmo do Direct do Instagram). */
export const TETO_DO_TEXTO_DA_RESPOSTA_BYTES = 1000;

/** O payload do evento (snake_case, datas em ISO-8601). */
export interface EventoComentarioRecebido {
  organization_id: string;
  channel_session_id: string;
  comment_id: string;
  media_id: string | null;
  media_product_type: string | null;
  /** IGSID de quem comentou. */
  autor_id: string;
  autor_usuario: string | null;
  texto: string | null;
  criado_na_meta_em: string | null;
}

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

function avisarCanalDesligado(funcao: string, organizationId: string): void {
  logger.warn("automacao: canal de comentários do Instagram ainda não está ligado", {
    funcao,
    organization_id: organizationId,
  });
}

export async function pedirRespostaPrivada(
  _admin: SupabaseClient,
  pedido: PedidoDeResposta,
  _opcoes: OpcoesDaAcao = {},
): Promise<{ status: StatusDoPedido }> {
  avisarCanalDesligado("pedirRespostaPrivada", pedido.organizationId);
  return { status: "nao_encontrado" };
}

export async function responderNoComentario(
  _admin: SupabaseClient,
  pedido: PedidoDeResposta,
): Promise<{ status: Exclude<StatusDoPedido, "expirada"> }> {
  avisarCanalDesligado("responderNoComentario", pedido.organizationId);
  return { status: "nao_encontrado" };
}

export async function conferirSeSegue(
  _admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; autorId: string },
  _opcoes: OpcoesDaAcao = {},
): Promise<{ segue: boolean | null }> {
  avisarCanalDesligado("conferirSeSegue", input.organizationId);
  return { segue: null };
}

// ---------------------------------------------------------------------------
// Identidade do comentarista (não é stub: lê o que o canal já grava)
// ---------------------------------------------------------------------------

export interface IdentidadeDoComentarista {
  /** O valor de `contacts.social_identity` que a ingestão do Direct daria a este perfil. */
  identidade: string;
  /** O comentário é da PRÓPRIA conta conectada (resposta nossa, publicação do dono). */
  propriaConta: boolean;
}

/**
 * A identidade social do autor de um comentário, pela sessão de canal — lida
 * na linha da sessão FILTRADA pela organização (service role ignora RLS).
 * `null` quando a sessão não é desta organização, está arquivada ou não é
 * uma conta do Instagram.
 */
export async function identidadeDoComentarista(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; autorId: string },
): Promise<IdentidadeDoComentarista | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("meta_social_platform, meta_social_account_id")
    .eq("organization_id", input.organizationId)
    .eq("id", input.channelSessionId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error("sessao_do_comentario_indeterminada");
  const linha = data as { meta_social_platform: string | null; meta_social_account_id: string | null } | null;
  if (!linha || linha.meta_social_platform !== "instagram" || !linha.meta_social_account_id) return null;
  // Import tardio: a ingestão do canal puxa a cadeia inteira de entrada social,
  // que só interessa quando há mesmo um comentário para resolver.
  const { identidadeSocial } = await import("@/lib/channels/meta-social/ingest");
  return {
    identidade: identidadeSocial("instagram", linha.meta_social_account_id, input.autorId),
    propriaConta: input.autorId === linha.meta_social_account_id,
  };
}
