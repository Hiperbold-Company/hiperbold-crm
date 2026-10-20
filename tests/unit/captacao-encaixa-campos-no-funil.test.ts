/**
 * O encaixe puro dos campos da captação nos campos do funil (`lib/webhooks/encaixar-campos.ts`).
 * O caso real que o originou (CBEXS): o n8n manda `Empresa`, `Cargo` e `utm_*` com o RÓTULO, e o funil
 * declara `empresa`, `cargo` ("Cargo / Posição") e `utm_source`; a ficha lê pela `key`.
 */
import { describe, expect, it } from "vitest";

import { encaixarCamposNoFunil, normalizarChaveDeCampo } from "@/lib/webhooks/encaixar-campos";

const FUNIL = [
  { key: "empresa", label: "Empresa" },
  { key: "cargo", label: "Cargo / Posição" },
  { key: "nivel_academico", label: "Nível acadêmico" },
  { key: "uf", label: "UF" },
  { key: "utm_source", label: "utm_source" },
  { key: "utm_campaign", label: "utm_campaign" },
  { key: "origem_url", label: "Origem (página de cadastro)" },
];

const encaixar = (campos: Record<string, unknown>, rastreamento: Record<string, unknown> = {}, funil = FUNIL) =>
  encaixarCamposNoFunil({ campos, rastreamento, funil });

describe("normalizarChaveDeCampo", () => {
  it("tira acento e caixa e iguala espaço, underscore e hífen", () => {
    expect(normalizarChaveDeCampo("Nível Acadêmico")).toBe("nivel_academico");
    expect(normalizarChaveDeCampo("nivel-academico")).toBe("nivel_academico");
    expect(normalizarChaveDeCampo("  NIVEL__ACADEMICO ")).toBe("nivel_academico");
  });
});

