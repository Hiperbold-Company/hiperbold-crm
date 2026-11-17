/**
 * 1015: a RESPOSTA de uma escrita (PATCH do negócio, mover, ganhar, perder, retomar) devolve a linha
 * gravada — e com ela `custom_fields` inteiro. Sem o recorte, quem não é administrador recebia de
 * volta o valor que o GET esconde. Aqui o recorte é o MESMO do GET, de um lugar só.
 *
 * A escrita JÁ aconteceu quando isto roda: se a leitura das chaves restritas falhar, a resposta é
 * 500 (`falhaInterna`, o mesmo precedente do PATCH do contato) em vez de entregar o valor ao papel
 * errado. Quem chama deve deixar claro que o efeito foi gravado (o audit já saiu).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { falhaInterna } from "@/lib/api/wrappers";
import { chavesRestritasDaOrganizacao } from "@/lib/campos/chaves-restritas";
import { leitorVeCamposRestritos, recortarLinha, type LeitorDosCampos } from "@/lib/campos/recorte-por-papel";

/** A linha traz algum valor em `custom_fields`? Sem valor não há o que recortar — nem consulta a fazer. */
export function temCamposPersonalizados(linha: unknown): boolean {
  if (!linha || typeof linha !== "object") return false;
  const campos = (linha as { custom_fields?: unknown }).custom_fields;
  return !!campos && typeof campos === "object" && !Array.isArray(campos) && Object.keys(campos).length > 0;
}

export type LinhaRecortada<T> = { ok: true; linha: T } | { ok: false; resposta: Response };

export async function recortarLinhaDaResposta<T>(
  supabase: SupabaseClient,
  organizationId: string,
  linha: T,
  leitor: LeitorDosCampos | null | undefined,
  requestId: string,
): Promise<LinhaRecortada<T>> {
  if (leitorVeCamposRestritos(leitor) || !temCamposPersonalizados(linha)) return { ok: true, linha };
  const lidas = await chavesRestritasDaOrganizacao(supabase, organizationId, requestId);
  if (!lidas.ok) {
    return { ok: false, resposta: falhaInterna("internal_error", "chaves restritas ilegíveis", { requestId }) };
  }
  return { ok: true, linha: recortarLinha(linha, lidas.chaves, leitor) };
}
