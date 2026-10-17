/**
 * ADMINISTRAR as respostas prontas (`message_templates`) — listar, criar, editar, apagar.
 *
 * Quem chama: as rotas `/api/v1/message-templates/**` (sessão OU token `dsk_…`) e as tools MCP de
 * administração (`lib/mcp/tools/administracao-fase3.ts`). A tela usa as mesmas rotas. A regra é uma só.
 *
 * ⚠️ DUAS PORTAS, DUAS RÉGUAS, UM SÓ RESULTADO:
 *  - **Sessão**: o cliente é o do usuário e a RLS (`message_templates_select/write`, migration 0060)
 *    decide — compartilhada de qualquer um, pessoal só do dono, escrever compartilhada só `manager`+.
 *    Os filtros daqui repetem a régua de propósito (defesa em profundidade) e nunca a afrouxam.
 *  - **Token**: o cliente é service role e BYPASSA a RLS. Uma chave de integração não é uma pessoa:
 *    não tem resposta pessoal. Por isso ela só LÊ, CRIA, EDITA e APAGA as COMPARTILHADAS
 *    (`owner_user_id is null`) — o `is null` é explícito em todo SELECT/UPDATE/DELETE, senão a chave
 *    leria e apagaria o rascunho pessoal de cada atendente da mesma empresa.
 *
 * ⚠️ `organization_id` é SEMPRE o que a porta resolveu (sessão/linha do token), nunca do corpo.
 * ⚠️ `created_by_user_id` tem FK em `auth.users`: quem chama passa a PESSOA (usuário da sessão ou
 * dono da chave), nunca o id do token.
 */
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { roleAtLeast } from "@/lib/auth/types";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";
import type { CreateTemplateInput, UpdateTemplateInput } from "@/lib/schemas/templates";

export const COLUNAS_DA_RESPOSTA_PRONTA =
  "id, organization_id, owner_user_id, title, body, shortcut, created_by_user_id, created_at, updated_at";

function recusa(deps: DepsDaOperacao, status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, undefined, deps.requestId, message);
}

/** A pessoa, quando quem age é uma. Token e agente não têm resposta pessoal. */
function pessoa(deps: DepsDaOperacao): string | null {
  return deps.actor.type === "user" ? deps.actor.id : null;
}

export async function listarRespostasProntas(deps: DepsDaOperacao): Promise<unknown[]> {
  const dono = pessoa(deps);
  const base = deps.supabase
    .from("message_templates")
    .select(COLUNAS_DA_RESPOSTA_PRONTA)
    .eq("organization_id", deps.organizationId);
  const visiveis = dono === null ? base.is("owner_user_id", null) : base.or(`owner_user_id.is.null,owner_user_id.eq.${dono}`);
  const { data, error } = await visiveis.order("updated_at", { ascending: false });
  if (error) throw recusa(deps, 500, "internal_error", "Erro ao listar templates.");
  return data ?? [];
}

export async function criarRespostaPronta(
  deps: DepsDaOperacao,
  entrada: CreateTemplateInput,
  responsavel: string | null,
): Promise<{ id: string } & Record<string, unknown>> {
  const { title, body, shortcut, shared } = entrada;
  const dono = pessoa(deps);

  if (dono === null && !shared) {
    throw recusa(
      deps,
      422,
      "unprocessable_entity",
      "Uma chave de API não tem resposta pessoal: envie shared=true para criar uma resposta compartilhada.",
    );
  }
  if (shared && !roleAtLeast("role" in deps.actor ? deps.actor.role : undefined, "manager")) {
    throw recusa(deps, 403, "forbidden", "Só manager+ cria template compartilhado.");
  }

  const { data, error } = await deps.supabase
    .from("message_templates")
    .insert({
      organization_id: deps.organizationId,
      owner_user_id: shared ? null : dono,
      title,
      body,
      shortcut: shortcut ?? null,
      created_by_user_id: responsavel,
    })
    .select(COLUNAS_DA_RESPOSTA_PRONTA)
    .single();
  if (error || !data) throw recusa(deps, 500, "internal_error", "Erro ao criar template.");

  const linha = data as unknown as { id: string } & Record<string, unknown>;
  void audit({
    action: "template.created",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "message_template",
    resourceId: linha.id,
    requestId: deps.requestId,
    metadata: { shared, title },
  });
  return linha;
}

export async function alterarRespostaPronta(
  deps: DepsDaOperacao,
  id: string,
  alteracao: UpdateTemplateInput,
): Promise<unknown> {
  let consulta = deps.supabase
    .from("message_templates")
    .update({ ...alteracao, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", deps.organizationId);
  // Chave não é pessoa: só mexe no que é da empresa. Sessão: a RLS decide quem escreve o quê.
  if (pessoa(deps) === null) consulta = consulta.is("owner_user_id", null);
  const { data, error } = await consulta.select(COLUNAS_DA_RESPOSTA_PRONTA).maybeSingle();
  if (error) throw recusa(deps, 500, "internal_error", "Erro ao atualizar template.");
  if (!data) throw recusa(deps, 404, "not_found", "Template não encontrado.");

  void audit({
    action: "template.updated",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "message_template",
    resourceId: (data as { id: string }).id,
    requestId: deps.requestId,
    metadata: { fields: Object.keys(alteracao) },
  });
  return data;
}

export async function apagarRespostaPronta(deps: DepsDaOperacao, id: string): Promise<{ id: string }> {
  let consulta = deps.supabase
    .from("message_templates")
    .delete()
    .eq("id", id)
    .eq("organization_id", deps.organizationId);
  if (pessoa(deps) === null) consulta = consulta.is("owner_user_id", null);
  // `.select()` confirma que a linha existia E era apagável: um DELETE barrado afeta 0 linhas e
  // não pode virar 204 + audit de uma exclusão que não houve.
  const { data, error } = await consulta.select("id").maybeSingle();
  if (error) throw recusa(deps, 500, "internal_error", "Erro ao excluir template.");
  if (!data) throw recusa(deps, 404, "not_found", "Template não encontrado.");

  void audit({
    action: "template.deleted",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "message_template",
    resourceId: (data as { id: string }).id,
    requestId: deps.requestId,
  });
  return { id: (data as { id: string }).id };
}
