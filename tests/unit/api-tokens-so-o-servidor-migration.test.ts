import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0962 (fork Hiperbold, auditoria de 17/10/2026): `api_tokens` só é
 * escrita pelo servidor. Este arquivo cobre a FORMA: migration e baseline dizem a
 * mesma coisa, no lugar certo (antes da VARREDURA anon, uma vez só, depois do bloco
 * anterior), registrada no MANIFEST, reaplicável com o app no ar, sem BEGIN/COMMIT.
 * O COMPORTAMENTO em banco (authenticated e anon sem privilégio nenhum; com o grant
 * de volta, a RLS barra plataforma, outra organização e created_by alheio) é provado
 * por `tests/invariants/api-tokens-so-o-servidor-escreve.test.ts` (`pnpm test:db`).
 */

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase/migrations/20261017120000_0962_api_tokens_so_o_servidor_escreve.sql"),
  "utf8",
);
const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const MARCADOR_0961 = "-- ---- batimentos dos serviços de fundo (migration 0961";
const MARCADOR_0962 = "-- ---- api_tokens: só o servidor escreve (migration 0962";

function extraiBloco(marcador: string): string {
  const inicio = BASELINE.lastIndexOf(marcador);
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + marcador.length);
  return BASELINE.slice(inicio, fim + 1);
}

function semComentariosEBrancas(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

describe("0962: posição e igualdade", () => {
  it("o bloco do baseline vem depois do da 0961 e antes da VARREDURA anon, uma vez só", () => {
    const inicio0961 = BASELINE.lastIndexOf(MARCADOR_0961);
    const inicio0962 = BASELINE.lastIndexOf(MARCADOR_0962);
    const varreduraAnon = BASELINE.lastIndexOf("-- ---- VARREDURA anon:");
    expect(inicio0961).toBeGreaterThan(-1);
    expect(inicio0962).toBeGreaterThan(inicio0961);
    expect(inicio0962).toBeLessThan(varreduraAnon);
    expect(BASELINE.split(MARCADOR_0962).length - 1).toBe(1);
  });

  it("o SQL da migração e o do bloco do baseline são iguais, ignorando comentários e linhas em branco", () => {
    expect(semComentariosEBrancas(extraiBloco(MARCADOR_0962))).toBe(semComentariosEBrancas(MIGRATION));
  });

  it("está registrada no MANIFEST, depois da 0961", () => {
    expect(MANIFEST).toMatch(/\| `20261017120000` \| `0962_api_tokens_so_o_servidor_escreve` \|/);
    expect(MANIFEST.indexOf("`0961_batimentos")).toBeLessThan(MANIFEST.indexOf("`0962_api_tokens"));
  });

  it("nenhuma linha da migração nem do bloco usa travessão (U+2014)", () => {
    const travessao = String.fromCharCode(0x2014);
    for (const texto of [MIGRATION, extraiBloco(MARCADOR_0962)]) {
      expect(texto.split("\n").filter((linha) => linha.includes(travessao))).toEqual([]);
    }
  });
});

for (const [nome, sql] of [
  ["migração", MIGRATION],
  ["bloco do baseline", extraiBloco(MARCADOR_0962)],
] as const) {
  describe(`0962: o que a ${nome} faz`, () => {
    const codigo = semComentariosEBrancas(sql);

    it("sem BEGIN/COMMIT (o runner já envolve em transação) e sem derrubar a tabela", () => {
      expect(codigo).not.toMatch(/\bbegin\s*;|\bcommit\s*;|drop policy|drop table|alter table|delete from|truncate/i);
    });

    it("tira TODO privilégio de authenticated e anon, e não toca no service_role", () => {
      expect(codigo).toMatch(/revoke all on public\.api_tokens from public, anon, authenticated;/);
      expect(codigo).not.toMatch(/service_role/);
      expect(codigo).not.toMatch(/\bgrant\b/i);
    });

    it("troca a policy por alter policy (atômico), com lock_timeout curto, e cria só se faltar", () => {
      expect(codigo).toMatch(/set lock_timeout = '3s';/);
      expect(codigo).toMatch(/alter policy api_tokens_admin_only on public\.api_tokens/);
      expect(codigo).toMatch(/else\s+create policy api_tokens_admin_only on public\.api_tokens/);
    });

    it("a policy nova não tem ramo de plataforma: ler = admin; escrever = admin e created_by = auth.uid()", () => {
      expect(codigo).not.toMatch(/platform_admin/);
      const usos = codigo.match(/using \(public\.fn_role_at_least\(organization_id, 'admin'\)\)/g);
      expect(usos).toHaveLength(2);
      const checks = codigo.match(
        /with check \(public\.fn_role_at_least\(organization_id, 'admin'\) and created_by = \(select auth\.uid\(\)\)\)/g,
      );
      expect(checks).toHaveLength(2);
    });

    it("não cria função (nada a revogar de PUBLIC/anon)", () => {
      expect(codigo).not.toMatch(/create (or replace )?function/i);
    });
  });
}
