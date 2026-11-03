/**
 * PONTO DE TROCA entre as automações e o canal de COMENTÁRIOS do Instagram.
 *
 * O resto das automações (gatilho `instagram_comment`, blocos "Responder em
 * privado", "Responder no comentário" e "Confere se segue") importa SÓ daqui.
 * O canal mora em `lib/channels/meta-social/comentarios.ts`; este arquivo só
 * o reexporta (contrato em `docs/specs/instagram-comentarios-contrato.md`).
 *
 * `identidadeDoComentarista` NÃO é do contrato do canal: é a ponte para achar o
 * contato do comentarista pela identidade social que a ingestão do Direct já
 * grava em `contacts.social_identity` (`<rede>:<conta>:<cliente>`, ver
 * `identidadeSocial` em `lib/channels/meta-social/ingest.ts`). Mora aqui para
 * que nenhuma feature leia coluna do canal por conta própria.
 */
import type { SupabaseClient } from "@supabase/supabase-js";


// ---------------------------------------------------------------------------
// O canal (lib/channels/meta-social): contrato em docs/specs/instagram-comentarios-contrato.md
// ---------------------------------------------------------------------------

export { pedirRespostaPrivada, responderNoComentario, conferirSeSegue, ERRO_TEXTO_INVALIDO } from "@/lib/channels/meta-social/comentarios";
export type { StatusDoPedido, PedidoDeResposta, OpcoesDaAcao } from "@/lib/channels/meta-social/comentarios";
export { EVENTO_COMENTARIO_RECEBIDO, ENTIDADE_DO_EVENTO_COMENTARIO, TETO_DO_TEXTO_DA_RESPOSTA_BYTES } from "@/lib/channels/meta-social/comentarios-contrato";
export type { EventoComentarioRecebido } from "@/lib/channels/meta-social/comentarios-contrato";

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
  const linha = data as {
    meta_social_platform: string | null;
    meta_social_account_id: string | null;
  } | null;
  if (!linha || linha.meta_social_platform !== "instagram" || !linha.meta_social_account_id)
    return null;
  // Import tardio: a ingestão do canal puxa a cadeia inteira de entrada social,
  // que só interessa quando há mesmo um comentário para resolver.
  const { identidadeSocial } = await import("@/lib/channels/meta-social/ingest");
  return {
    identidade: identidadeSocial("instagram", linha.meta_social_account_id, input.autorId),
    propriaConta: input.autorId === linha.meta_social_account_id,
  };
}
