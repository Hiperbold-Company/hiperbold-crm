/**
 * Migration 0962 (fork Hiperbold, auditoria de 17/10/2026): `api_tokens` só é
 * escrita pelo servidor.
 *
 * O defeito. A policy `api_tokens_admin_only` aceitava o admin da organização OU
 * qualquer linha de `platform_admins` (sem olhar o escopo), e `authenticated` tinha
 * GRANT ALL na tabela. Pelo PostgREST, com a chave pública do projeto e o JWT da
 * própria sessão, um admin de plataforma `support_readonly` (ou o admin de um tenant
 * em sessão sem o segundo fator) inseria um token `role:admin` + `mcp:write` para
 * qualquer organização e agia por ele nas rotas de administração por bearer.
 *
 * O que se prova, no Postgres real, como `authenticated` e `anon`:
 *
 *   1. CAMADA DE PRIVILÉGIO (o estado real do banco): nenhum dos dois tem privilégio
 *      algum em `api_tokens`. Admin da organização, gerente, admin de plataforma
 *      `support_readonly` e `full` sem vínculo: insert, update, delete, select e
 *      truncate dão `permission denied`. A linha semente segue intacta.
 *   2. CAMADA DE POLICY (para o dia em que um grant voltar: restore, ferramenta, o
 *      default ACL do Supabase): numa transação desfeita, o GRANT ALL é devolvido a
 *      `authenticated` e a RLS tem de barrar sozinha. CONTROLE POSITIVO: o admin da
 *      organização, com created_by = ele mesmo, insere (sem isto as recusas abaixo
 *      estariam verdes por a tabela recusar tudo). Recusados: created_by de outra
 *      pessoa, admin de outra organização, admin de plataforma `support_readonly` e
 *      `full` sem vínculo. Leitura: só o admin da própria organização enxerga.
 *   3. CONTROLE POSITIVO DO SERVIDOR: `service_role` insere, lê e atualiza (é por
 *      onde as rotas gravam).
 *
 * Roda via `pnpm test:db tests/invariants/api-tokens-so-o-servidor-escreve.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG_A = "09620001-a5aa-4000-8000-000000000001";
const ORG_B = "09620001-a5aa-4000-8000-000000000002";
const ADMIN_A = "09620001-b0b0-4000-8000-000000000001";
const ADMIN_B = "09620001-b0b0-4000-8000-000000000002";
const GERENTE_A = "09620001-b0b0-4000-8000-000000000003";
const SUPORTE_LEITURA = "09620001-b0b0-4000-8000-000000000004";
const PLATAFORMA_FULL = "09620001-b0b0-4000-8000-000000000005";
const SEMENTE = "09620001-c0c0-4000-8000-000000000001";

const QUEM = {
  admin_da_organizacao: ADMIN_A,
  gerente_da_organizacao: GERENTE_A,
  admin_de_outra_organizacao: ADMIN_B,
  plataforma_support_readonly: SUPORTE_LEITURA,
  plataforma_full_sem_vinculo: PLATAFORMA_FULL,
} as const;

function claims(usuario: string): string {
  return `select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"aal2"}', true);`;
}

function tokenSql(org: string, criador: string, prefixo: string): string {
  return `insert into public.api_tokens (organization_id, created_by, name, prefix, token_hash, scopes)
    values ('${org}', '${criador}', 'invariante 0962', '${prefixo}', '\\x${"cd".repeat(32)}', '["role:admin","mcp:write"]'::jsonb)`;
}

/** Roda `corpo` como `papel` dentro de uma transação que SEMPRE é desfeita. */
function comoNaTransacao(papel: "authenticated" | "anon", usuario: string, corpo: string, antes = ""): string {
  return sql(`
    begin;
    ${antes}
    set local role ${papel};
    ${claims(usuario)}
    ${corpo}
    rollback;
  `);
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

const DEVOLVE_O_GRANT = "grant all on public.api_tokens to authenticated;";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_A}', 'admin-a-0962@invariant.test'),
      ('${ADMIN_B}', 'admin-b-0962@invariant.test'),
      ('${GERENTE_A}', 'gerente-a-0962@invariant.test'),
      ('${SUPORTE_LEITURA}', 'suporte-0962@invariant.test'),
      ('${PLATAFORMA_FULL}', 'plataforma-0962@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'tok-0962-a', 'Tok 0962 A', 'Tok 0962 A'),
      ('${ORG_B}', 'tok-0962-b', 'Tok 0962 B', 'Tok 0962 B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_A}', '${ORG_A}', 'admin', now()),
      ('${GERENTE_A}', '${ORG_A}', 'manager', now()),
      ('${ADMIN_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;

    insert into public.platform_admins (user_id, granted_by, scope, reason) values
      ('${SUPORTE_LEITURA}', '${SUPORTE_LEITURA}', 'support_readonly', 'invariante 0962'),
      ('${PLATAFORMA_FULL}', '${PLATAFORMA_FULL}', 'full', 'invariante 0962')
      on conflict (user_id) do nothing;

    insert into public.api_tokens (id, organization_id, created_by, name, prefix, token_hash, scopes)
      values ('${SEMENTE}', '${ORG_A}', '${ADMIN_A}', 'semente 0962', 'dsk_0962seed', '\\x${"ef".repeat(32)}', '["mcp:read"]'::jsonb)
      on conflict (id) do nothing;
  `);
});

afterAll(() => {
  sql(`
    delete from public.api_tokens where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.organizations where id in ('${ORG_A}', '${ORG_B}');
  `);
});

describe("0962 camada de privilégio: authenticated e anon não têm nada em api_tokens", () => {
  it("nenhum privilégio de tabela para authenticated e anon", () => {
    const privilegios = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    for (const papel of ["authenticated", "anon"]) {
      for (const p of privilegios) {
        expect(
          sql(`select has_table_privilege('${papel}', 'public.api_tokens', '${p}');`),
          `${papel} ainda tem ${p} em api_tokens`,
        ).toBe("f");
      }
    }
  });

  for (const [nome, usuario] of Object.entries(QUEM)) {
    it(`${nome}: insert, update, delete, select e truncate dão permission denied`, () => {
      const comandos: Record<string, string> = {
        insert: tokenSql(ORG_A, usuario, `dsk_0962${nome.slice(0, 4)}`) + ";",
        update: `update public.api_tokens set scopes = '["role:admin","mcp:write"]'::jsonb where id = '${SEMENTE}'::uuid;`,
        delete: `delete from public.api_tokens where id = '${SEMENTE}'::uuid;`,
        select: `select count(*) from public.api_tokens;`,
        truncate: `truncate public.api_tokens;`,
      };
      for (const [cmd, corpo] of Object.entries(comandos)) {
        const motivo = erroDe(() => comoNaTransacao("authenticated", usuario, corpo));
        expect(motivo, `${nome} executou ${cmd} em api_tokens como authenticated`).toContain("permission denied");
      }
    });
  }

  it("anon também não escreve nem lê", () => {
    for (const corpo of [
      tokenSql(ORG_A, ADMIN_A, "dsk_0962anon") + ";",
      `select count(*) from public.api_tokens;`,
    ]) {
      expect(erroDe(() => comoNaTransacao("anon", ADMIN_A, corpo))).toContain("permission denied");
    }
  });

  it("a linha semente segue como estava depois de todas as tentativas", () => {
    expect(sql(`select scopes::text from public.api_tokens where id = '${SEMENTE}'::uuid;`)).toBe('["mcp:read"]');
  });
});

describe("0962 camada de policy: com o grant de volta, a RLS barra sozinha", () => {
  it("CONTROLE POSITIVO: o admin da organização insere token seu na própria organização", () => {
    const saida = comoNaTransacao(
      "authenticated",
      ADMIN_A,
      `${tokenSql(ORG_A, ADMIN_A, "dsk_0962ctl1")} returning created_by;`,
      DEVOLVE_O_GRANT,
    );
    expect(saida, "o controle positivo não inseriu: as recusas abaixo seriam vacuidade").toContain(ADMIN_A);
  });

  it("o admin não grava token em nome de outra pessoa (created_by diferente da sessão)", () => {
    const motivo = erroDe(() =>
      comoNaTransacao("authenticated", ADMIN_A, tokenSql(ORG_A, GERENTE_A, "dsk_0962other") + ";", DEVOLVE_O_GRANT),
    );
    expect(motivo).toContain("row-level security");
  });

  it("o admin de outra organização não grava nesta", () => {
    const motivo = erroDe(() =>
      comoNaTransacao("authenticated", ADMIN_B, tokenSql(ORG_A, ADMIN_B, "dsk_0962xorg") + ";", DEVOLVE_O_GRANT),
    );
    expect(motivo).toContain("row-level security");
  });

  it("admin de plataforma support_readonly sem vínculo não insere token em nenhuma organização", () => {
    for (const org of [ORG_A, ORG_B]) {
      const motivo = erroDe(() =>
        comoNaTransacao(
          "authenticated",
          SUPORTE_LEITURA,
          tokenSql(org, SUPORTE_LEITURA, "dsk_0962supp") + ";",
          DEVOLVE_O_GRANT,
        ),
      );
      expect(motivo, "o ramo de plataforma da policy voltou").toContain("row-level security");
    }
  });

  it("nem o admin de plataforma full, sem vínculo, insere (quem age de fora entra por sessão de suporte)", () => {
    const motivo = erroDe(() =>
      comoNaTransacao(
        "authenticated",
        PLATAFORMA_FULL,
        tokenSql(ORG_A, PLATAFORMA_FULL, "dsk_0962full") + ";",
        DEVOLVE_O_GRANT,
      ),
    );
    expect(motivo).toContain("row-level security");
  });

  it("update e delete da plataforma não alcançam a linha semente", () => {
    const saida = comoNaTransacao(
      "authenticated",
      SUPORTE_LEITURA,
      `with u as (update public.api_tokens set name = 'trocado' where id = '${SEMENTE}'::uuid returning 1),
            d as (delete from public.api_tokens where id = '${SEMENTE}'::uuid returning 1)
       select (select count(*) from u) || ',' || (select count(*) from d);`,
      DEVOLVE_O_GRANT,
    );
    expect(saida).toContain("0,0");
  });

  it("leitura: só o admin da própria organização enxerga a linha", () => {
    const quemVe = (usuario: string) =>
      comoNaTransacao(
        "authenticated",
        usuario,
        `select count(*) from public.api_tokens where id = '${SEMENTE}'::uuid;`,
        DEVOLVE_O_GRANT,
      )
        .split("\n")
        .filter((l) => /^\d+$/.test(l.trim()))
        .pop();
    expect(quemVe(ADMIN_A), "o admin da organização deixou de enxergar o próprio token").toBe("1");
    expect(quemVe(GERENTE_A)).toBe("0");
    expect(quemVe(ADMIN_B)).toBe("0");
    expect(quemVe(SUPORTE_LEITURA), "o ramo de plataforma voltou na leitura").toBe("0");
    expect(quemVe(PLATAFORMA_FULL)).toBe("0");
  });
});

describe("0962 o servidor segue escrevendo", () => {
  it("CONTROLE POSITIVO: service_role insere, lê e atualiza", () => {
    const saida = sql(`
      begin;
      set local role service_role;
      ${tokenSql(ORG_A, ADMIN_A, "dsk_0962serv")};
      update public.api_tokens set revoked_at = now() where prefix = 'dsk_0962serv';
      select count(*) from public.api_tokens where prefix = 'dsk_0962serv' and revoked_at is not null;
      rollback;
    `);
    expect(saida.split("\n").filter((l) => /^\d+$/.test(l.trim())).pop()).toBe("1");
  });
});
