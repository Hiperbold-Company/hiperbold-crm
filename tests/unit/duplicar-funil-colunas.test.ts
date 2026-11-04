/**
 * Toda coluna de `crm_stages` tem de estar CLASSIFICADA em `COLUNAS_DA_ETAPA` (`lib/pipelines/duplicar.ts`).
 *
 * Coluna nova de configuração da etapa que ninguém classificou faria o "Duplicar funil" entregar a cópia com
 * o default do banco, em silêncio. Este teste lê o DDL que o self-host aplica (`supabase/baseline.sql`: o
 * CREATE TABLE e todo `add column` do apêndice) e reprova a coluna sem classificação.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COLUNAS_DA_ETAPA } from "@/lib/pipelines/duplicar";

function colunasDoBaseline(): string[] {
  const sql = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
  const create = /CREATE TABLE IF NOT EXISTS "public"\."crm_stages" \(([\s\S]*?)\n\);/.exec(sql);
  if (!create) throw new Error("CREATE TABLE de crm_stages não encontrado no baseline");
  const doCreate = [...create[1]!.matchAll(/^\s+"(\w+)"\s/gm)].map((m) => m[1]!);
  const doApendice = [
    ...sql.matchAll(/alter table (?:if exists )?(?:only )?"?public"?\."?crm_stages"?\s+add column (?:if not exists )?"?(\w+)"?/gi),
  ].map((m) => m[1]!);
  return [...new Set([...doCreate, ...doApendice])];
}

describe("COLUNAS_DA_ETAPA cobre o DDL de crm_stages", () => {
  it("toda coluna do baseline está em COPIA ou em NAO_COPIA", () => {
    const classificadas = new Set<string>([...COLUNAS_DA_ETAPA.COPIA, ...COLUNAS_DA_ETAPA.NAO_COPIA]);
    const colunas = colunasDoBaseline();
    expect(colunas.length).toBeGreaterThan(15);
    expect(colunas.filter((c) => !classificadas.has(c))).toEqual([]);
  });

  it("nenhuma coluna classificada é fantasma, e nenhuma está nas duas listas", () => {
    const colunas = new Set(colunasDoBaseline());
    const todas = [...COLUNAS_DA_ETAPA.COPIA, ...COLUNAS_DA_ETAPA.NAO_COPIA];
    expect(todas.filter((c) => !colunas.has(c))).toEqual([]);
    expect(COLUNAS_DA_ETAPA.COPIA.filter((c) => (COLUNAS_DA_ETAPA.NAO_COPIA as readonly string[]).includes(c))).toEqual([]);
  });
});
