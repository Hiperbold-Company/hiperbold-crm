/**
 * 0533 — as 9 policies DINÂMICAS da #2115 que a lista de 47 não via.
 *
 * Os laços `format()` de 0350 (`financial_accounts`, `payment_methods`,
 * `account_plans`; with check manager) e 0351 (`sales`, `sale_items`,
 * `commission_rules`, `commissions`, `financial_entries`, `loyalty_ledger`;
 * with check agent) criavam `tenant_isolation_%I_all` com
 * `fn_is_platform_admin()`, que ignora o scope do JWT: `support_readonly`
 * escrevia em dinheiro. A conta global de `platform-admin-full-so-escreve`
 * achou as 9. Viraram o par de `recurring_entries`: `_read` com a pura,
 * `_write` com `_full`.
 *
 * Mede em Postgres REAL:
 *   · CATÁLOGO: `_write` com `_full` e sem a pura; `_read` mantém a pura;
 *     o `_all` não existe mais;
 *   · COMPORTAMENTO em `financial_accounts`: `support_readonly` lê, faz UPDATE
 *     em 0 linhas; `full` faz em 1 (controle positivo).
 *
 * Previsão escrita antes de rodar (sabotagem): devolvida a pura ao `_write` de
 * um dos laços, o catálogo acusa as tabelas dele; no laço de 0350, a sonda
 * devolve 1 em vez de 0.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { countAs, seedGov, sql, writeCountAs } from "./gov-helpers";

const ORG = "cccccccc-2115-4000-8000-000000000301";
const FULL = "cccccccc-2115-4000-8000-000000000310";
const READONLY = "cccccccc-2115-4000-8000-000000000311";
const CONTA = "cccccccc-2115-4000-8000-000000000302";

const DINAMICAS = [
  "financial_accounts",
  "payment_methods",
  "account_plans",
  "sales",
  "sale_items",
  "commission_rules",
  "commissions",
  "financial_entries",
  "loyalty_ledger",
] as const;

beforeAll(() => {
  // #1907 — o módulo financeiro INSTALADO antes de medir: as cinco tabelas da comanda
  // (`sales`, `sale_items`, `commission_rules`, `commissions`, `loyalty_ledger`) saíram do
  // `baseline.sql` e as policies dinâmicas de 0351 nascem em `fn_financeiro_provisionar()`
  // (ADR-0002 D2/D3) — sem a chamada, `expressaoViva` não acha
  // `tenant_isolation_sales_write` e este arquivo inteiro cai por um banco sem o módulo.
  sql("select public.fn_financeiro_provisionar();");
  seedGov();
  sql(`
    delete from public.financial_accounts where organization_id = '${ORG}';
    delete from public.organizations where id = '${ORG}';
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'org-2115-din', 'Org 2115 dinâmicas', 'Org 2115 dinâmicas');
    insert into auth.users (id, email) values
      ('${FULL}', 'full-2115-din@invariant.test'),
      ('${READONLY}', 'readonly-2115-din@invariant.test')
    on conflict (id) do nothing;
    delete from public.platform_admins where user_id in ('${FULL}', '${READONLY}');
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason) values
      ('${FULL}', '${FULL}', 'full', false, 'invariante 2115 dinâmicas'),
      ('${READONLY}', '${FULL}', 'support_readonly', false, 'invariante 2115 dinâmicas');
    insert into public.financial_accounts (id, organization_id, name)
      values ('${CONTA}', '${ORG}', 'Conta 2115 dinâmicas');
  `);
});

describe("0533 — support_readonly não escreve nas 9 dinâmicas de 0350/0351", () => {
  // O fork (0923, D-138/D-127) trocou o par `_read`/`_write` por uma policy por operação
  // (select de membro; insert/update/delete por papel). A garantia medida é a mesma: TODA
  // policy permissiva de escrita exige `_full`, a leitura mantém a pura e o `_all` não volta.
  it("catálogo: toda escrita com _full, a leitura com a pura, sem _all", () => {
    const faltando: string[] = [];
    for (const tabela of DINAMICAS) {
      const escritas = sql(
        `select string_agg(policyname || '|' || regexp_replace(coalesce(qual,'') || ' ' || coalesce(with_check,''), '\\s+', ' ', 'g'), '§')
           from pg_policies
          where schemaname = 'public' and tablename = '${tabela}' and permissive = 'PERMISSIVE'
            and cmd in ('INSERT','UPDATE','DELETE','ALL');`,
      )
        .split("§")
        .filter(Boolean);
      // Zero policy de escrita é o mais estreito (ex.: `commissions`, só leitura no fork: quem grava
      // é `fn_finalizar_comanda`, definer). O controle positivo de escrita é o caso de `financial_accounts`.
      for (const linha of escritas) {
        const [nome, expr = ""] = linha.split("|");
        if (!expr.includes("fn_is_platform_admin_full")) faltando.push(`${nome}: sem _full`);
        if (/fn_is_platform_admin\s*\(/.test(expr)) faltando.push(`${nome}: ainda aceita a pura`);
      }
      const leituras = sql(
        `select coalesce(qual,'') from pg_policies where schemaname = 'public' and tablename = '${tabela}'
            and permissive = 'PERMISSIVE' and cmd = 'SELECT';`,
      );
      if (!/fn_is_platform_admin\s*\(/.test(leituras)) faltando.push(`${tabela}: leitura perdeu a pura`);
      const sobra = sql(
        `select count(*) from pg_policies where schemaname = 'public' and tablename = '${tabela}' and policyname = 'tenant_isolation_${tabela}_all';`,
      );
      if (sobra !== "0") faltando.push(`${tabela}: _all ainda existe`);
    }
    expect(faltando, "dinâmica de 0350/0351 com escrita aberta ao support_readonly").toEqual([]);
  });

  it("financial_accounts: support_readonly LÊ; UPDATE 0 como support_readonly; 1 como full", () => {
    expect(countAs(READONLY, `select count(*) from public.financial_accounts where id = '${CONTA}';`)).toBe(1);
    expect(writeCountAs(READONLY, `update public.financial_accounts set name = 'hackeado' where id = '${CONTA}'`)).toBe(0);
    expect(writeCountAs(FULL, `update public.financial_accounts set name = 'escrito pelo full' where id = '${CONTA}'`)).toBe(1);
  });
});
