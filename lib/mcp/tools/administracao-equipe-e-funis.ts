/**
 * Capacidades de ADMINISTRAR a equipe e os funis por chave de API — fase 3 da API (17/10/2026): convidar,
 * mudar papel, revogar e reativar acesso; criar, editar e arquivar/excluir funil. (As rotas já aceitavam
 * `Bearer dsk_…` desde a fase 1; faltava a tool.)
 *
 * ⚠️ AQUI HÁ TRADUÇÃO DE ARGUMENTO E NADA MAIS. A regra vive em `lib/team/administracao.ts` e
 * `lib/pipelines/administracao.ts`, os MESMOS núcleos das rotas `/api/v1/team/**` e `/api/v1/pipelines/**`.
 *
 * ⚠️ O PAPEL É O DA TELA: `admin` para equipe, `manager` para funil. Todas `apenasHumano`: quem decide quem
 * entra na empresa e com que poder não é o agente que atende. O link de aceite do convite NUNCA volta para a
 * chave (o convite sai por e-mail), e a chave não revoga o acesso do seu dono.
 */
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import { isServiceRoleConfigured } from "@/lib/audit";
import { inviteMemberSchema } from "@/lib/schemas/team";
import {
  convidarMembros,
  mudarPapelDoMembro,
  reativarAcessoDoMembro,
  revogarAcessoDoMembro,
  type DepsDeEquipe,
} from "@/lib/team/administracao";
import {
  criarFunil,
  editarFunil,
  excluirOuArquivarFunil,
  type DepsDeFunis,
} from "@/lib/pipelines/administracao";

import type { McpContext, McpToolDefinition } from "../types";
import { responsavelDaChave } from "./administracao-fase3";

const PAPEIS = ["viewer", "agent", "manager", "admin"] as const;

async function depsDaEquipe(ctx: McpContext): Promise<DepsDeEquipe> {
  return {
    supabase: ctx.supabase,
    admin: ctx.supabase,
    organizationId: ctx.organizationId,
    actor: ctx.actor,
    responsavel: await responsavelDaChave(ctx),
    requestId: ctx.requestId,
  };
}

function depsDosFunis(ctx: McpContext): DepsDeFunis {
  return {
    supabase: ctx.supabase,
    organizationId: ctx.organizationId,
    actor: ctx.actor,
    requestId: ctx.requestId,
  };
}

function recusa(ctx: McpContext, status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, undefined, ctx.requestId, message);
}

// ---------------------------------------------------------------------------
// equipe
// ---------------------------------------------------------------------------

const inviteShape = {
  invitations: z
    .array(
      z.object({
        email: z.string().email(),
        role: z.enum(PAPEIS),
        /** Áreas do menu liberadas (`preset` + `destinos`); ausente = o padrão do papel. */
        interface_settings: z
          .object({ preset: z.enum(["completa", "simplificada"]), destinos: z.array(z.string()).optional() })
          .optional(),
      }),
    )
    .min(1)
    .max(20),
};

export const crmInviteTeamMembers: McpToolDefinition<typeof inviteShape> = {
  name: "crm_invite_team_members",
  description:
    "Convida até 20 pessoas para a equipe por e-mail, cada uma com um papel (viewer, agent, manager ou admin). O " +
    "e-mail sai de verdade, em nome da empresa e do dono desta chave; o link de aceite NÃO volta na resposta. Quem já é " +
    "membro, quem estoura o teto de convites da hora e o teto de usuários do plano voltam em `failed` com o motivo. " +
    "Convidar admin dá a essa pessoa o controle da empresa. Exige papel admin.",
  inputSchema: inviteShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const parsed = inviteMemberSchema.safeParse(input);
    if (!parsed.success) {
      throw recusa(ctx, 422, "unprocessable_entity", "Confira os e-mails, os papéis e as áreas do menu escolhidas.");
    }
    const deps = await depsDaEquipe(ctx);
    const { data: org } = await ctx.supabase
      .from("organizations")
      .select("display_name")
      .eq("id", ctx.organizationId)
      .maybeSingle();
    const orgName = (org as { display_name?: string | null } | null)?.display_name?.trim() || "—";
    let inviterName = "Um colega";
    try {
      const { data } = await deps.admin.auth.admin.getUserById(deps.responsavel!);
      const meta = data?.user?.user_metadata as { full_name?: string } | undefined;
      inviterName = meta?.full_name ?? data?.user?.email ?? inviterName;
    } catch {
      /* o texto neutro basta */
    }
    return convidarMembros(deps, parsed.data, {
      orgName,
      inviterName,
      ocultarLink: true,
      comServiceRole: isServiceRoleConfigured(),
    });
  },
};

const roleShape = { user_id: z.string().uuid(), role: z.enum(PAPEIS) };

