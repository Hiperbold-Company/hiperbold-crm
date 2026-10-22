import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0976 (filhas e escrita de negócios sem custo por linha). Este arquivo cobre a FORMA:
 * migration e bloco do baseline dizem a mesma coisa, depois da 0975 e antes da VARREDURA anon,
 * registrada no MANIFEST. O COMPORTAMENTO em banco é provado por
 * `tests/invariants/filhas-e-escrita-sem-custo-por-linha.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");
const ARQUIVO = "20261022100000_0976_filhas_e_escrita_de_negocios_sem_custo_por_linha.sql";
const MIGRATION = readFileSync(join(process.cwd(), "supabase/migrations", ARQUIVO), "utf8");

function codigo(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

const marcador = BASELINE.match(/^-- ---- .*\(migration 0976, fork Hiperbold\) ----$/m)?.[0] ?? "";
const inicio = BASELINE.indexOf(marcador);
const bloco = BASELINE.slice(inicio, BASELINE.indexOf("\n-- ---- ", inicio + marcador.length) + 1);

describe("0976: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0975 e antes da VARREDURA anon", () => {
    expect(marcador).not.toBe("");
    expect(BASELINE.split(marcador).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf("(migration 0975, fork Hiperbold)"));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(bloco)).toBe(codigo(MIGRATION));
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0976_filhas_e_escrita_de_negocios_sem_custo_por_linha`");
  });

  it("16 policies restritivas com o atalho na frente; escrita de crm_leads sem fn_role_at_least por linha", () => {
    const c = codigo(MIGRATION);
    const filhas = c.match(/create policy visibilidade_por_atendente on public\.\w+ as restrictive for select using \(\(organization_id in \(select public\.fn_orgs_com_visao_total\(\)\) or public\.fn_registro_filho_visivel\(/g) ?? [];
    expect(filhas.length).toBe(16);
    expect(c).not.toMatch(/fn_role_at_least\(organization_id/);
    expect((c.match(/create policy "crm_leads_(insert|update|delete)"/g) ?? []).length).toBe(3);
    expect(c).not.toMatch(/create (or replace )?function/);
  });

  it("sem travessão, lock_timeout curto e nada que reescreva ou apague linha", () => {
    expect(MIGRATION.includes(String.fromCharCode(0x2014))).toBe(false);
    const c = codigo(MIGRATION);
    expect((c.match(/set_config\('lock_timeout','3s',true\)/g) ?? []).length).toBe(17);
    expect(c).not.toMatch(/drop table|drop function|alter table public\.\w|delete from|truncate table|update public\./);
    expect(c).not.toMatch(/drop policy (?!if exists)/);
  });
});
