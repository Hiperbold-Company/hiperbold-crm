import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 1006 (D-092, 3a parte, fork Hiperbold): a sessão sem o segundo fator também não lê o dado da
 * empresa. Este arquivo cobre a FORMA: migration e baseline dizem a mesma coisa, o bloco é o ÚLTIMO do
 * baseline (a varredura do catálogo só alcança tabela que já existe), está no MANIFEST, não cria função e
 * é reaplicável com o app no ar. O COMPORTAMENTO (aal1 com fator lê vazio, aal2 lê tudo, login segue) é
 * provado por `tests/invariants/sessao-aal1-nao-le-dado-da-empresa.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");
const ARQUIVO = "20261111120000_1006_mfa_prova_na_leitura.sql";
const migration = readFileSync(join(process.cwd(), "supabase/migrations", ARQUIVO), "utf8");

function codigo(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

const MARCADOR = /^-- ---- .*\(migration 1006, fork Hiperbold[^\n]*$/m;
const marcador = BASELINE.match(MARCADOR)?.[0] ?? "";
const inicio = BASELINE.lastIndexOf(marcador);
const bloco = BASELINE.slice(inicio);
const c = codigo(migration);

describe("1006: posição, igualdade e registro", () => {
  it("o bloco existe uma vez e é o último do baseline (depois de toda tabela e das travas de suporte)", () => {
    expect(marcador, "bloco da 1006 não está no baseline").not.toBe("");
    expect(BASELINE.split(marcador).length - 1).toBe(1);
    expect(bloco.indexOf("\n-- ---- ", 1)).toBe(-1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf("perform public.fn_aplicar_travas_de_suporte();"));
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf("create table"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(bloco)).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`1006_mfa_prova_na_leitura`");
  });

  it("nenhuma linha da migration nem do bloco usa travessão (U+2014)", () => {
    const travessao = String.fromCharCode(0x2014);
    for (const texto of [migration, bloco]) {
      expect(texto.split("\n").filter((linha) => linha.includes(travessao))).toEqual([]);
    }
  });
});

describe("1006: o que ela faz, e a reaplicação com o app no ar", () => {
  it("não derruba nem trava a tabela: sem drop, alter table, create table, nem função nova, nem grant", () => {
    expect(c).not.toMatch(/drop |alter table|create table|create or replace function|create function|grant |revoke /i);
  });

  it("lock_timeout curto, política só criada se não existir, uma subtransação por tabela", () => {
    expect(c).toContain("perform set_config('lock_timeout', '3s', true);");
    expect(c).toContain("p.polname = 'sessao_com_prova_de_mfa'");
    expect(c).toMatch(/exception when lock_not_available then/);
  });

  it("RESTRICTIVE for all, só authenticated, pela ponte da 0918 em initplan, nos dois lados", () => {
    expect(c).toContain("as restrictive for all to authenticated");
    expect(c).toContain(
      "using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))",
    );
  });

  it("varre o catálogo: tabela de public com RLS e organization_id, deixando fora as duas do login e as só do servidor", () => {
    expect(c).toContain("n.nspname = 'public'");
    expect(c).toContain("c.relrowsecurity");
    expect(c).toContain("a.attname = 'organization_id'");
    expect(c).toContain("c.relname not in ('organizations', 'user_organizations')");
    expect(c).toContain("p.polpermissive");
    expect(migration).toContain("FICAM DE FORA");
  });

  it("a ponte da 0918 existe no baseline ANTES do bloco que a usa", () => {
    const ponte = BASELINE.indexOf("create or replace function public.fn_session_mfa_proven_rls()");
    expect(ponte).toBeGreaterThan(-1);
    expect(ponte).toBeLessThan(inicio);
  });
});
