import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COLUNAS_DO_CONTATO_SEM_CPF } from "@/lib/contacts/colunas";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * `contacts.cpf_hash` E `contacts.cpf_encrypted` SÃO SÓ DO SERVIDOR — migration 0967, D-216.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O grant de `contacts` era de tabela inteira (`GRANT ALL`, e o default ACL de TABELAS do Supabase concede o mesmo a
 * toda tabela nova). Com isso um `viewer` lia as duas colunas por `/rest/v1/contacts?select=cpf_hash,cpf_encrypted`,
 * e um `agent` as reescrevia. Privilégio de coluna não se tira de cima de um grant de tabela: o que fecha é revogar
 * SELECT/INSERT/UPDATE da tabela e conceder POR COLUNA em todas as outras.
 *
 * ─── O que este arquivo prova ───────────────────────────────────────────────
 *
 * 1. Controle: sob o default ACL do Supabase, SEM o bloco da 0967, as duas colunas ficam abertas (a simulação mede).
 * 2. COM o bloco (lido do `supabase/baseline.sql` pelo rótulo, o texto que o self-host aplica), `anon` e
 *    `authenticated` não têm SELECT, INSERT nem UPDATE nas duas colunas; `service_role` tem os três.
 * 3. No banco que o gate realmente montou (sem simulação), o mesmo vale.
 * 4. Por comportamento: sob o papel `authenticated`, ler/gravar a coluna e `select *` dão "permission denied", e a
 *    leitura de colunas comuns segue de pé.
 * 5. A VARREDURA que protege a coluna futura: TODA outra coluna de `contacts` tem SELECT, INSERT e UPDATE para
 *    `authenticated` e `anon`. Coluna acrescentada por migration futura sem o grant de coluna reprova aqui, em vez de
 *    quebrar a API de contatos em silêncio com "permission denied for table contacts". O caso 6 mostra que a
 *    varredura enxerga a coluna esquecida (sem ele, uma varredura que sempre devolve vazio passaria por nada).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

const ROTULO_0967 =
  "-- ---- captação com carimbo de horário e CPF do contato só do servidor (migration 0967, fork Hiperbold) ----";

/** O bloco rotulado da 0967, do rótulo até o próximo rótulo de apêndice. */
function blocoDa0967(): string {
  const inicio = BASELINE.indexOf(ROTULO_0967);
  if (inicio === -1) throw new Error("rótulo da 0967 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO_0967, inicio + 1) !== -1) throw new Error("rótulo da 0967 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO_0967.length);
  if (fim === -1) throw new Error("fim do bloco da 0967 não encontrado");
  return BASELINE.slice(inicio, fim);
}

/** O que o default ACL de tabelas do Supabase concede a `contacts` ao criá-la. */
const DEFAULT_ACL_DO_SUPABASE = "grant all on table public.contacts to anon, authenticated, service_role;";

const PAPEIS_DO_POSTGREST = ["anon", "authenticated"] as const;
const COLUNAS_DO_CPF = ["cpf_hash", "cpf_encrypted"] as const;
const PRIVILEGIOS = ["SELECT", "INSERT", "UPDATE"] as const;

/** Marcador das linhas de resultado: a saída do psql traz também BEGIN, GRANT, REVOKE… */
const MARCA = "SONDA|";

