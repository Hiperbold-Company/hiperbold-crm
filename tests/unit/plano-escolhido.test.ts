import { describe, expect, it } from "vitest";

import { cicloPreSelecionado, sanitizarCiclo, sanitizarPlano } from "@/lib/auth/plano-escolhido";

describe("?plano= do site: só a forma é aceita", () => {
  it.each([
    ["pro", "pro"],
    ["max", "max"],
    ["scale", "scale"],
    ["pro-anual", "pro-anual"],
    ["  Pro  ", "pro"],
    ["MAX", "max"],
    ["a".repeat(40), "a".repeat(40)],
    ["plano-2", "plano-2"],
  ])("aceita %j", (entrada, esperado) => {
    expect(sanitizarPlano(entrada)).toBe(esperado);
  });

  it.each([
    ["vazio", ""],
    ["só espaços", "   "],
    ["41 caracteres", "a".repeat(41)],
    ["espaço no meio", "pro max"],
    ["underscore", "pro_max"],
    ["ponto", "pro.max"],
    ["barra (caminho)", "../etc/passwd"],
    ["tag HTML", "<script>alert(1)</script>"],
    ["aspas", `pro"onload="x`],
    ["quebra de linha", "pro\nmax"],
    ["acento", "básico"],
    ["URL", "https://evil.test"],
    ["nulo", null],
    ["indefinido", undefined],
    ["número", 5],
    ["objeto", { a: 1 }],
  ])("recusa %s", (_nome, entrada) => {
    expect(sanitizarPlano(entrada)).toBeNull();
  });

  it("repetido na URL (?plano=a&plano=b) vale o primeiro, se válido", () => {
    expect(sanitizarPlano(["max", "pro"])).toBe("max");
    expect(sanitizarPlano(["../x", "pro"])).toBeNull();
    expect(sanitizarPlano([])).toBeNull();
  });
});

describe("?ciclo= do site: lista fechada", () => {
  it.each([
    ["monthly", "monthly"],
    ["semiannual", "semiannual"],
    ["yearly", "yearly"],
    ["  YEARLY ", "yearly"],
  ])("aceita %j", (entrada, esperado) => {
    expect(sanitizarCiclo(entrada)).toBe(esperado);
  });

  it.each([
    ["fora da lista", "anual"],
    ["vazio", ""],
    ["prefixo da lista", "year"],
    ["tag HTML", "<script>"],
    ["caminho", "../monthly"],
    ["nulo", null],
    ["indefinido", undefined],
    ["número", 12],
    ["objeto", { a: 1 }],
    ["lista vazia", []],
  ])("ignora %s", (_nome, entrada) => {
    expect(sanitizarCiclo(entrada)).toBeNull();
  });

  it("repetido na URL vale o primeiro", () => {
    expect(sanitizarCiclo(["yearly", "monthly"])).toBe("yearly");
    expect(sanitizarCiclo(["x", "monthly"])).toBeNull();
  });
});

describe("cicloPreSelecionado: só vale se o plano escolhido vende aquele ciclo", () => {
  const TODOS = ["monthly", "semiannual", "yearly"];

  it("ciclo válido chega pré-selecionado", () => {
    expect(cicloPreSelecionado(TODOS, ["yearly"])).toBe("yearly");
    expect(cicloPreSelecionado(TODOS, ["semiannual"])).toBe("semiannual");
  });

  it("ciclo inválido é ignorado e o seguinte válido vale (URL antes do cadastro)", () => {
    expect(cicloPreSelecionado(TODOS, ["anual", "semiannual"])).toBe("semiannual");
    expect(cicloPreSelecionado(TODOS, ["anual", "<x>", 5, null])).toBeNull();
  });

  it("ausente não muda nada", () => {
    expect(cicloPreSelecionado(TODOS, [undefined, undefined])).toBeNull();
    expect(cicloPreSelecionado(TODOS, [])).toBeNull();
  });

  it("ciclo que o plano não vende é ignorado (sem preço anual no catálogo)", () => {
    expect(cicloPreSelecionado(["monthly", "semiannual"], ["yearly"])).toBeNull();
    expect(cicloPreSelecionado(["monthly", "semiannual"], ["yearly", "semiannual"])).toBe("semiannual");
  });
});
