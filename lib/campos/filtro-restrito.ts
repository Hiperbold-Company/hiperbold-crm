/**
 * 1015: filtrar a lista de contatos por um campo NÃO PÚBLICO é um oráculo do valor — quem não vê o
 * campo descobriria, por tentativa, o que está gravado nele. Por isso só o administrador filtra por
 * campo restrito; os demais recebem 403. Sem conseguir ler quais chaves são restritas, recusa (falha
 * fechada) — mas só quando há filtro por campo, que é o único caso em que a pergunta importa.
 *
 * Quem chama: a lista (`GET /contacts`), a contagem, a exportação e a exclusão em lote — os quatro
 * consumidores do filtro `campo` de `lib/contacts/consulta.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, falhaInterna } from "@/lib/api/wrappers";
import { chavesRestritasDaOrganizacao } from "@/lib/campos/chaves-restritas";
import { leitorVeCamposRestritos, type LeitorDosCampos, chaveEhRestrita } from "@/lib/campos/recorte-por-papel";

export async function recusaDoFiltroPorCampoRestrito(
  supabase: SupabaseClient,
  organizationId: string,
  campo: string | null | undefined,
  leitor: LeitorDosCampos | null | undefined,
  requestId: string,
): Promise<Response | null> {
  if (!campo || leitorVeCamposRestritos(leitor)) return null;
  const lidas = await chavesRestritasDaOrganizacao(supabase, organizationId, requestId);
  if (!lidas.ok) return falhaInterna("internal_error", "chaves restritas ilegíveis", { requestId });
  if (!chaveEhRestrita(lidas.chaves)(campo)) return null;
  return fail("forbidden_role", "Só administradores filtram por este campo.", 403, { requestId });
}
