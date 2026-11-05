import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ajustarAoSchema, remapearIds } from "./duplicar";

const troca = new Map([
  ["velho-1", "novo-1"],
  ["velho-2", "novo-2"],
]);

describe("remapearIds", () => {
  it("troca o id em qualquer profundidade, inclusive em chave que ninguém conhece", () => {
    const r = remapearIds(
      { a: "velho-1", b: { c: ["velho-2", "outro"], d: { e: "velho-1" } }, n: 3, nulo: null, flag: true },
      troca,
    );
    expect(r.valor).toEqual({ a: "novo-1", b: { c: ["novo-2", "outro"], d: { e: "novo-1" } }, n: 3, nulo: null, flag: true });
    expect(r.chavesRemovidas).toEqual([]);
  });

  it("id que não mapeia (etapa arquivada) sai do array e a chave sai do objeto", () => {
    const r = remapearIds({ lista: ["velho-1", "arq"], alvo: { stage_id: "arq", outro: 1 } }, troca, new Set(["arq"]));
    expect(r.valor).toEqual({ lista: ["novo-1"], alvo: { outro: 1 } });
    expect(r.chavesRemovidas).toEqual([["alvo", "stage_id"]]);
  });

  it("id de etapa de OUTRO funil (fora da troca e de `remover`) fica intacto", () => {
    // `troca` só tem as etapas da origem; um atalho para a etapa de outro funil continua apontando para ela.
    const r = remapearIds(
      { atalho: "etapa-do-outro-funil", lista: ["velho-1", "etapa-do-outro-funil"] },
      troca,
      new Set(["arq"]),
    );
    expect(r.valor).toEqual({ atalho: "etapa-do-outro-funil", lista: ["novo-1", "etapa-do-outro-funil"] });
    expect(r.chavesRemovidas).toEqual([]);
  });

  it("não muta a entrada", () => {
    const entrada = { a: ["velho-1"] };
    remapearIds(entrada, troca);
    expect(entrada).toEqual({ a: ["velho-1"] });
  });
});

describe("ajustarAoSchema", () => {
  it("campo que aceita AUSÊNCIA: a chave removida continua fora", () => {
    const schema = z.object({ alvo: z.object({ stage_id: z.string().nullable().optional() }).optional() });
    const r = remapearIds({ alvo: { stage_id: "arq" } }, troca, new Set(["arq"]));
    expect(ajustarAoSchema(r.valor as Record<string, unknown>, r.chavesRemovidas, schema)).toEqual({ alvo: {} });
  });

  it("campo que EXIGE valor: a chave removida volta como null", () => {
    const schema = z.object({ alvo: z.object({ stage_id: z.string().nullable() }) });
    const r = remapearIds({ alvo: { stage_id: "arq", x: 1 } }, troca, new Set(["arq"]));
    expect(ajustarAoSchema(r.valor as Record<string, unknown>, r.chavesRemovidas, schema)).toEqual({
      alvo: { stage_id: null, x: 1 },
    });
  });

  it("erro de schema FORA das chaves removidas não muda nada (settings legado não é 'consertado')", () => {
    const schema = z.object({ legado: z.number(), alvo: z.object({ stage_id: z.string().optional() }) });
    const r = remapearIds({ legado: "texto", alvo: { stage_id: "arq" } }, troca, new Set(["arq"]));
    expect(ajustarAoSchema(r.valor as Record<string, unknown>, r.chavesRemovidas, schema)).toEqual({
      legado: "texto",
      alvo: {},
    });
  });

  it("com o schema real do funil: id arquivado em obrigatorio_em.etapas sai, e o settings segue válido", () => {
    const r = remapearIds(
      { fields: [{ key: "k", label: "K", type: "text", obrigatorio_em: { etapas: ["arq"] } }] },
      troca,
      new Set(["arq"]),
    );
    expect(ajustarAoSchema(r.valor as Record<string, unknown>, r.chavesRemovidas)).toEqual({
      fields: [{ key: "k", label: "K", type: "text", obrigatorio_em: { etapas: [] } }],
    });
  });
});
