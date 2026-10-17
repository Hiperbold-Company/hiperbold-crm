/**
 * D-092 (migration 0918, fork Hiperbold): sessão sem o segundo fator não grava em
 * `api_tokens` nem em `user_organizations`.
 *
 * A RLS não olhava o nível da sessão (`aal`). Com a senha de um admin com TOTP e a
 * chave pública do projeto, dava para inserir pelo PostgREST o hash de uma chave de
 * API escolhida (acesso que sobrevive à troca de senha) e, sendo admin de plataforma,
 * inserir a si mesmo em `user_organizations` como admin de qualquer empresa. Aqui se
 * prova no Postgres real, como `authenticated`, com o `aal` no JWT:
 *
 *   1. admin de plataforma full com fator, aal1: não se insere em `user_organizations`;
 *      com aal2 insere (controle positivo);
 *   2. a ponte `fn_session_mfa_proven_rls` não é executável por `anon`.
 *
 * A metade de `api_tokens` desta prova ficou obsoleta com a 0962: `authenticated`
 * perdeu TODO privilégio na tabela (só o servidor escreve), então não há mais o
 * "controle positivo" de um admin com aal2 inserindo. O que protege `api_tokens`
 * agora, com controle próprio, é `tests/invariants/api-tokens-so-o-servidor-escreve.test.ts`.
 *
 * Roda via `pnpm test:db tests/invariants/sessao-aal1-nao-grava-token-e-vinculo.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "09180001-a5aa-4000-8000-000000000001";
const ALVO_ORG = "09180001-a5aa-4000-8000-000000000002";
const PLATAFORMA = "09180001-b0b0-4000-8000-000000000003";
const FATOR_PLATAFORMA = "09180001-f0f0-4000-8000-000000000002";

/** Roda `corpo` como `authenticated`, com o JWT do usuário no nível `aal` dado. */
function como(usuario: string, aal: "aal1" | "aal2", corpo: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"${aal}"}', false);
    ${corpo}
  `);
}

function recusadoPorRls(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${PLATAFORMA}', 'plataforma-0918@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'mfa-0918-a', 'MFA 0918 A', 'MFA 0918 A'),
      ('${ALVO_ORG}', 'mfa-0918-b', 'MFA 0918 B', 'MFA 0918 B')
      on conflict (id) do nothing;

    insert into public.platform_admins (user_id, granted_by, scope, reason) values
      ('${PLATAFORMA}', '${PLATAFORMA}', 'full', 'invariante 0918')
      on conflict (user_id) do nothing;

    insert into auth.mfa_factors (id, user_id, status, factor_type) values
      ('${FATOR_PLATAFORMA}', '${PLATAFORMA}', 'verified', 'totp')
      on conflict (id) do nothing;
  `);
});

describe("user_organizations: a auto-inserção como admin exige a prova da sessão", () => {
  const entrar = (aal: "aal1" | "aal2") =>
    como(
      PLATAFORMA,
      aal,
      `insert into public.user_organizations (user_id, organization_id, role, accepted_at)
       values ('${PLATAFORMA}', '${ALVO_ORG}', 'admin', now()) returning role;`,
    );

  it("⭐ admin de plataforma com fator e sessão aal1 não se insere como admin de uma empresa", () => {
    const motivo = recusadoPorRls(() => entrar("aal1"));
    expect(motivo, "a sessão aal1 se inseriu como admin de uma empresa").toContain("row-level security");
    expect(
      sql(`select count(*) from public.user_organizations where user_id = '${PLATAFORMA}'::uuid and organization_id = '${ALVO_ORG}'::uuid;`),
    ).toBe("0");
  });

  it("CONTROLE POSITIVO: com aal2 o mesmo caminho insere", () => {
    expect(entrar("aal2")).toContain("admin");
  });
});

describe("a ponte da prova", () => {
  it("anon não executa fn_session_mfa_proven_rls", () => {
    const motivo = recusadoPorRls(() =>
      sql(`set role anon; select public.fn_session_mfa_proven_rls();`),
    );
    expect(motivo).toContain("permission denied");
  });
});
