import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH/DELETE /api/v1/pipelines/[id] — renomear, descrever, reordenar, eleger
 * padrão, arquivar e (só no caso limpo) excluir um funil.
 *
 * ⚠️ DELETE ARQUIVA POR PADRÃO. Três dependências cobram isso, e só uma delas o
 * banco defende sozinho: `crm_leads_pipeline_id_fkey` é `ON DELETE RESTRICT` (o
 * Postgres recusa funil com negócio), mas `webhook_sources.default_pipeline_id` é
 * `ON DELETE CASCADE` — apagar o funil apagaria a fonte de webhook do cliente EM
 * SILÊNCIO — e `automation_rules.actions` cita `pipeline_id` dentro de jsonb, sem
 * FK nenhuma. `?definitivo=1` só passa pelo caso honesto do "criei sem querer":
 * funil sem negócio, sem formulário e sem automação apontando para ele.
 *
 * Auth: sessão por cookie OU token `dsk_…` (`role:manager`+ e `mcp:write`), papel
 * manager+. `organization_id` sai do JWT/da linha do token — nunca do body nem da URL.
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra, a ORDEM das escritas (que o índice único de padrão cobra) e a tradução das
 * recusas vivem em `lib/pipelines/administracao.ts`, a mesma das tools MCP; as regras puras, em
 * `lib/pipelines/pipeline-editing.ts`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { editarFunil, excluirOuArquivarFunil } from "@/lib/pipelines/administracao";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * `depois_de` é o vizinho DE CIMA (`null` = primeiro da lista), não um número de
 * posição: quem clica na seta sabe onde o funil vai parar, não qual fração de
 * `position` isso vira.
 */
const bodySchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(280).nullable().optional(),
    is_default: z.boolean().optional(),
    /**
     * ⚠️ `false` É ACEITO AQUI, ao contrário de `is_default: false` — e a assimetria é deliberada. Toda
     * organização PRECISA de um funil padrão; nenhuma precisa de um funil de clientes, e não ter é o estado de
     * fábrica. Recusar o desligamento prenderia o operador numa escolha que ele fez para experimentar.
     */
    is_client_pipeline: z.boolean().optional(),
    /**
     * TIRAR DO ARQUIVO (#979). `true` é aceito pelo schema e recusado pelo núcleo, de propósito: quem manda
     * `is_archived: true` quer arquivar, e arquivar tem porta própria (`DELETE`) porque conta as dependências.
     */
    is_archived: z.boolean().optional(),
    depois_de: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "Nada para alterar." });

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "crm_pipelines",
    role: "manager",
    escrita: true,
    permissao: "funis.editar",
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  const { id: pipelineId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Não entendi o que mudar neste funil."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const corpo = await editarFunil(
      { supabase: authz.supabase, organizationId: authz.organizationId, actor: authz.actor, requestId, t },
      pipelineId,
      parsed.data,
    );
    return ok(corpo, { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "crm_pipelines",
    role: "manager",
    escrita: true,
    permissao: "funis.editar",
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  const { id: pipelineId } = await ctx.params;
  const definitivo = req.nextUrl.searchParams.get("definitivo") === "1";

  try {
    const corpo = await excluirOuArquivarFunil(
      { supabase: authz.supabase, organizationId: authz.organizationId, actor: authz.actor, requestId, t },
      pipelineId,
      { definitivo },
    );
    return ok(corpo, { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
