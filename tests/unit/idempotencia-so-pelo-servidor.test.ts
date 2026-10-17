/**
 * Cerca da migration 0969: `idempotency_keys` não é acessível a `authenticated`, então todo chamador de
 * `comIdempotencia` TEM de gravar o recibo com o cliente de servidor (`createAdminClient()`), nunca com o
 * cliente da sessão. Um chamador novo que passe `db: supabase` funcionaria em teste com dublê e quebraria
 * em produção (permission denied) — ou, pior, obrigaria alguém a devolver o GRANT e reabrir a leitura do
 * recibo (path_token, prompt de agente) a qualquer membro da organização.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");

function arquivos(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (nome === "node_modules" || nome === ".next") continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) arquivos(caminho, saida);
    else if (/\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

describe("idempotency_keys só pelo servidor (0969)", () => {
  it("todo `comIdempotencia({ db: … })` recebe createAdminClient()", () => {
    const achados: Array<{ arquivo: string; db: string }> = [];
    for (const raiz of ["app", "lib"]) {
      for (const arquivo of arquivos(join(RAIZ, raiz))) {
        if (arquivo.endsWith(join("lib", "api", "idempotency.ts"))) continue;
        const texto = readFileSync(arquivo, "utf8");
        for (const m of texto.matchAll(/comIdempotencia(?:<[^>]*>)?\(\{[^}]*?\bdb:\s*([^,\n]+),/gs)) {
          achados.push({ arquivo: arquivo.replace(RAIZ + "/", ""), db: m[1]!.trim() });
        }
      }
    }
    expect(achados.length, "a varredura não achou chamador nenhum: a regex quebrou").toBeGreaterThanOrEqual(4);
    expect(achados.filter((a) => a.db !== "createAdminClient()")).toEqual([]);
  });
});
