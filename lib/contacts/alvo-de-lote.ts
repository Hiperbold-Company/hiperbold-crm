/**
 * Quem entra num lote (exclusão ou exportação): a seleção da tela (ids) OU "todos
 * do filtro", que o SERVIDOR resolve — nunca uma lista de milhares de ids vinda do
 * navegador.
 *
 * No modo filtro, `esperado` é a contagem que a pessoa VIU ao confirmar. Se a lista
 * mudou no meio do caminho (alguém importou, apagou, mexeu numa etiqueta), a operação
 * recusa com 409 em vez de agir sobre um conjunto diferente do que foi confirmado —
 * o erro mais caro deste recurso é apagar a coisa errada em silêncio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { contarContatos, idsDoFiltro, type ContextoDaConsulta } from "@/lib/contacts/consulta";
import type { FiltrosDeContatos } from "@/lib/schemas/contacts";

export type AlvoResolvido =
  | { ok: true; modo: "ids"; ids: string[] }
  | { ok: true; modo: "filtro"; ids: string[] }
  | { ok: false; status: 409 | 422; code: string; message: string };

export async function resolverAlvoDeLote(
  supabase: SupabaseClient,
  alvo: { ids: string[] } | { filtro: FiltrosDeContatos; esperado?: number },
  ctx: ContextoDaConsulta,
  teto: number,
  t: (texto: string) => string,
): Promise<AlvoResolvido> {
  if ("ids" in alvo) {
    const ids = [...new Set(alvo.ids)];
    if (ids.length > teto) {
      return { ok: false, status: 422, code: "validation_failed", message: mensagemDoTeto(teto, t) };
    }
    return { ok: true, modo: "ids", ids };
  }

  // O lote e a exportação operam só o contato vivo: sem anonimizado, que a lista mostra com o selo.
  const ctxDoLote = { ...ctx, somenteOperaveis: true };
  const total = await contarContatos(supabase, alvo.filtro, ctxDoLote);
  if (total > teto) {
    return { ok: false, status: 422, code: "validation_failed", message: mensagemDoTeto(teto, t) };
  }
  if (alvo.esperado !== undefined && total !== alvo.esperado) {
    return { ok: false, status: 409, code: "state_conflict", message: mensagemDeListaMudou(t) };
  }
  const { ids, excedeu } = await idsDoFiltro(supabase, alvo.filtro, ctxDoLote, teto);
  if (excedeu) {
    return { ok: false, status: 422, code: "validation_failed", message: mensagemDoTeto(teto, t) };
  }
  // A contagem e a lista de ids são duas leituras: se o conjunto mexeu entre elas, o que vai ser
  // agido não é o que a pessoa confirmou. Mesma recusa.
  if (alvo.esperado !== undefined && ids.length !== alvo.esperado) {
    return { ok: false, status: 409, code: "state_conflict", message: mensagemDeListaMudou(t) };
  }
  return { ok: true, modo: "filtro", ids };
}

function mensagemDeListaMudou(t: (texto: string) => string): string {
  return t("A lista mudou desde que você a viu. Atualize a tela e confira de novo antes de continuar.");
}

function mensagemDoTeto(teto: number, t: (texto: string) => string): string {
  return `${t("São contatos demais para uma vez só. O máximo é")} ${teto.toLocaleString("pt-BR")}. ${t("Use um filtro mais específico e repita.")}`;
}
