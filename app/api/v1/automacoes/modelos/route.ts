import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/automacoes/modelos — cria uma automação RASCUNHO a partir de um modelo pronto
 * (`lib/automacoes/modelos.ts`, lote 5). Não publica: quem publica é uma pessoa, no editor, depois
 * de ler os textos. Aceita `Idempotency-Key` (o duplo clique não cria duas).
 *
 * A entrada do modelo (etapa de destino, campo de data) é conferida contra a organização ativa —
 * nunca aceita id de outra conta. Auth: sessão OU token `dsk_…` (`manager`, como a tela).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { comIdempotencia, chaveDaRequisicao, identidadeDoAtor } from "@/lib/api/idempotency";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { modeloDeAutomacaoPorId } from "@/lib/automacoes/modelos";
import { criarFluxo, type DepsDeFollowup } from "@/lib/followup/administracao";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { entradaDeFluxo } from "@/lib/followup/porta";
import { camposDeDataDoNegocio } from "@/lib/leads/campos-do-funil";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const ENDPOINT = "POST /api/v1/automacoes/modelos";

const corpoSchema = z.strictObject({
  model_id: z.string().min(1).max(60),
  name: z.string().trim().min(1).max(80).optional(),
  stage_id: z.string().uuid().optional(),
  campo_de_data: z.string().trim().min(1).max(60).optional(),
});
type Corpo = z.infer<typeof corpoSchema>;

const recusa = (deps: DepsDeFollowup, status: number, code: string, msg: string) =>
  new ApiError(status, code, undefined, deps.requestId, (deps.t ?? ((x: string) => x))(msg));

async function criar(
  deps: DepsDeFollowup,
  corpo: Corpo,
): Promise<{ id: string; model_id: string }> {
  const modelo = modeloDeAutomacaoPorId(corpo.model_id);
  if (!modelo) throw recusa(deps, 404, "not_found", "Este modelo não existe mais.");

  const entrada: { pipelineId?: string; stageId?: string; campoDeData?: string } = {};
  if (modelo.pede === "etapa") {
    if (!corpo.stage_id)
      throw recusa(deps, 422, "trigger_stage_missing", "Escolha a etapa para onde o negócio vai.");
    const { data: etapa, error } = await deps.admin
      .from("crm_stages")
      .select("id, pipeline_id, is_archived")
      .eq("id", corpo.stage_id)
      .eq("organization_id", deps.organizationId)
      .maybeSingle();
    if (error)
      throw recusa(deps, 500, "internal_error", "Não consegui criar a automação. Tente de novo.");
    if (!etapa || etapa.is_archived)
      throw recusa(
        deps,
        422,
        "trigger_stage_not_found",
        "A etapa escolhida não existe mais. Escolha outra.",
      );
    entrada.pipelineId = etapa.pipeline_id as string;
    entrada.stageId = etapa.id as string;
  }
  if (modelo.pede === "campo_de_data") {
    if (!corpo.campo_de_data)
      throw recusa(deps, 422, "campo_de_data_ausente", "Escolha o campo de data do negócio.");
    const { data: funis, error } = await deps.admin
      .from("crm_pipelines")
      .select("settings")
      .eq("organization_id", deps.organizationId);
    if (error)
      throw recusa(deps, 500, "internal_error", "Não consegui criar a automação. Tente de novo.");
    const chaves = new Set(
      (funis ?? []).flatMap((f) =>
        camposDeDataDoNegocio(
          (f as { settings?: Record<string, unknown> | null }).settings ?? null,
        ).map((c) => c.key),
      ),
    );
    if (!chaves.has(corpo.campo_de_data))
      throw recusa(
        deps,
        422,
        "campo_de_data_ausente",
        "O campo de data escolhido não existe nos seus funis.",
      );
    entrada.campoDeData = corpo.campo_de_data;
  }

  const grafo = flowGraphSchema.safeParse(modelo.grafo(entrada));
  if (!grafo.success) throw recusa(deps, 500, "internal_error", `modelo_invalido: ${modelo.id}`);

  const criado = await criarFluxo(deps, { name: corpo.name ?? modelo.nome, surface: "automacao" });
  const { error: upErr } = await deps.admin
    .from("followup_flow_pointers")
    .update({ draft_graph: grafo.data })
    .eq("id", criado.id)
    .eq("organization_id", deps.organizationId);
  if (upErr) {
    await deps.admin
      .from("followup_flow_pointers")
      .delete()
      .eq("id", criado.id)
      .eq("organization_id", deps.organizationId);
    throw recusa(deps, 500, "internal_error", "Não consegui criar a automação. Tente de novo.");
  }
  void audit({
    action: "automacao.criada_de_modelo",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "followup_flow_pointer",
    resourceId: criado.id,
    requestId: deps.requestId,
    metadata: { model_id: modelo.id },
  });
  return { id: criado.id, model_id: modelo.id };
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entradaDeFluxo(req, { escrita: true, role: "manager" });
  if (e.resposta) return e.resposta;
  const t = e.deps.t ?? ((x: string) => x);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId: e.requestId });
  }
  const parsed = corpoSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId: e.requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const chave = chaveDaRequisicao(req);
    if (chave === null)
      return ok(await criar(e.deps, parsed.data), { requestId: e.requestId, status: 201 });
    const desfecho = await comIdempotencia({
      db: createAdminClient(),
      organizationId: e.deps.organizationId,
      endpoint: ENDPOINT,
      chave,
      ator: identidadeDoAtor(e.deps.actor),
      corpo: parsed.data,
      executar: async () => ({ resposta: await criar(e.deps, parsed.data), status: 201 }),
    });
    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId: e.requestId },
      );
    }
    if (desfecho.tipo === "em_curso") {
      return fail(
        "idempotency_in_progress",
        t("A mesma criação ainda está em curso. Tente de novo em instantes."),
        409,
        { requestId: e.requestId },
      );
    }
    return ok(desfecho.resposta, { requestId: e.requestId, status: desfecho.status as 200 | 201 });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
