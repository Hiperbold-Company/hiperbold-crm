/**
 * A 1015 chega a quem instala: o apêndice do baseline é ESPELHO EXATO da migration (o kit self-host
 * aplica só o baseline), ele fica ANTES das travas de suporte, da trava de MFA na leitura e da
 * varredura de pg_temp, e toda função nova revoga EXECUTE de public e anon.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const migration = readFileSync(
  join(RAIZ, "supabase/migrations/20261117100000_1015_campos_personalizados_da_organizacao.sql"),
  "utf8",
);
const baseline = readFileSync(join(RAIZ, "supabase/baseline.sql"), "utf8");

describe("migration 1015 — campos personalizados da organização", () => {
  it("o conteúdo da migration aparece no baseline sem uma única diferença", () => {
    expect(migration.length).toBeGreaterThan(5000);
    expect(baseline.includes(migration)).toBe(true);
  });

  it("o apêndice fica antes da varredura anon, do 0998, da trava de MFA (1006) e da varredura de pg_temp (1008)", () => {
    const aqui = baseline.indexOf(migration);
    expect(aqui).toBeLessThan(baseline.indexOf("-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116)"));
    expect(aqui).toBeLessThan(baseline.indexOf("-- ---- grants por coluna reaplicados no fim (migration 0998"));
    expect(aqui).toBeLessThan(baseline.indexOf("-- ---- a sessão sem o segundo fator também não lê o dado da empresa (migration 1006"));
    expect(aqui).toBeLessThan(baseline.lastIndexOf("do $hb_1008_definer_pg_temp$"));
  });

  it("toda função criada revoga EXECUTE de public e anon e nasce com pg_temp no search_path", () => {
    const funcoes = [...new Set([...migration.matchAll(/^create or replace function public\.(\w+)\(/gm)].map((m) => m[1]))];
    expect(funcoes.length).toBe(7);
    for (const f of funcoes) {
      expect(migration).toMatch(new RegExp(`revoke execute on function public\\.${f}\\([^)]*\\) from public, anon`));
    }
    expect((migration.match(/^set search_path = public, pg_temp$/gm) ?? []).length).toBe(funcoes.length);
  });

  it("sem BEGIN/COMMIT e sem tabela temporária (portável em psql puro)", () => {
    expect(migration).not.toMatch(/^\s*(begin|commit)\s*;/im);
    expect(migration).not.toMatch(/create\s+temp(orary)?\s+table/i);
  });

  it("type é text + CHECK (não enum) e RLS segue o nome da casa", () => {
    expect(migration).toMatch(/custom_field_definitions_type_check/);
    expect(migration).not.toMatch(/create type/i);
    expect(migration).toMatch(/create policy tenant_isolation_custom_field_definitions_all/);
  });
});
