/**
 * As regras novas do bloco Condição nas automações (campo padrão ou
 * personalizado, tag, etapa, negócio aberto no funil, negócio existe, situação
 * do negócio). Puro: recebe os fatos carregados pelo motor.
 *
 * Mesma regra das legadas (`evaluateCheck`, node-handlers): **o desconhecido
 * nunca satisfaz uma negação.** Campo sem valor não é "diferente de X", e
 * contato sem negócio não está "fora da etapa Y" — está fora do alcance da
 * pergunta, e a regra responde `false`.
 */
import type { NovaConditionCheck } from "@/lib/followup/graph-schema";

import type { FatosDaAutomacao } from "./fatos";
import type { FieldRef } from "./schemas";

function lerCaminho(raiz: unknown, caminho: string): unknown {
  let atual: unknown = raiz;
  for (const parte of caminho.split(/\.|\[(\d+)\]/).filter((p) => p !== undefined && p !== "")) {
    if (atual === null || atual === undefined) return undefined;
    if (typeof atual !== "object") return undefined;
    atual = (atual as Record<string, unknown>)[parte];
  }
  return atual;
}

/** O valor atual do campo que `ref` aponta, ou `undefined` quando não há de onde ler. */
export function lerCampo(ref: FieldRef, fatos: FatosDaAutomacao): unknown {
  switch (ref.scope) {
    case "contact":
      return fatos.contato ? fatos.contato[ref.key] : undefined;
    case "contact_custom":
      return fatos.contato?.custom_fields[ref.key];
    case "lead":
      return fatos.negocio ? fatos.negocio[ref.key] : undefined;
    case "lead_custom":
      return fatos.negocio?.custom_fields[ref.key];
    case "var":
      return lerCaminho(fatos.vars, ref.path);
  }
}

function vazio(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function comoNumero(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim().replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normal(v: unknown): string {
  return String(v).trim().toLocaleLowerCase("pt-BR");
}

/** Compara um valor (escalar ou lista) com o operador. Texto sem distinguir maiúsculas. */
export function comparaCampo(
  atual: unknown,
  op: Extract<NovaConditionCheck, { kind: "field" }>["op"],
  esperado: string | number | undefined,
): boolean {
  if (op === "has_value") return !vazio(atual);
  if (op === "empty") return vazio(atual);
  if (vazio(atual) || esperado === undefined) return false; // desconhecido nunca satisfaz

  if (Array.isArray(atual)) {
    const lista = atual.map(normal);
    const alvo = normal(esperado);
    if (op === "eq" || op === "contains") return lista.includes(alvo);
    if (op === "neq" || op === "not_contains") return !lista.includes(alvo);
    if (op === "starts_with") return lista.some((v) => v.startsWith(alvo));
    return false;
  }

  if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
    const a = comoNumero(atual);
    const b = comoNumero(esperado);
    if (a !== null && b !== null) {
      return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    }
    // Data ISO (AAAA-MM-DD…) compara como texto na mesma ordem do tempo.
    const sa = String(atual);
    const sb = String(esperado);
    if (/^\d{4}-\d{2}-\d{2}/.test(sa) && /^\d{4}-\d{2}-\d{2}/.test(sb)) {
      return op === "gt" ? sa > sb : op === "gte" ? sa >= sb : op === "lt" ? sa < sb : sa <= sb;
    }
    return false;
  }

  const a = normal(atual);
  const b = normal(esperado);
  switch (op) {
    case "eq":
      return a === b;
    case "neq":
      return a !== b;
    case "contains":
      return a.includes(b);
    case "not_contains":
      return !a.includes(b);
    case "starts_with":
      return a.startsWith(b);
  }
}

/** Avalia UMA regra nova contra os fatos. Sem fatos (motor de follow-up), nenhuma regra nova passa. */
export function avaliarRegraNova(check: NovaConditionCheck, fatos: FatosDaAutomacao | undefined): boolean {
  if (!fatos) return false;
  switch (check.kind) {
    case "field":
      return comparaCampo(lerCampo(check.field, fatos), check.op, check.value);
    case "tag": {
      const dono = check.target === "lead" ? fatos.negocio : fatos.contato;
      if (!dono) return false;
      const tem = new Set(dono.tags.map(normal));
      const pedidas = check.tags.map(normal);
      if (check.op === "has_any") return pedidas.some((t) => tem.has(t));
      if (check.op === "has_all") return pedidas.every((t) => tem.has(t));
      return pedidas.every((t) => !tem.has(t));
    }
    case "stage": {
      if (!fatos.negocio) return false;
      const dentro = check.stage_ids.includes(fatos.negocio.stage_id);
      return check.op === "in" ? dentro : !dentro;
    }
    case "open_deal_in_pipeline":
      return fatos.negocios.some((n) => n.pipeline_id === check.pipeline_id && n.status === "open");
    case "deal_exists":
      return fatos.negocios.length > 0;
    case "deal_status":
      return fatos.negocio?.status === check.status;
  }
}
