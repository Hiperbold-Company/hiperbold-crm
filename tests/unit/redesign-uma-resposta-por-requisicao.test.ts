import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Cerca: o redesign tem UMA resposta por requisição.
 *
 * A raiz (`data-redesign` no <html>), os `ProvedorDoRedesign` e cada tela que
 * escolhe a marca precisam vir da mesma função, `redesignNaRequisicao()`
 * (chave geral OU chave da empresa ativa). Se uma tela ler só a chave geral
 * (`redesignLigado()`) enquanto a raiz lê a da empresa, a empresa ligada recebe
 * CSS novo sobre marcação antiga — o pior dos dois visuais.
 */
const arquivos = execFileSync("git", ["ls-files", "app", "components", "hooks", "lib"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f) && !f.startsWith("lib/redesign/chave"));

describe("redesign: uma resposta por requisição", () => {
  it("nenhum arquivo fora de lib/redesign/chave chama a chave só-geral", () => {
    const culpados = arquivos.filter((f) => /\bredesignLigado\s*\(/.test(readFileSync(f, "utf8")));
    expect(culpados).toEqual([]);
  });

  it("a raiz decide pelo resolvedor por requisição", () => {
    const raiz = readFileSync("app/layout.tsx", "utf8");
    expect(raiz).toMatch(/await\s+redesignNaRequisicao\s*\(\s*\)/);
  });

  it("o resolvedor existe e é guardado por requisição (React cache)", () => {
    const chave = readFileSync("lib/redesign/chave.ts", "utf8");
    expect(chave).toMatch(/export const redesignNaRequisicao\s*=\s*cache\(/);
  });
});
