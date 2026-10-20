import { describe, expect, it } from "vitest";

import {
  agruparOpcoes,
  opcoesDeEtiqueta,
  paraBusca,
  type OpcaoDeEtiqueta,
} from "@/lib/tags/etiquetas-para-escolher";

/**
 * A lista que o editor de tags do contato (Inbox) oferece: o vocabulário da
 * organização na ORDEM em que foi cadastrado (a função de banco devolve em ordem
 * alfabética e perde essa ordem), com cor e grupo (a `descricao`).
 */

const SETTINGS = {
  tags: [
    { tag: "Google Ads", cor: "#0091ff", descricao: "Origem do lead" },
    { tag: "Indicação", cor: "#12a594", descricao: "Origem do lead" },
    { tag: "Novo Paciente", cor: "#ffb224", descricao: "Situação do paciente" },
    { tag: "Dra. Ana", cor: "#ab4aba", descricao: "Profissional parceiro" },
    { tag: "Sem grupo", cor: "#e54d2e" },
    "legada",
  ],
};

describe("opcoesDeEtiqueta", () => {
  it("mantém a ordem cadastrada, a grafia do cadastro e o grupo (descricao)", () => {
    const r = opcoesDeEtiqueta(SETTINGS, []);
    expect(r.map((o) => o.tag)).toEqual([
      "Google Ads",
      "Indicação",
      "Novo Paciente",
      "Dra. Ana",
      "Sem grupo",
      "legada",
    ]);
    expect(r[2]).toEqual({ tag: "Novo Paciente", cor: "#ffb224", grupo: "Situação do paciente" });
    expect(r[4]).toEqual({ tag: "Sem grupo", cor: "#e54d2e", grupo: null });
    // A forma antiga (string) é lida, sem cor e sem grupo.
    expect(r[5]).toEqual({ tag: "legada", cor: null, grupo: null });
  });

  it("acrescenta o que só a função de banco conhece, depois do cadastro, sem repetir por caixa", () => {
    const r = opcoesDeEtiqueta(SETTINGS, [
      { tag: "google ads", cor: null, descricao: null }, // já cadastrada: não duplica
      { tag: "vip", cor: null, descricao: null }, // em uso, fora do vocabulário
      { tag: "VIP", cor: null, descricao: null },
    ]);
    expect(r.map((o) => o.tag)).toEqual([
      "Google Ads",
      "Indicação",
      "Novo Paciente",
      "Dra. Ana",
      "Sem grupo",
      "legada",
      "vip",
    ]);
    // A entrada cadastrada vence a linha crua da função (cor e grupo preservados).
    expect(r[0]).toMatchObject({ cor: "#0091ff", grupo: "Origem do lead" });
  });

  it("empresa sem vocabulário: só o que a função devolve; sem nada, lista vazia", () => {
    expect(opcoesDeEtiqueta(null, [])).toEqual([]);
    expect(opcoesDeEtiqueta({}, [])).toEqual([]);
    expect(opcoesDeEtiqueta({ tags: "lixo" }, [])).toEqual([]);
    expect(opcoesDeEtiqueta({}, [{ tag: "vip", cor: null, descricao: null }])).toEqual([
      { tag: "vip", cor: null, grupo: null },
    ]);
  });

  it("cor malformada vira 'sem cor', e entrada sem nome é ignorada", () => {
    const r = opcoesDeEtiqueta(
      { tags: [{ tag: "A", cor: "verde" }, { tag: "  " }, { cor: "#fff" }, 7, null] },
      [],
    );
    expect(r).toEqual([{ tag: "A", cor: null, grupo: null }]);
  });
});

const OPCOES: OpcaoDeEtiqueta[] = opcoesDeEtiqueta(SETTINGS, []);

describe("agruparOpcoes", () => {
  it("agrupa pelo grupo na ordem cadastrada e manda o que não tem grupo para o fim", () => {
    const grupos = agruparOpcoes(OPCOES, "");
    expect(grupos.map((g) => g.grupo)).toEqual([
      "Origem do lead",
      "Situação do paciente",
      "Profissional parceiro",
      null,
    ]);
    expect(grupos[0]!.opcoes.map((o) => o.tag)).toEqual(["Google Ads", "Indicação"]);
    expect(grupos[3]!.opcoes.map((o) => o.tag)).toEqual(["Sem grupo", "legada"]);
  });

  it("a busca ignora acento e caixa, e grupo sem resultado some", () => {
    expect(paraBusca("  INDICAÇÃO ")).toBe("indicacao");
    const grupos = agruparOpcoes(OPCOES, "indicacao");
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.opcoes.map((o) => o.tag)).toEqual(["Indicação"]);
    expect(agruparOpcoes(OPCOES, "zzz")).toEqual([]);
  });

  it("grupos que só diferem na caixa são um grupo só", () => {
    const grupos = agruparOpcoes(
      [
        { tag: "a", cor: null, grupo: "Origem" },
        { tag: "b", cor: null, grupo: "origem" },
      ],
      "",
    );
    expect(grupos).toHaveLength(1);
    expect(grupos[0]!.opcoes).toHaveLength(2);
  });
});
