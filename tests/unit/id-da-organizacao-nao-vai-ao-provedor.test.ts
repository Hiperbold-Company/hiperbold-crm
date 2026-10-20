/**
 * O ID DA ORGANIZAÇÃO NÃO SAI NAS CHAMADAS AO PROVEDOR DE IA (20/10/2026).
 *
 * O worker de resposta mandava `X-AI-Gateway-Tenant-Id: <organization_id>` (e `Zero-Retention`) em
 * toda geração. Com a chave da instalação saindo pela OpenRouter/OpenAI, isso era dado nosso
 * vazando para terceiros sem função nenhuma: a atribuição de custo por empresa mora em
 * `llm_calls`/`ai_invocations`. Guarda de varredura (não há como exercitar `invokeBot` isolado sem
 * montar o worker inteiro): nenhum código de produção pode voltar a montar esse cabeçalho.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");

function ocorrencias(padrao: string): string[] {
  try {
    return execFileSync("git", ["grep", "--untracked", "-nE", padrao, "--", "lib", "app", "workers", "hooks", "components"], {
      cwd: RAIZ,
      encoding: "utf8",
    })
      .split("\n")
      .filter((l) => l && !/\.test\.tsx?:/.test(l));
  } catch {
    return []; // git grep sai com 1 quando não acha nada
  }
}

describe("cabeçalhos que identificam a organização nas chamadas de IA", () => {
  it("nenhum código de produção monta X-AI-Gateway-Tenant-Id", () => {
    expect(ocorrencias("X-AI-Gateway-Tenant-Id")).toEqual([]);
  });

  it("ninguém importa ou chama gatewayHeaders", () => {
    expect(ocorrencias("gatewayHeaders")).toEqual([]);
  });
});
