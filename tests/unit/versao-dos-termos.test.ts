/**
 * D-133: a versão dos Termos de Uso acompanha o texto. O aceite gravado no pedido e no onboarding
 * só diz alguma coisa se a versão muda quando o texto muda; este teste trava a impressão digital do
 * arquivo da página junto com a versão. Se ele falhou porque você editou os Termos: troque
 * `VERSAO_DOS_TERMOS` (`lib/legal/versao-dos-termos.ts`) para a data de hoje e atualize os dois
 * valores do registro abaixo.
 *
 * Desde 10/11/2026 a impressão é só do TEXTO (o que está dentro de `<main>`): o menu e o rodapé do
 * site mudam sem mudar os Termos, e trocar a versão por causa do menu diria ao cliente que o
 * contrato mudou quando não mudou.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { VERSAO_DOS_TERMOS } from "@/lib/legal/versao-dos-termos";

const REGISTRO = {
  versao: "2026-10-29",
  impressaoDaPagina: "f002fe830d215838fe4b458b5d0a39c5edcac70241f9d6443ebb83d9bd2f64dd",
};

describe("versão dos Termos de Uso", () => {
  it("é uma data AAAA-MM-DD", () => {
    expect(VERSAO_DOS_TERMOS).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("o texto da página dos Termos é o que a versão vigente descreve", () => {
    const pagina = readFileSync(join(process.cwd(), "public/site/termos/index.html"), "utf8").replace(/\r\n/g, "\n");
    const texto = /<main[^>]*>([\s\S]*?)<\/main>/.exec(pagina)?.[1];
    expect(texto, "a página dos Termos perdeu o <main>").toBeTruthy();
    const impressao = createHash("sha256").update(texto ?? "").digest("hex");
    expect(
      impressao,
      "o texto dos Termos mudou: atualize VERSAO_DOS_TERMOS e o registro deste teste",
    ).toBe(REGISTRO.impressaoDaPagina);
    expect(VERSAO_DOS_TERMOS).toBe(REGISTRO.versao);
  });
});
