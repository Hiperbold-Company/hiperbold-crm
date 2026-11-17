/**
 * QUEM AGENDOU AINDA PODE MANDAR ESTA MENSAGEM? — a revalidação do worker na
 * hora do envio (auditoria de 17/11/2026).
 *
 * A rota de criação confere tudo isto com a SESSÃO de quem agenda
 * (`exigirPermissao("chat.responder")` e a RLS de `conversations`). O worker
 * roda dias depois, com o cliente de serviço, que não passa pela RLS: sem
 * repetir as duas perguntas aqui, a mensagem sairia em nome de quem perdeu a
 * permissão de responder ou deixou de enxergar a conversa (transferida a um
 * colega num modo "só os meus", por exemplo).
 *
 * As duas réguas são as de sempre, não uma terceira:
 *
 *   - PERMISSÃO: `papelPode(papel, "chat.responder", permissões da organização)`,
 *     o mesmo resolvedor do portão de rota (`lib/permissoes`);
 *   - VISIBILIDADE: o espelho da policy `conversations_select` (baseline, via
 *     `fn_conversation_scope`): viewer/manager/admin ou modo `all` veem a
 *     organização inteira; quem tem a conversa atribuída a vê; a sem dono, no
 *     modo `own_and_unassigned`; e o participante ativo, se o contato não é
 *     pessoal. Modo gravado desconhecido restringe ao próprio (`own`), como lá.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Role, VisibilityMode } from "@/lib/auth/types";
import { modoDeVisibilidade } from "@/lib/notifications/push-de-venda";
import { papelPode, resolverPermissoes } from "@/lib/permissoes/resolver";

export interface EntradaDaVisibilidade {
  papel: string;
  modo: VisibilityMode;
  autorId: string;
  atribuidaA: string | null;
  participanteAtivo: boolean;
  contatoPessoal: boolean;
}

/** A régua de `conversations_select`, para quem agendou. Pura. */
export function autorEnxergaAConversa(e: EntradaDaVisibilidade): boolean {
  if (e.papel === "viewer" || e.papel === "manager" || e.papel === "admin") return true;
  if (e.modo === "all") return true;
  if (e.atribuidaA !== null && e.atribuidaA === e.autorId) return true;
  if (e.atribuidaA === null && e.modo === "own_and_unassigned") return true;
  return e.participanteAtivo && !e.contatoPessoal;
}

export type RevalidacaoDoAutor = { ok: true } | { ok: false; motivo: "sem_permissao" | "sem_visibilidade" };

/**
 * Permissão e visibilidade de `autorId` NESTA conversa, agora. Erro de leitura
 * lança: o worker devolve a linha à fila em vez de decidir no escuro.
 */
export async function revalidarAutor(
  admin: SupabaseClient,
  entrada: {
    organizationId: string;
    autorId: string;
    papel: string;
    conversationId: string;
    atribuidaA: string | null;
    contatoPessoal: boolean;
  },
): Promise<RevalidacaoDoAutor> {
  const { data: org, error: erroOrg } = await admin
    .from("organizations")
    .select("id, settings")
    .eq("id", entrada.organizationId)
    .maybeSingle();
  if (erroOrg) throw new Error(`organizacao: ${erroOrg.message}`);
  const settings = ((org as { settings?: unknown } | null)?.settings ?? null) as
    | { permissoes?: unknown; visibility_mode?: unknown }
    | null;

  if (!papelPode(entrada.papel as Role, "chat.responder", resolverPermissoes(settings?.permissoes))) {
    return { ok: false, motivo: "sem_permissao" };
  }

  const modo = modoDeVisibilidade(settings);
  const base = {
    papel: entrada.papel,
    modo,
    autorId: entrada.autorId,
    atribuidaA: entrada.atribuidaA,
    contatoPessoal: entrada.contatoPessoal,
  };
  if (autorEnxergaAConversa({ ...base, participanteAtivo: false })) return { ok: true };

  // Só lê a participação quando ela decide.
  const { data: participacao, error: erroPart } = await admin
    .from("conversation_participants")
    .select("user_id")
    .eq("organization_id", entrada.organizationId)
    .eq("conversation_id", entrada.conversationId)
    .eq("user_id", entrada.autorId)
    .is("left_at", null)
    .limit(1);
  if (erroPart) throw new Error(`participantes: ${erroPart.message}`);
  const participanteAtivo = ((participacao ?? []) as unknown[]).length > 0;
  return autorEnxergaAConversa({ ...base, participanteAtivo }) ? { ok: true } : { ok: false, motivo: "sem_visibilidade" };
}
