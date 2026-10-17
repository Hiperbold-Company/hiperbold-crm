/**
 * Migração 0961: batimentos dos serviços de fundo (worker e scheduler), fork Hiperbold. Provado no Postgres real:
 *
 *   1. a tabela existe com RLS ligada e SEM nenhuma policy (deny-all para quem passa pela API);
 *   2. anon e authenticated são barrados por permission denied em SELECT, INSERT, UPDATE e DELETE (medido sob
 *      `set role`), inclusive com JWT de usuário simulado;
 *   3. service_role lê, insere e altera (o que o app e o worker fazem), mas não apaga nem trunca;
 *   4. o upsert exato que o worker usa (`gravarBatimentoPg`) funciona, é idempotente por serviço e avança o
 *      instante; o do app (service_role) também;
 *   5. só os dois serviços combinados cabem na chave (CHECK);
 *   6. a migration não criou função nenhuma (nada a revogar de PUBLIC/anon) e o EXECUTE de funções novas não
 *      vazou: nenhuma função de `public` que cite a tabela.
 *
 * Roda via `pnpm test:db tests/invariants/batimentos-dos-servicos.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

function erroDe(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

describe("sistema_batimentos (0961)", () => {
  it("1. RLS ligada e nenhuma policy", () => {
    expect(
      sql(`select relrowsecurity::text from pg_class where oid = 'public.sistema_batimentos'::regclass;`),
    ).toBe("true");
    expect(sql(`select count(*) from pg_policies where schemaname='public' and tablename='sistema_batimentos';`)).toBe(
      "0",
    );
  });

  it("2. anon e authenticated não leem nem escrevem", () => {
    for (const papel of ["anon", "authenticated"]) {
      for (const comando of [
        `select count(*) from public.sistema_batimentos;`,
        `insert into public.sistema_batimentos (servico, ultimo_em) values ('worker', now());`,
        `update public.sistema_batimentos set ultimo_em = now();`,
        `delete from public.sistema_batimentos;`,
      ]) {
        const erro = erroDe(`set role ${papel}; ${comando}`);
        expect(erro, `${papel}: ${comando}`).toMatch(/permission denied/i);
      }
    }
    // Usuário logado simulado (JWT) também não passa: o privilégio nem existe.
    const comoUsuario = erroDe(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"0961a000-0000-4000-8000-000000000001","role":"authenticated"}', false);
      select * from public.sistema_batimentos;
    `);
    expect(comoUsuario).toMatch(/permission denied/i);
  });

  it("3. service_role lê, insere e altera; não apaga nem trunca", () => {
    expect(
      erroDe(`
        set role service_role;
        insert into public.sistema_batimentos (servico, ultimo_em, versao) values ('scheduler', now(), 'teste')
          on conflict (servico) do update set ultimo_em = excluded.ultimo_em;
        update public.sistema_batimentos set versao = 'teste2' where servico = 'scheduler';
        select count(*) from public.sistema_batimentos;
      `),
    ).toBeNull();
    expect(erroDe(`set role service_role; delete from public.sistema_batimentos;`)).toMatch(/permission denied/i);
    expect(erroDe(`set role service_role; truncate public.sistema_batimentos;`)).toMatch(/permission denied/i);
  });

  it("4. o upsert do worker é idempotente por serviço e avança o instante", () => {
    const upsert = `insert into public.sistema_batimentos (servico, ultimo_em, versao, detalhe)
       values ('worker', now(), '1.0.0', '{"uptime_s": 1}'::jsonb)
       on conflict (servico) do update
         set ultimo_em = excluded.ultimo_em, versao = excluded.versao, detalhe = excluded.detalhe`;
    sql(`delete from public.sistema_batimentos where servico = 'worker'; ${upsert};`);
    const antes = sql(`select ultimo_em::text from public.sistema_batimentos where servico = 'worker';`);
    sql(`select pg_sleep(0.05); ${upsert};`);
    expect(sql(`select count(*) from public.sistema_batimentos where servico = 'worker';`)).toBe("1");
    expect(sql(`select (ultimo_em::text > '${antes}')::text from public.sistema_batimentos where servico = 'worker';`)).toBe(
      "true",
    );
    expect(sql(`select detalhe->>'uptime_s' from public.sistema_batimentos where servico = 'worker';`)).toBe("1");
  });

  it("5. só worker e scheduler cabem", () => {
    expect(erroDe(`insert into public.sistema_batimentos (servico, ultimo_em) values ('outro', now());`)).toMatch(
      /sistema_batimentos_servico_valido|check constraint/i,
    );
  });

  it("6. nenhuma função de public cita a tabela (nada novo exposto como RPC)", () => {
    expect(
      sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosrc ilike '%sistema_batimentos%';`),
    ).toBe("0");
  });
});