describe("encaixarCamposNoFunil", () => {
  it("chave igual à key do campo fica onde está", () => {
    const r = encaixar({ empresa: "Hiperbold" });
    expect(r.custom_fields).toEqual({ empresa: "Hiperbold" });
    expect(r.movidos).toBe(0);
  });

  it("rótulo igual ao label do campo vai para a key (o caso Empresa da CBEXS)", () => {
    const r = encaixar({ Empresa: "Hiperbold" });
    expect(r.custom_fields).toEqual({ empresa: "Hiperbold" });
    expect(r.movidos).toBe(1);
  });

  it("casa sem diferenciar caixa, acento, espaço, underscore e hífen", () => {
    expect(encaixar({ "NIVEL ACADEMICO": "Mestrado" }).custom_fields).toEqual({ nivel_academico: "Mestrado" });
    expect(encaixar({ "Nível Acadêmico": "Mestrado" }).custom_fields).toEqual({ nivel_academico: "Mestrado" });
    expect(encaixar({ "nivel-academico": "Mestrado" }).custom_fields).toEqual({ nivel_academico: "Mestrado" });
    expect(encaixar({ Uf: "MG" }).custom_fields).toEqual({ uf: "MG" });
  });

  it('aceita o rótulo antes de " / " ("Cargo" casa com "Cargo / Posição")', () => {
    expect(encaixar({ Cargo: "Diretor" }).custom_fields).toEqual({ cargo: "Diretor" });
    expect(encaixar({ "cargo / posição": "Diretor" }).custom_fields).toEqual({ cargo: "Diretor" });
  });

  it("o corpo inteiro do n8n: Empresa e Cargo encaixam, o campo sem correspondente fica como veio", () => {
    const r = encaixar({ Empresa: "Hiperbold", Cargo: "Diretor", Hobby: "xadrez" });
    expect(r.custom_fields).toEqual({ empresa: "Hiperbold", cargo: "Diretor", Hobby: "xadrez" });
  });

  it("campo inexistente no funil mantém a chave (não perde dado)", () => {
    expect(encaixar({ Hobby: "xadrez" }).custom_fields).toEqual({ Hobby: "xadrez" });
    expect(encaixar({ Hobby: "xadrez" }, {}, []).custom_fields).toEqual({ Hobby: "xadrez" });
  });

  it("UTM com campo declarado: vai para custom_fields na key do campo", () => {
    const r = encaixar({}, { utm_source: "teste", utm_campaign: "x" });
    expect(r.custom_fields).toEqual({ utm_source: "teste", utm_campaign: "x" });
    expect(r.rastreamentoCopiado).toBe(2);
  });

  it("UTM sem campo declarado: não entra em custom_fields", () => {
    const r = encaixar({}, { utm_medium: "cpc", utm_source: "teste" });
    expect(r.custom_fields).toEqual({ utm_source: "teste" });
  });

  it("id de clique entra quando o funil declara o campo; origem que não é rastreamento nunca entra", () => {
    const funil = [...FUNIL, { key: "gclid", label: "gclid" }];
    const r = encaixar({}, { gclid: "abc", webhook_source_id: "x", raw_phone: "11" }, funil);
    expect(r.custom_fields).toEqual({ gclid: "abc" });
  });

  it("UTM não sobrescreve o que o envio já trouxe no campo", () => {
    const r = encaixar({ utm_source: "do-corpo" }, { utm_source: "da-origem" });
    expect(r.custom_fields).toEqual({ utm_source: "do-corpo" });
    expect(r.rastreamentoCopiado).toBe(0);
  });

  it("valor vazio não é encaixado (e não ocupa o campo)", () => {
    const r = encaixar({ Empresa: "", Cargo: "  " }, { utm_source: "" });
    expect(r.custom_fields).toEqual({ Empresa: "", Cargo: "  " });
    expect(r.movidos).toBe(0);
    expect(r.rastreamentoCopiado).toBe(0);
  });

  it("valor vazio na key do campo cede o lugar ao valor da chave crua", () => {
    const r = encaixar({ empresa: "", Empresa: "Hiperbold" });
    expect(r.custom_fields).toEqual({ empresa: "Hiperbold" });
  });

  it("nunca sobrescreve: campo já preenchido, a chave crua fica como veio", () => {
    const r = encaixar({ empresa: "Primeira", Empresa: "Segunda" });
    expect(r.custom_fields).toEqual({ empresa: "Primeira", Empresa: "Segunda" });
    expect(r.movidos).toBe(0);
  });

  it("duas chaves cruas para o mesmo campo: a de casamento mais forte ocupa, a outra fica", () => {
    // "Cargo" casa com a key (normalizada); "Cargo / Posição" só com o rótulo: a key é mais forte.
    const r = encaixar({ "Cargo / Posição": "por-rotulo", Cargo: "por-key" });
    expect(r.custom_fields).toEqual({ cargo: "por-key", "Cargo / Posição": "por-rotulo" });
  });

  it("casamento ambíguo (dois campos servem) mantém a chave", () => {
    const funil = [
      { key: "cargo_atual", label: "Cargo / Atual" },
      { key: "cargo_desejado", label: "Cargo / Desejado" },
    ];
    expect(encaixar({ Cargo: "Diretor" }, {}, funil).custom_fields).toEqual({ Cargo: "Diretor" });
  });

  it("a key vence o rótulo de outro campo", () => {
    const funil = [
      { key: "a", label: "Cidade" },
      { key: "cidade", label: "Município" },
    ];
    expect(encaixar({ Cidade: "BH" }, {}, funil).custom_fields).toEqual({ cidade: "BH" });
  });

  it("chave reservada nunca é encaixada, mesmo que o funil tenha campo com o rótulo", () => {
    const funil = [
      { key: "contato", label: "Nome" },
      { key: "mail", label: "E-mail" },
    ];
    const r = encaixar({ Nome: "Maria", "E-mail": "m@x.com", data_nascimento: "2000-01-01" }, {}, funil);
    expect(r.custom_fields).toEqual({ Nome: "Maria", "E-mail": "m@x.com", data_nascimento: "2000-01-01" });
  });

  it("valores que não são texto passam intactos", () => {
    const r = encaixar({ Empresa: 10, extra: true });
    expect(r.custom_fields).toEqual({ empresa: 10, extra: true });
  });

  it("não muta a entrada", () => {
    const campos = { Empresa: "Hiperbold" };
    const rast = { utm_source: "x" };
    encaixarCamposNoFunil({ campos, rastreamento: rast, funil: FUNIL });
    expect(campos).toEqual({ Empresa: "Hiperbold" });
    expect(rast).toEqual({ utm_source: "x" });
  });

  it("é idempotente: rodar sobre o resultado não muda nada", () => {
    const primeira = encaixar({ Empresa: "Hiperbold", Cargo: "Diretor", Hobby: "x" }, { utm_source: "t" });
    const segunda = encaixar(primeira.custom_fields, { utm_source: "t" });
    expect(segunda.custom_fields).toEqual(primeira.custom_fields);
    expect(segunda.movidos).toBe(0);
    expect(segunda.rastreamentoCopiado).toBe(0);
  });
});
