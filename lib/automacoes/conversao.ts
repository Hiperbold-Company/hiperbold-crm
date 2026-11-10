/**
 * A troca de motor de UMA regra antiga (lote 5, "tela única"): lê a regra,
 * converte (`converter-regra.ts`, puro), cria o rascunho da automação, roda o
 * MESMO publish de sempre (`publicarFluxo`: referências da organização, regras
 * de publicação) e grava com `fn_automacao_converter_regra` — que desliga a
 * regra, marca `migrated_to_pointer_id` e publica a versão numa transação só
 * (migration 1005). Os gatilhos de guarda da 1005 recusam os dois motores
 * ligados ao mesmo tempo, por qualquer caminho.
 *
 * Compensação: se o publish recusar (ou o banco falhar) depois de o rascunho
 * existir, o rascunho é apagado — ele nunca foi publicado, e deixá-lo na lista
 * seria uma "automação" que a pessoa não pediu. A regra continua intacta.
 */
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { criarFluxo, publicarFluxo, type DepsDeFollowup } from "@/lib/followup/administracao";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { logger } from "@/lib/logger";

import { converterRegra, type RegraAntiga, type ResultadoDaConversao } from "./converter-regra";

const COLUNAS_DA_REGRA = "id, name, trigger_event, trigger_config, conditions, actions, is_active, migrated_to_pointer_id";

export interface RegraLida extends RegraAntiga {
  is_active: boolean;
  migrated_to_pointer_id: string | null;
}

const recusa = (deps: DepsDeFollowup, status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, code, details, deps.requestId, message);

/** A regra DESTA organização (service role, filtro explícito), ou 404. */
export async function lerRegra(deps: DepsDeFollowup, ruleId: string): Promise<RegraLida> {
  const t = deps.t ?? ((x: string) => x);
  const { data, error } = await deps.admin
    .from("automation_rules")
    .select(COLUNAS_DA_REGRA)
    .eq("id", ruleId)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (error) {
    logger.error("automacao.conversao.leitura_falhou", { request_id: deps.requestId, causa: error.message });
    throw recusa(deps, 500, "internal_error", t("Não consegui ler a regra. Tente de novo."));
  }
  if (!data) throw recusa(deps, 404, "not_found", t("Regra não encontrada."));
  return data as unknown as RegraLida;
}

/** Pré-visualização: o que a conversão faria, sem gravar nada. */
export function previaDaConversao(regra: RegraLida): ResultadoDaConversao {
  return converterRegra(regra);
}

function mapearErroDoBanco(deps: DepsDeFollowup, err: { message?: string; code?: string }): ApiError {
  const t = deps.t ?? ((x: string) => x);
  const msg = (err.message ?? "").trim();
  if (msg === "rule_already_converted") {
    return recusa(deps, 409, "regra_ja_convertida", t("Esta regra já virou automação."));
  }
  if (msg === "rule_not_found") return recusa(deps, 404, "not_found", t("Regra não encontrada."));
  if (msg === "pointer_not_found") return recusa(deps, 404, "not_found", t("Fluxo não encontrado."));
  if (err.code === "PT409") {
    return recusa(deps, 409, "dois_motores", t("A regra antiga e a automação nova não podem ficar ligadas ao mesmo tempo."));
  }
  logger.error("automacao.conversao.rpc_falhou", { request_id: deps.requestId, causa: msg });
  return recusa(deps, 500, "internal_error", t("Não consegui publicar a automação. Tente de novo."));
}

async function criarRascunho(deps: DepsDeFollowup, nome: string): Promise<string> {
  const t = deps.t ?? ((x: string) => x);
  const tentativas = [nome, `${nome} (automação)`.slice(0, 120)];
  for (const [i, n] of tentativas.entries()) {
    try {
      const criado = await criarFluxo(deps, { name: n, surface: "automacao" });
      return criado.id;
    } catch (err) {
      const conflito = err instanceof ApiError && err.status === 409;
      if (!conflito || i === tentativas.length - 1) throw err;
    }
  }
  throw recusa(deps, 409, "conflict", t("Já existe um fluxo com este nome."));
}

export interface ConversaoFeita {
  pointer_id: string;
  rule_id: string;
  version_id: string | null;
  ja_convertida: boolean;
}

/**
 * Converte e publica. Regra já convertida devolve o vínculo existente (o
 * reenvio do botão não cria segunda automação); regra não conversível é 422
 * com a lista do que não tem equivalente.
 */
export async function converterEPublicarRegra(deps: DepsDeFollowup, ruleId: string): Promise<ConversaoFeita> {
  const t = deps.t ?? ((x: string) => x);
  if (!deps.responsavel) {
    throw recusa(deps, 403, "forbidden", t("Não foi possível identificar quem responde por esta chave."));
  }
  const regra = await lerRegra(deps, ruleId);
  if (regra.migrated_to_pointer_id) {
    return { pointer_id: regra.migrated_to_pointer_id, rule_id: regra.id, version_id: null, ja_convertida: true };
  }
  const conversao = converterRegra(regra);
  if (!conversao.conversivel) {
    throw recusa(deps, 422, "regra_nao_conversivel", t("Esta regra tem partes que ainda não existem nas automações novas."), {
      nao_convertido: conversao.naoConvertido,
    });
  }
  const grafo: FlowGraph = conversao.grafo;

  const pointerId = await criarRascunho(deps, regra.name);
  let versionId: string | null = null;
  try {
    const { error: upErr } = await deps.admin
      .from("followup_flow_pointers")
      .update({ draft_graph: grafo })
      .eq("id", pointerId)
      .eq("organization_id", deps.organizationId);
    if (upErr) throw mapearErroDoBanco(deps, upErr);

    await publicarFluxo(deps, pointerId, async (admin, params) => {
      const { data, error } = await admin.rpc("fn_automacao_converter_regra", {
        p_org: params.orgId,
        p_rule: regra.id,
        p_pointer: params.pointerId,
        p_graph: params.graph,
        p_created_by: params.createdBy,
      });
      if (error) throw mapearErroDoBanco(deps, error);
      if (typeof data !== "string") return { ok: false, code: "internal_error", message: "no_version_id_returned" };
      versionId = data;
      return { ok: true, version_id: data };
    });
  } catch (err) {
    // Compensação: o rascunho nunca foi publicado (a função é uma transação só).
    const { error: delErr } = await deps.admin
      .from("followup_flow_pointers")
      .delete()
      .eq("id", pointerId)
      .eq("organization_id", deps.organizationId)
      .is("active_version_id", null);
    if (delErr) logger.error("automacao.conversao.compensacao_falhou", { request_id: deps.requestId, causa: delErr.message });
    throw err;
  }

  void audit({
    action: "automacao.regra_convertida",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "followup_flow_pointer",
    resourceId: pointerId,
    requestId: deps.requestId,
    metadata: { rule_id: regra.id, version_id: versionId },
  });
  return { pointer_id: pointerId, rule_id: regra.id, version_id: versionId, ja_convertida: false };
}
