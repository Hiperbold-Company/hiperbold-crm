/**
 * As duas colunas de AUTORIA do `api_audit_log` para um `Actor` de handler.
 *
 * Pessoa → `actor_user_id`. Token de servidor (integração) → `actor_api_token_id`
 * e NUNCA `actor_user_id`: o id do token não é de ninguém em `auth.users` (a FK
 * recusaria a linha). Agente de IA com chave → o `api_token_id` da chave, quando
 * o runtime o conhece.
 *
 * Existe para que toda rota que aceita Bearer assine o audit com o token pela
 * COLUNA — a consulta "o que esta chave fez?" é um `where actor_api_token_id = …`,
 * e quem só gravou no `metadata` não aparece nela.
 */
import type { Actor } from "@/lib/api/handlers/types";

export function colunasDeAtorNoAudit(actor: Actor): {
  actorUserId: string | null;
  actorApiTokenId: string | null;
} {
  if (actor.type === "user") return { actorUserId: actor.id, actorApiTokenId: null };
  if (actor.type === "api_token") return { actorUserId: null, actorApiTokenId: actor.id };
  if (actor.type === "ai_agent") {
    return { actorUserId: null, actorApiTokenId: actor.api_token_id ?? null };
  }
  return { actorUserId: null, actorApiTokenId: null };
}
