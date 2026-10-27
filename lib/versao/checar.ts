/**
 * A pergunta "o servidor já está numa versão diferente da que esta aba carregou?".
 *
 * Três respostas, e só uma acende o aviso: `nova`. Qualquer dúvida — rede caiu,
 * sessão expirou (401 do proxy), corpo estranho, id vazio, aba sem id — é
 * `indeterminado`. Um aviso de "nova versão" que aparece por engano ensina a
 * ignorá-lo, e aí ele não serve no dia em que é verdade.
 */
export type ResultadoDaChecagem = "mesma" | "nova" | "indeterminado";

export const ROTA_DA_VERSAO = "/api/v1/versao";

function idValido(valor: unknown): valor is string {
  return typeof valor === "string" && valor.trim().length > 0 && valor.length <= 200;
}

/** Compara o id carregado com o corpo devolvido pela rota. Pura. */
export function compararVersao(carregada: string | null, corpo: unknown): ResultadoDaChecagem {
  if (!idValido(carregada)) return "indeterminado";
  if (typeof corpo !== "object" || corpo === null) return "indeterminado";
  const data = (corpo as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return "indeterminado";
  const doServidor = (data as { build_id?: unknown }).build_id;
  if (!idValido(doServidor)) return "indeterminado";
  return doServidor.trim() === carregada.trim() ? "mesma" : "nova";
}

/** Busca o id do servidor e compara. Nunca lança. */
export async function checarVersao(
  carregada: string | null,
  buscar: typeof fetch = fetch,
): Promise<ResultadoDaChecagem> {
  if (!idValido(carregada)) return "indeterminado";
  try {
    const res = await buscar(ROTA_DA_VERSAO, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return "indeterminado";
    return compararVersao(carregada, await res.json());
  } catch {
    return "indeterminado";
  }
}
