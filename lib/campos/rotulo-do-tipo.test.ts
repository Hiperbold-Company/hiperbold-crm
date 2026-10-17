import { describe, expect, it } from "vitest";

import { PAPEIS_HUMANOS, ROTULO_DO_PAPEL, rotuloDoPapel } from "@/lib/auth/types";
import { customFieldSchema } from "@/lib/schemas/settings";

import { ROTULO_DO_TIPO_DE_CAMPO, rotuloDoTipoDeCampo } from "./rotulo-do-tipo";

describe("rótulo dos tipos de campo personalizado", () => {
  it("cobre exatamente os tipos que o schema aceita", () => {
    expect(Object.keys(ROTULO_DO_TIPO_DE_CAMPO).sort()).toEqual(
      [...customFieldSchema.shape.type.options].sort(),
    );
  });

  it("traduz para português, sem valor técnico cru na tela", () => {
    expect(rotuloDoTipoDeCampo("text")).toBe("Texto");
    expect(rotuloDoTipoDeCampo("number")).toBe("Número");
    expect(rotuloDoTipoDeCampo("date")).toBe("Data");
    expect(rotuloDoTipoDeCampo("select")).toBe("Lista de opções");
    expect(rotuloDoTipoDeCampo("boolean")).toBe("Sim ou não");
    for (const rotulo of Object.values(ROTULO_DO_TIPO_DE_CAMPO)) {
      expect(rotulo).not.toMatch(/^(text|textarea|number|date|select|multiselect|boolean|email|phone|url)$/);
    }
  });

  it("não há dois tipos com o mesmo rótulo", () => {
    const rotulos = Object.values(ROTULO_DO_TIPO_DE_CAMPO);
    expect(new Set(rotulos).size).toBe(rotulos.length);
  });

  it("valor desconhecido volta como veio, e vazio vira texto vazio", () => {
    expect(rotuloDoTipoDeCampo("tipo_novo")).toBe("tipo_novo");
    expect(rotuloDoTipoDeCampo("toString")).toBe("toString");
    expect(rotuloDoTipoDeCampo("")).toBe("");
    expect(rotuloDoTipoDeCampo(null)).toBe("");
  });
});

describe("rótulo dos papéis da equipe", () => {
  it("traduz os quatro papéis humanos", () => {
    expect(rotuloDoPapel("viewer")).toBe("Visualizador");
    expect(rotuloDoPapel("agent")).toBe("Atendente");
    expect(rotuloDoPapel("manager")).toBe("Gerente");
    expect(rotuloDoPapel("admin")).toBe("Administrador");
  });

  it("todo papel humano tem rótulo diferente do valor gravado", () => {
    for (const papel of PAPEIS_HUMANOS) {
      expect(rotuloDoPapel(papel)).toBe(ROTULO_DO_PAPEL[papel]);
      expect(rotuloDoPapel(papel)).not.toBe(papel);
    }
  });

  it("valor desconhecido volta como veio, e vazio vira texto vazio", () => {
    expect(rotuloDoPapel("superuser")).toBe("superuser");
    expect(rotuloDoPapel("constructor")).toBe("constructor");
    expect(rotuloDoPapel(null)).toBe("");
    expect(rotuloDoPapel(undefined)).toBe("");
  });
});
