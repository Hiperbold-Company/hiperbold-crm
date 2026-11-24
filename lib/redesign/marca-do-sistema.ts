import { DEFAULT_APP_NAME } from "@/lib/branding";
import { camadaDoAmbiente, resolverMarca } from "@/lib/branding/resolve";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { marcaDaSaida, type MarcaDeSaida } from "@/lib/branding/saida";
import { env } from "@/lib/env";

/**
 * A MARCA DAS PÁGINAS DE SISTEMA NO REDESIGN (403, 404, 500, 503 e convite).
 *
 * Essas páginas aparecem quando algo deu errado. `marcaDaSaida` lê
 * `platform_branding` no banco sem limite de tempo: se o banco pendurar, a
 * página de erro penduraria junto. Por isso a leitura tem TETO, e passado o
 * teto (ou se ela lançar) vale a marca do ambiente — `APP_NAME`/`APP_LOGO_URL`,
 * a semente do `.env` — ou o padrão do produto. Nunca lança.
 *
 * Só o ramo da chave LIGADA usa isto; a página de sempre não lê marca.
 */
export type MarcaDoSistema = Pick<MarcaDeSaida, "nome" | "logoUrl" | "logoDarkUrl">;

/** Curto: quem vê uma página de erro não espera o banco. */
export const TETO_DA_MARCA_MS = 1500;

/** A marca sem banco: só o `.env`, ou o padrão do produto. Síncrona, nunca lança. */
export function marcaDoAmbiente(): MarcaDoSistema {
  try {
    const marca = resolverMarca([camadaDoAmbiente(env)], REGUA_DO_PRODUTO);
    return {
      nome: marca.name,
      logoUrl: marca.logoUrl,
      ...(marca.logoDarkUrl ? { logoDarkUrl: marca.logoDarkUrl } : {}),
    };
  } catch {
    return { nome: DEFAULT_APP_NAME, logoUrl: null };
  }
}

/** A marca da instalação, se o banco responder dentro do teto. */
export async function marcaDoSistemaComTeto(tetoMs: number = TETO_DA_MARCA_MS): Promise<MarcaDoSistema> {
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const estouro = new Promise<null>((resolve) => {
    relogio = setTimeout(() => resolve(null), tetoMs);
  });
  try {
    const lida = await Promise.race([marcaDaSaida(null), estouro]);
    if (!lida) return marcaDoAmbiente();
    return {
      nome: lida.nome,
      logoUrl: lida.logoUrl,
      ...(lida.logoDarkUrl ? { logoDarkUrl: lida.logoDarkUrl } : {}),
    };
  } catch {
    return marcaDoAmbiente();
  } finally {
    clearTimeout(relogio);
  }
}
