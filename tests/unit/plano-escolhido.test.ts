import { describe, expect, it } from "vitest";

import { sanitizarPlano } from "@/lib/auth/plano-escolhido";

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