/** Roda `corpo` numa transação desfeita e devolve as linhas marcadas, sem a marca. */
function sondasDesfeitas(corpo: string): string[] {
  return sql(`begin;\n${corpo}\nrollback;`)
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

/** O privilégio EFETIVO de cada (papel, coluna do CPF, privilégio): inclui o herdado de tabela inteira. */
const SONDA_CPF = `
  select '${MARCA}' || coalesce(string_agg(p.papel || '.' || p.coluna || ':' || p.priv, ',' order by p.papel, p.coluna, p.priv), '')
    from (select papel, coluna, priv
            from unnest(array['anon', 'authenticated', 'service_role']) papel,
                 unnest(array['cpf_hash', 'cpf_encrypted']) coluna,
                 unnest(array['SELECT', 'INSERT', 'UPDATE']) priv) p
   where has_column_privilege(p.papel, 'public.contacts', p.coluna, p.priv);`;

/**
 * A VARREDURA: colunas de `contacts` (fora as duas do CPF) em que `authenticated` ou `anon` perdeu algum dos três
 * privilégios. O resultado esperado é vazio.
 */
function colunasSemGrant(): string {
  const [linha] = sondasDesfeitas(`
    select '${MARCA}' || coalesce(string_agg(x.coluna || '/' || x.papel || '/' || x.priv, ',' order by x.attnum, x.papel, x.priv), '')
      from (select a.attnum, a.attname as coluna, r.papel, v.priv
              from pg_attribute a
             cross join unnest(array['anon', 'authenticated']) r(papel)
             cross join unnest(array['SELECT', 'INSERT', 'UPDATE']) v(priv)
             where a.attrelid = 'public.contacts'::regclass
               and a.attnum > 0
               and not a.attisdropped
               and a.attname not in ('cpf_hash', 'cpf_encrypted')
               and not has_column_privilege(r.papel, 'public.contacts', a.attname, v.priv)) x;
  `);
  return linha ?? "";
}

/** Roda o script e devolve o erro do Postgres, ou `null` se ele passou. */
function erroDo(script: string): string | null {
  try {
    sql(script);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

/** Todas as combinações papel.coluna:privilégio que `papel` NÃO deve ter. */
const todasDe = (papeis: readonly string[]) =>
  papeis.flatMap((p) => COLUNAS_DO_CPF.flatMap((c) => PRIVILEGIOS.map((v) => `${p}.${c}:${v}`))).sort();

describe("migration 0967: cpf_hash e cpf_encrypted são só do servidor", () => {
  it("controle: SEM o bloco, sob o default ACL do Supabase, anon e authenticated leem e gravam as duas colunas", () => {
    const [abertas] = sondasDesfeitas(`
      ${DEFAULT_ACL_DO_SUPABASE}
      ${SONDA_CPF}
    `);
    const lista = (abertas ?? "").split(",");
    for (const esperado of todasDe([...PAPEIS_DO_POSTGREST, "service_role"])) {
      expect(lista, `a simulação não reproduz o defeito: falta ${esperado}`).toContain(esperado);
    }
  });

  it("COM o bloco da 0967 sobre o default ACL, as duas colunas somem para anon e authenticated e ficam para o service_role", () => {
    const [abertas] = sondasDesfeitas(`
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0967()}
      ${SONDA_CPF}
    `);
    expect((abertas ?? "").split(",").sort()).toEqual(todasDe(["service_role"]));
  });

  it("o bloco é idempotente: aplicado duas vezes (o update.sh re-aplica o baseline) dá o mesmo resultado", () => {
    const [abertas] = sondasDesfeitas(`
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0967()}
      ${DEFAULT_ACL_DO_SUPABASE}
      ${blocoDa0967()}
      ${SONDA_CPF}
    `);
    expect((abertas ?? "").split(",").sort()).toEqual(todasDe(["service_role"]));
  });

  it("no banco que o gate montou (sem simulação), é o mesmo", () => {
    const [abertas] = sondasDesfeitas(SONDA_CPF);
    expect((abertas ?? "").split(",").sort()).toEqual(todasDe(["service_role"]));
  });

  it("sob o papel authenticated: ler, gravar e `select *` dão permission denied; colunas comuns seguem lendo", () => {
    const como = (papel: string, comando: string) => erroDo(`begin; set local role ${papel}; ${comando}; rollback;`);

    for (const papel of PAPEIS_DO_POSTGREST) {
      expect(como(papel, "select cpf_hash from public.contacts limit 1"), `${papel} select cpf_hash`).toMatch(/permission denied/);
      expect(como(papel, "select cpf_encrypted from public.contacts limit 1"), `${papel} select cpf_encrypted`).toMatch(
        /permission denied/,
      );
      expect(como(papel, "select * from public.contacts limit 1"), `${papel} select *`).toMatch(/permission denied/);
      expect(como(papel, "update public.contacts set cpf_hash = 'x' where false"), `${papel} update cpf_hash`).toMatch(
        /permission denied/,
      );
      expect(como(papel, "update public.contacts set cpf_encrypted = null where false"), `${papel} update cpf_encrypted`).toMatch(
        /permission denied/,
      );
      expect(como(papel, "insert into public.contacts (cpf_hash) values ('x')"), `${papel} insert cpf_hash`).toMatch(
        /permission denied/,
      );
      expect(como(papel, "insert into public.contacts (cpf_encrypted) values ('\\x00')"), `${papel} insert cpf_encrypted`).toMatch(
        /permission denied/,
      );
    }

    // Controle da sonda: o que não é CPF continua legível e atualizável — senão o "denied" acima poderia ser a tabela
    // inteira fechada, e a API de contatos estaria quebrada. Só para `authenticated`: `anon` não executa os helpers
    // de RLS (`fn_user_org_ids`), então nem as linhas comuns ele alcança, com ou sem esta migration.
    expect(
      como("authenticated", "select id, name, display_name, tags, custom_fields from public.contacts limit 1"),
      "authenticated colunas comuns",
    ).toBeNull();
    expect(como("authenticated", "update public.contacts set name = name where false"), "authenticated update comum").toBeNull();
  });

  it("o service_role segue lendo e gravando as duas colunas", () => {
    const erro = erroDo(`begin; set local role service_role;
      select cpf_hash, cpf_encrypted from public.contacts limit 1;
      update public.contacts set cpf_hash = cpf_hash, cpf_encrypted = cpf_encrypted where false;
      rollback;`);
    expect(erro).toBeNull();
  });

  it("VARREDURA: toda outra coluna de contacts tem SELECT, INSERT e UPDATE para authenticated e anon", () => {
    expect(
      colunasSemGrant(),
      "coluna de contacts sem grant de coluna para authenticated/anon: a migration que a criou precisa " +
        "`grant select (col), insert (col), update (col) on public.contacts to anon, authenticated` (e o mesmo no apêndice do baseline)",
    ).toBe("");
  });

  it("a varredura enxerga a coluna esquecida: coluna nova sem grant aparece na sonda", () => {
    const [achadas] = sondasDesfeitas(`
      alter table public.contacts add column zz_coluna_esquecida text;
      select '${MARCA}' || coalesce(string_agg(x.coluna || '/' || x.papel || '/' || x.priv, ',' order by x.papel, x.priv), '')
        from (select a.attname as coluna, r.papel, v.priv
                from pg_attribute a
               cross join unnest(array['anon', 'authenticated']) r(papel)
               cross join unnest(array['SELECT', 'INSERT', 'UPDATE']) v(priv)
               where a.attrelid = 'public.contacts'::regclass
                 and a.attname = 'zz_coluna_esquecida'
                 and not has_column_privilege(r.papel, 'public.contacts', a.attname, v.priv)) x;
    `);
    expect((achadas ?? "").split(",")).toHaveLength(6);
  });
  it("a lista de colunas de lib/contacts/colunas.ts (contexto das automações) é exatamente toda coluna de contacts menos as do CPF", () => {
    const [reais] = sondasDesfeitas(`
      select '${MARCA}' || string_agg(attname, ', ' order by attnum)
        from pg_attribute
       where attrelid = 'public.contacts'::regclass and attnum > 0 and not attisdropped
         and attname not in ('cpf_hash', 'cpf_encrypted');
    `);
    expect(
      COLUNAS_DO_CONTATO_SEM_CPF,
      "coluna nova (ou removida) em contacts: acerte lib/contacts/colunas.ts na mesma migration",
    ).toBe(reais);
  });
});
