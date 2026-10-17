/**
 * Funções puras da captação: etiquetas reservadas, união e leitura do documento.
 * O comportamento da rota inteira está em `captacao-tags-cpf-e-aviso-de-recusa.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  corpoSemDocumento,
  lerDocumentoReservado,
  lerTagsReservadas,
  mapInboundPayload,
  mesclarTags,
  parseTagsReservadas,
  removerDocumentoDoPayload,
} from "@/lib/webhooks/inbound";

describe("parseTagsReservadas", () => {
  it("aceita lista ou texto com , ou |", () => {
    expect(parseTagsReservadas(["a", " b "])).toEqual(["a", "b"]);
    expect(parseTagsReservadas("a, b | c")).toEqual(["a", "b", "c"]);
  });
  it("descarta vazio e lixo que não é texto", () => {
    expect(parseTagsReservadas(["", "  ", { x: 1 }, null, true, "ok"])).toEqual(["ok"]);
    expect(parseTagsReservadas(undefined)).toEqual([]);
    expect(parseTagsReservadas(42)).toEqual(["42"]);
  });
  it("tira repetida sem olhar a caixa, e a primeira grafia vence", () => {
    expect(parseTagsReservadas("Vip, vip, VIP, Outra")).toEqual(["Vip", "Outra"]);
  });
  it("corta em 60 caracteres e limita a 20", () => {
    expect(parseTagsReservadas("y".repeat(61))[0]).toHaveLength(60);
    const trinta = Array.from({ length: 30 }, (_, i) => `t${i}`);
    expect(parseTagsReservadas(trinta)).toEqual(trinta.slice(0, 20));
  });
});

describe("lerTagsReservadas", () => {
  it("lê tags/Tags/tags[] e junta", () => {
    expect(lerTagsReservadas({ Tags: "a", "tags[]": ["b"], nome: "x" })).toEqual(["a", "b"]);
  });
});

describe("mesclarTags", () => {
  it("une preservando as existentes e devolve só o que foi acrescentado", () => {
    expect(mesclarTags(["Cliente", "vip"], ["VIP", "Novo"])).toEqual({
      tags: ["Cliente", "vip", "Novo"],
      adicionadas: ["Novo"],
    });
  });
  it("não acrescenta nada quando tudo já existe", () => {
    expect(mesclarTags(["a"], ["A"])).toEqual({ tags: ["a"], adicionadas: [] });
  });
  it("respeita o teto de 50 do lead", () => {
    const cheio = Array.from({ length: 49 }, (_, i) => `e${i}`);
    expect(mesclarTags(cheio, ["n1", "n2"]).adicionadas).toEqual(["n1"]);
  });
});

describe("lerDocumentoReservado", () => {
  it("CPF válido, com ou sem máscara, em cpf ou cpf_cnpj", () => {
    expect(lerDocumentoReservado({ cpf: "529.982.247-25" })).toEqual({ estado: "cpf", cpf: "52998224725" });
    expect(lerDocumentoReservado({ CPF_CNPJ: "52998224725" })).toEqual({ estado: "cpf", cpf: "52998224725" });
  });
  it("número JSON recupera o zero à esquerda", () => {
    // 012.345.678-90 é um CPF válido; como número JSON chega como 1234567890.
    expect(lerDocumentoReservado({ cpf: 1234567890 })).toEqual({ estado: "cpf", cpf: "01234567890" });
  });
  it("CNPJ e dígito errado são descartados com motivo, sem devolver o valor", () => {
    expect(lerDocumentoReservado({ cpf_cnpj: "11.222.333/0001-81" })).toEqual({ estado: "descartado", motivo: "cnpj" });
    expect(lerDocumentoReservado({ cpf: "529.982.247-26" })).toEqual({ estado: "descartado", motivo: "invalido" });
  });
  it("ausente ou vazio", () => {
    expect(lerDocumentoReservado({ nome: "x" })).toEqual({ estado: "ausente" });
    expect(lerDocumentoReservado({ cpf: "  " })).toEqual({ estado: "ausente" });
  });
});

describe("removerDocumentoDoPayload / corpoSemDocumento", () => {
  it("muta o payload e regrava o corpo sem o número", () => {
    const payload: Record<string, unknown> = { nome: "Maria", cpf: "529.982.247-25", Cpf_Cnpj: "x" };
    expect(removerDocumentoDoPayload(payload)).toBe(true);
    expect(payload).toEqual({ nome: "Maria" });
    expect(corpoSemDocumento('{"nome":"Maria","cpf":"529.982.247-25"}', false, payload)).toBe('{"nome":"Maria"}');
    expect(corpoSemDocumento("nome=Maria&CPF=529.982.247-25", true, payload)).toBe("nome=Maria");
    expect(removerDocumentoDoPayload({ nome: "x" })).toBe(false);
  });
});

describe("mapInboundPayload", () => {
  it("tags e cpf nunca viram campo personalizado", () => {
    const m = mapInboundPayload({ nome: "Maria", tags: "a,b", cpf: "529.982.247-25", cpf_cnpj: "1", cidade: "X" });
    expect(m.custom_fields).toEqual({ cidade: "X" });
  });
});