export const crmChangeTeamMemberRole: McpToolDefinition<typeof roleShape> = {
  name: "crm_change_team_member_role",
  description:
    "Muda o papel de um membro ativo da equipe (viewer, agent, manager, admin). Vale na hora: promover dá mais poder " +
    "sobre a empresa, rebaixar tira. Não rebaixa o último admin e não mexe em membro revogado. Exige papel admin.",
  inputSchema: roleShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => mudarPapelDoMembro(await depsDaEquipe(ctx), input.user_id, input.role),
};

const memberShape = { user_id: z.string().uuid() };

export const crmRevokeTeamMember: McpToolDefinition<typeof memberShape> = {
  name: "crm_revoke_team_member",
  description:
    "Revoga o acesso de um membro: ele perde a entrada na empresa na hora, as chaves de API que ele criou deixam de valer, " +
    "as notificações push dele são apagadas e as conversas abertas dele voltam para a fila. Não revoga o dono desta chave " +
    "nem o último admin. Reverte-se com crm_reactivate_team_member. Exige papel admin.",
  inputSchema: memberShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => revogarAcessoDoMembro(await depsDaEquipe(ctx), input.user_id),
};

export const crmReactivateTeamMember: McpToolDefinition<typeof memberShape> = {
  name: "crm_reactivate_team_member",
  description:
    "Devolve o acesso de um membro revogado, com o mesmo papel que ele tinha (não promove). As chaves de API que ele tinha " +
    "continuam revogadas. Respeita o teto de usuários do plano. Já ativo é no-op. Exige papel admin.",
  inputSchema: memberShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => reativarAcessoDoMembro(await depsDaEquipe(ctx), input.user_id),
};

// ---------------------------------------------------------------------------
// funis
// ---------------------------------------------------------------------------

const createPipelineShape = {
  name: z.string().min(1).max(80),
  description: z.string().max(280).nullable().optional(),
};

export const crmCreatePipeline: McpToolDefinition<typeof createPipelineShape> = {
  name: "crm_create_pipeline",
  description:
    "Cria um funil de vendas já com as etapas iniciais (e a etapa de ganho e de perda). Vai para o fim da lista; o primeiro " +
    "funil da empresa nasce como padrão. Nome repetido é recusado e o teto de funis do plano vale. Devolve a lista de funis " +
    "(pipelines) e os arquivados. Exige papel manager.",
  inputSchema: createPipelineShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => criarFunil(depsDosFunis(ctx), input),
};

const updatePipelineShape = {
  pipeline_id: z.string().uuid(),
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(280).nullable().optional(),
  /** `true` elege este funil como padrão (o antigo é liberado). `false` é recusado: o padrão se muda, não se apaga. */
  is_default: z.boolean().optional(),
  is_client_pipeline: z.boolean().optional(),
  /** Só `false` (tirar do arquivo). Para arquivar use crm_delete_pipeline. */
  is_archived: z.boolean().optional(),
  /** O funil que fica logo ACIMA deste na lista (`null` = primeiro). */
  depois_de: z.string().min(1).nullable().optional(),
};

export const crmUpdatePipeline: McpToolDefinition<typeof updatePipelineShape> = {
  name: "crm_update_pipeline",
  description:
    "Edita um funil: nome, descrição, ordem na lista (depois_de), qual é o padrão (is_default=true), qual é o funil de clientes " +
    "e tirar do arquivo (is_archived=false). Funil arquivado não se edita. Para arquivar ou excluir use crm_delete_pipeline. " +
    "Devolve a lista de funis. Exige papel manager.",
  inputSchema: updatePipelineShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { pipeline_id, ...campos } = input;
    const pedido = Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== undefined));
    if (Object.keys(pedido).length === 0) throw recusa(ctx, 422, "unprocessable_entity", "Nada para alterar.");
    return editarFunil(depsDosFunis(ctx), pipeline_id, pedido);
  },
};

const deletePipelineShape = {
  pipeline_id: z.string().uuid(),
  /** `true` exclui de vez, só o caso limpo (sem negócio, formulário nem automação). Padrão: arquivar. */
  definitivo: z.boolean().optional(),
};

export const crmDeletePipeline: McpToolDefinition<typeof deletePipelineShape> = {
  name: "crm_delete_pipeline",
  description:
    "ARQUIVA um funil (sai da lista e dos seletores) — recusado se for o padrão, o último vivo, ou se formulários ou " +
    "automações ainda mandam negócio para ele (a recusa traz as contagens). Com definitivo=true exclui de vez, só se não " +
    "houver negócio, formulário nem automação apontando. Exige papel manager.",
  inputSchema: deletePipelineShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    excluirOuArquivarFunil(depsDosFunis(ctx), input.pipeline_id, { definitivo: input.definitivo === true }),
};
