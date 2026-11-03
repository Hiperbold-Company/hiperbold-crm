/**
 * A ação "Iniciar outra automação" (`start_automation`, lote 3).
 *
 * Inicia a automação de destino para o MESMO contato pela única porta,
 * `fn_automacao_iniciar`, com:
 *  - `p_parent_enrollment_id` = esta execução: a cadeia, o ciclo (A → B → A) e
 *    a profundidade 5 são medidos e cortados pela função do banco;
 *  - `p_origin_event_id` determinístico por execução + passo + ação: o replay
 *    do mesmo passo devolve `duplicada` em vez de abrir segunda execução;
 *  - `p_vars = { gatilho: { tipo: "started_by_automation", ... }, param: {...} }`
 *    com os valores já renderizados (`{{param.<chave>}}` no destino).
 *
 * ⚠️ LGPD: os VALORES passados moram só em `followup_enrollments.vars` do
 * destino (zerado na anonimização). Os eventos — o `effect_done` daqui e o
 * `iniciada_pela_automacao` do destino — guardam só as CHAVES.
 *
 * ⚠️ Service role: o destino é lido filtrando `organization_id` pela INSCRIÇÃO
 * (que veio do banco), nunca pelo grafo — um id de automação de outra
 * organização colado no rascunho cai em `automacao_inexistente`.
 */
import { uuidDeterministico } from "../armadas";
import { aceitaIniciador, gatilhosDoGrafo } from "../gatilhos";
import { iniciarAutomacao, type ResultadoDoInicio } from "../iniciar";
import { MAX_VALOR_DE_PARAMETRO, type CrmAction } from "../schemas";
import { negocioDaExecucao } from "../fatos";
import { renderizar } from "../template-vars";
import type { Contexto, Passo } from "./index";

type AcaoDeIniciar = Extract<CrmAction, { type: "start_automation" }>;

/** Evento gravado na execução de DESTINO: quem a iniciou e quais chaves vieram. */
export const EVENTO_INICIADA_PELA_AUTOMACAO = "iniciada_pela_automacao";

/** Os resultados do `fn_automacao_iniciar` que levam o bloco pela saída "Concluído". */
const SUCESSO: ReadonlySet<ResultadoDoInicio> = new Set<ResultadoDoInicio>([
  "iniciada",
  "reiniciada",
  "ja_em_execucao",
  "duplicada",
]);

/** O `origin_event_id` desta ação neste passo: o mesmo em todo replay. */
export function origemDoInicio(
  enrollmentId: string,
  chave: string,
  indice: number,
  destino: string,
): string {
  return uuidDeterministico("start_automation", enrollmentId, chave, String(indice), destino);
}

async function nomeDaAutomacao(c: Contexto, id: string): Promise<string | null> {
  const { data } = await c.admin
    .from("followup_flow_pointers")
    .select("name")
    .eq("organization_id", c.org)
    .eq("id", id)
    .maybeSingle();
  return (data as { name?: string } | null)?.name ?? null;
}

export async function executarIniciarAutomacao(
  c: Contexto,
  acao: AcaoDeIniciar,
  indice: number,
): Promise<Passo> {
  const chaves = acao.params.map((p) => p.key);
  const base = { tipo: acao.type, automacao_id: acao.pointer_id, chaves };
  if (acao.pointer_id === c.pointerId)
    return { ok: false, erro: "automacao_propria", detalhe: base };

  const { data: destino, error } = await c.admin
    .from("followup_flow_pointers")
    .select("id, name, surface, status, active_version_id")
    .eq("organization_id", c.org)
    .eq("id", acao.pointer_id)
    .maybeSingle();
  if (error) return { ok: false, erro: "efeito_falhou", detalhe: base };
  const d = destino as {
    id: string;
    name: string | null;
    surface: string;
    status: string;
    active_version_id: string | null;
  } | null;
  if (!d || d.surface !== "automacao")
    return { ok: false, erro: "automacao_inexistente", detalhe: base };
  const comNome = { ...base, automacao_nome: d.name ?? null };
  if (d.status !== "active" || !d.active_version_id) {
    return { ok: false, erro: "automacao_inativa", detalhe: comNome };
  }

  // A lista de iniciadores do gatilho "Iniciada por outra automação" é do grafo
  // publicado do destino — lida filtrando a organização.
  const { data: versao, error: vErr } = await c.admin
    .from("followup_flow_versions")
    .select("graph")
    .eq("organization_id", c.org)
    .eq("id", d.active_version_id)
    .maybeSingle();
  if (vErr) return { ok: false, erro: "efeito_falhou", detalhe: comNome };
  const grafo = (versao as { graph?: unknown } | null)?.graph;
  if (!aceitaIniciador(gatilhosDoGrafo(grafo), c.pointerId)) {
    return { ok: false, erro: "automacao_nao_aceita", detalhe: comNome };
  }

  const param: Record<string, string> = {};
  for (const p of acao.params)
    param[p.key] = renderizar(p.value, c.fatos, c.agora).slice(0, MAX_VALOR_DE_PARAMETRO);

  const origem = origemDoInicio(c.enrollmentId, c.chave, indice, acao.pointer_id);
  // O destino trabalha no MESMO negócio da origem (o que a origem carrega, ou o
  // que ela resolveu), e não no aberto mais recente do contato: `_lead_id` é o
  // negócio da execução que os blocos de CRM leem (`negocioDaExecucao`).
  const negocio = c.fatos?.negocio?.id ?? negocioDaExecucao(c.fatos?.vars ?? {});
  const r = await iniciarAutomacao(c.admin, {
    organizationId: c.org,
    pointerId: acao.pointer_id,
    contactId: c.contatoId,
    vars: {
      ...(negocio ? { _lead_id: negocio } : {}),
      gatilho: {
        tipo: "started_by_automation",
        automacao_id: c.pointerId,
        event_id: origem,
        ...(negocio ? { lead_id: negocio, _lead_id: negocio } : {}),
      },
      param,
    },
    originEventId: origem,
    parentEnrollmentId: c.enrollmentId,
  });
  const detalhe = { ...comNome, resultado: r.resultado };
  if (!SUCESSO.has(r.resultado)) return { ok: false, erro: `automacao_${r.resultado}`, detalhe };

  // Na execução nova, quem a iniciou (o nome como estava agora) e só as chaves.
  if ((r.resultado === "iniciada" || r.resultado === "reiniciada") && r.enrollment_id) {
    const nomeDaOrigem = await nomeDaAutomacao(c, c.pointerId);
    await c.admin.from("followup_enrollment_events").insert({
      organization_id: c.org,
      enrollment_id: r.enrollment_id,
      node_id: null,
      event_type: EVENTO_INICIADA_PELA_AUTOMACAO,
      payload: { automacao_id: c.pointerId, automacao_nome: nomeDaOrigem, chaves },
      idempotency_key: "iniciada-pela-automacao",
    });
  }
  return { ok: true, detalhe };
}
