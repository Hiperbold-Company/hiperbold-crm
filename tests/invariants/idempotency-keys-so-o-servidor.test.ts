/**
 * Migration 0969 (fork Hiperbold, achado da auditoria da fase 2 da API, 17/10/2026): `idempotency_keys`
 * só é lida e escrita pelo servidor.
 *
 * O defeito. O recibo de idempotência guarda por 24 h a RESPOSTA do POST de criação (o `path_token` da URL
 * de captação, o prompt de um agente de IA…), e a policy `idempotency_tenant_select` deixava qualquer membro
 * da organização — o Visualizador inclusive — ler a tabela inteira pela REST com o próprio JWT.
 *
 * O que se prova, no Postgres real, como `authenticated` e `anon`:
 *
 *   1. CAMADA DE PRIVILÉGIO: nenhum dos dois tem privilégio algum na tabela; Visualizador e Agente de
 *      outra organização dão `permission denied` ao ler, inserir, atualizar e apagar. O recibo semente
 *      segue intacto.
 *   2. CAMADA DE POLICY (para o dia em que um grant voltar: restore, ferramenta, default ACL do Supabase):
 *      numa transação desfeita o GRANT ALL é devolvido a `authenticated` e a RLS tem de ler ZERO linhas,
 *      do membro da própria organização inclusive — o recibo não é dado de tenant.
 *      CONTROLE POSITIVO da sonda: o servidor (dono do banco) enxerga a linha semente, então o zero não é
 *      uma tabela vazia.
 *   3. CONTROLE POSITIVO DO SERVIDOR: `service_role` insere, lê, atualiza e apaga (é por onde
 *      `lib/api/idempotency.ts` grava).
 *
 * Roda via `pnpm test:db tests/invariants/idempotency-keys-so-o-servidor.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG_A = "09690001-a5aa-4000-8000-000000000001";
const ORG_B = "09690001-a5aa-4000-8000-000000000002";
const VISUALIZADOR_A = "09690001-b0b0-4000-8000-000000000001";
const AGENTE_A = "09690001-b0b0-4000-8000-000000000002";
const ADMIN_B = "09690001-b0b0-4000-8000-000000000003";
const SEMENTE_CHAVE = "invariante-0969-semente";
const SEGREDO_NO_RECIBO = "path-token-que-nao-pode-vazar-0969";

const QUEM = {
  visualizador_da_organizacao: VISUALIZADOR_A,
  agente_da_organizacao: AGENTE_A,
  admin_de_outra_organizacao: ADMIN_B,
} as const;

function claims(usuario: string): string {
  return `select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"aal2"}', true);`;
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

const DEVOLVE_O_GRANT = "grant all on public.idempotency_keys to authenticated;";

const reciboSql = (org: string, chave: string) =>
  `insert into public.idempotency_keys (organization_id, key, endpoint, request_hash, status_code, response_body, expires_at)
   values ('${org}', '${chave}', '/api/v1/webhook-sources', '\\x01'::bytea, 201,
           '{"path_token":"${SEGREDO_NO_RECIBO}"}'::jsonb, now() + interval '1 hour')`;

const ultimoNumero = (saida: string) =>
  saida
    .split("\n")
    .filter((l) => /^\d+$/.test(l.trim()))
    .pop();

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${VISUALIZADOR_A}', 'viz-a-0969@invariant.test'),
      ('${AGENTE_A}', 'agente-a-0969@invariant.test'),
      ('${ADMIN_B}', 'admin-b-0969@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'idem-0969-a', 'Idem 0969 A', 'Idem 0969 A'),
      ('${ORG_B}', 'idem-0969-b', 'Idem 0969 B', 'Idem 0969 B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${VISUALIZADOR_A}', '${ORG_A}', 'viewer', now()),
      ('${AGENTE_A}', '${ORG_A}', 'agent', now()),
      ('${ADMIN_B}', '${ORG_B}', 'admin', now())
      on conflict do nothing;

    ${reciboSql(ORG_A, SEMENTE_CHAVE)} on conflict do nothing;
  `);
});

afterAll(() => {
  sql(`
    delete from public.idempotency_keys where organization_id in ('${ORG_A}', '${ORG_B}');
    delete from public.organizations where id in ('${ORG_A}', '${ORG_B}');
  `);
});

describe("0969 camada de privilégio: authenticated e anon não têm nada em idempotency_keys", () => {
  it("nenhum privilégio de tabela para authenticated e anon", () => {
    for (const papel of ["authenticated", "anon"]) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        expect(
          sql(`select has_table_privilege('${papel}', 'public.idempotency_keys', '${p}');`),
          `${papel} ainda tem ${p} em idempotency_keys`,
        ).toBe("f");
      }
    }
  });

  for (const [nome, usuario] of Object.entries(QUEM)) {
    it(`${nome}: select, insert, update e delete dão permission denied`, () => {
      const comandos: Record<string, string> = {
        select: `select response_body from public.idempotency_keys where organization_id = '${ORG_A}';`,
        insert: `${reciboSql(ORG_A, `invasor-${nome}`)};`,
        update: `update public.idempotency_keys set response_body = '{}'::jsonb where key = '${SEMENTE_CHAVE}';`,
        delete: `delete from public.idempotency_keys where key = '${SEMENTE_CHAVE}';`,
      };
      for (const [cmd, corpo] of Object.entries(comandos)) {
        const motivo = erroDe(() => comoNaTransacao("authenticated", usuario, corpo));
        expect(motivo, `${nome} executou ${cmd} em idempotency_keys como authenticated`).toContain(
          "permission denied",
        );
      }
    });
  }

  it("anon também não lê nem escreve", () => {
    for (const corpo of [`select count(*) from public.idempotency_keys;`, `${reciboSql(ORG_A, "anon-0969")};`]) {
      expect(erroDe(() => comoNaTransacao("anon", VISUALIZADOR_A, corpo))).toContain("permission denied");
    }
  });

  it("o recibo semente segue como estava depois de todas as tentativas", () => {
    expect(
      sql(`select response_body->>'path_token' from public.idempotency_keys where key = '${SEMENTE_CHAVE}';`),
    ).toBe(SEGREDO_NO_RECIBO);
  });
});

describe("0969 camada de policy: com o grant de volta, a RLS barra sozinha", () => {
  it("CONTROLE POSITIVO DA SONDA: o servidor enxerga o recibo semente (o zero abaixo não é tabela vazia)", () => {
    expect(
      ultimoNumero(sql(`select count(*) from public.idempotency_keys where key = '${SEMENTE_CHAVE}';`)),
    ).toBe("1");
  });

  it("nem o membro da própria organização lê o recibo, Visualizador e Agente inclusive", () => {
    for (const usuario of [VISUALIZADOR_A, AGENTE_A, ADMIN_B]) {
      const saida = comoNaTransacao(
        "authenticated",
        usuario,
        `select count(*) from public.idempotency_keys where key = '${SEMENTE_CHAVE}';`,
        DEVOLVE_O_GRANT,
      );
      expect(ultimoNumero(saida), `${usuario} leu o recibo com o grant de volta`).toBe("0");
    }
  });

  it("com o grant de volta, o membro também não grava recibo", () => {
    const motivo = erroDe(() =>
      comoNaTransacao("authenticated", AGENTE_A, `${reciboSql(ORG_A, "agente-grava-0969")};`, DEVOLVE_O_GRANT),
    );
    expect(motivo).toContain("row-level security");
  });
});

describe("0969 o servidor segue escrevendo", () => {
  it("CONTROLE POSITIVO: service_role insere, lê, atualiza e apaga", () => {
    const saida = sql(`
      begin;
      set local role service_role;
      ${reciboSql(ORG_A, "servidor-0969")};
      update public.idempotency_keys set status_code = 200 where key = 'servidor-0969';
      select count(*) from public.idempotency_keys where key = 'servidor-0969' and status_code = 200;
      delete from public.idempotency_keys where key = 'servidor-0969';
      rollback;
    `);
    expect(ultimoNumero(saida)).toBe("1");
  });
});
