/**
 * DESLIGAR UM MÓDULO DE TABELA PRESERVA OS DADOS — migration 1016.
 *
 * `fn_modulo_definir_estado` troca `modulos_instalados.estado` entre `ativo` e `desligado` e mais
 * nada: a tabela do módulo e as linhas dela ficam, e religar as devolve iguais. A reaplicação da
 * atualização (`fn_reaplicar_modulos_instalados`, que o rodapé do baseline chama) NÃO religa um
 * módulo desligado. Provado com uma provisionadora de mentira, na forma da D4, sobre o banco
 * recém-clonado do baseline (tests/db/banco-limpo-por-arquivo.ts).
 */
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (!process.env.TEST_DB_PORT) throw new Error("TEST_DB_PORT ausente — execute pnpm test:db");
const pool = new Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
const query = (text: string, values: unknown[] = []) => pool.query(text, values);

const plataforma = "e1016000-0000-4000-8000-000000000001";
const intruso = "e1016000-0000-4000-8000-000000000002";
const org = "e1016000-0000-4000-8000-0000000000a1";
const MODULO = "sondadesl";
const TABELA = "sonda_desl_itens";

async function comoServico(sql: string, valores: unknown[]): Promise<Record<string, unknown>> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role service_role");
    const r = await c.query(sql, valores);
    await c.query("commit");
    return r.rows[0].recibo;
  } catch (erro) {
    await c.query("rollback");
    throw erro;
  } finally {
    c.release();
  }
}

const definir = (operacao: string, ligar: boolean, visto: string, ator = plataforma) =>
  comoServico("select public.fn_modulo_definir_estado($1, $2, $3, $4, $5) as recibo", [
    ator,
    operacao,
    MODULO,
    ligar,
    visto,
  ]);

async function estado(): Promise<string | undefined> {
  return (await query("select estado from public.modulos_instalados where modulo = $1", [MODULO])).rows[0]?.estado;
}

async function linhasDoModulo(): Promise<number> {
  return (await query(`select count(*)::int as n from public.${TABELA}`)).rows[0].n;
}

beforeAll(async () => {
  for (const id of [plataforma, intruso]) {
    await query("insert into auth.users(id, email) values ($1, $2) on conflict (id) do nothing", [id, `${id}@invariant.test`]);
  }
  await query(
    `insert into public.platform_admins(user_id, granted_by, scope, mfa_required, reason)
     values ($1, $1, 'full', false, 'Teste de módulo desligado')
     on conflict (user_id) do update set revoked_at = null, scope = 'full'`,
    [plataforma],
  );
  await query("insert into public.organizations(id, slug, legal_name, display_name) values ($1, 'org-1016', 'Org 1016 LTDA', 'Org 1016') on conflict (id) do nothing", [org]);
  await query(`
    create or replace function public.fn_${MODULO}_provisionar()
    returns void language plpgsql security definer set search_path = public as $prov$
    begin
      create table if not exists public.${TABELA} (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id) on delete cascade,
        total_cents bigint not null default 0
      );
      perform public.fn_proteger_modulo_provisionado();
    end $prov$;
    revoke execute on function public.fn_${MODULO}_provisionar() from public, anon, authenticated;
    grant execute on function public.fn_${MODULO}_provisionar() to service_role;`);
  await comoServico("select public.fn_modulo_instalar($1, $2, $3) as recibo", [plataforma, randomUUID(), MODULO]);
  await query(`insert into public.${TABELA}(organization_id, total_cents) values ($1, 100), ($1, 250)`, [org]);
});

afterAll(async () => {
  await pool.end();
});

describe("superfície", () => {
  it("fn_modulo_definir_estado é security definer e só de service_role", async () => {
    const r = await query(`
      select has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service_role,
             p.prosecdef
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'fn_modulo_definir_estado'`);
    expect(r.rows).toEqual([{ anon: false, authenticated: false, service_role: true, prosecdef: true }]);
  });
});

describe("desligar e religar", () => {
  it("quem não é admin de plataforma é recusado, sem efeito", async () => {
    await expect(definir(randomUUID(), false, "ativo", intruso)).rejects.toThrow("extension_forbidden");
    expect(await estado()).toBe("ativo");
  });

  it("desligar troca o estado, grava o recibo de plataforma e NÃO toca na tabela nem nas linhas", async () => {
    const op = randomUUID();
    const recibo = await definir(op, false, "ativo");
    expect(recibo).toMatchObject({ id: op, kind: "module_disable", status: "completed", organization_id: null, applied_now: true });
    expect(await estado()).toBe("desligado");
    expect((await query("select to_regclass($1) as t", [`public.${TABELA}`])).rows[0].t).not.toBeNull();
    expect(await linhasDoModulo()).toBe(2);
  });

  it("estado visto velho (a tela achava que estava ativo) é recusado, sem efeito", async () => {
    await expect(definir(randomUUID(), false, "ativo")).rejects.toThrow("extension_module_state_changed");
    expect(await estado()).toBe("desligado");
  });

  it("a reaplicação da atualização roda a provisionadora mas mantém o módulo desligado", async () => {
    await query("select public.fn_reaplicar_modulos_instalados()");
    expect(await estado()).toBe("desligado");
    await query("select public.fn_conferir_modulos_instalados()");
    expect(await linhasDoModulo()).toBe(2);
  });

  it("religar volta a ativo com os mesmos dados; a mesma chave repetida não reexecuta", async () => {
    const op = randomUUID();
    const primeiro = await definir(op, true, "desligado");
    expect(primeiro).toMatchObject({ kind: "module_enable", applied_now: true });
    const segundo = await definir(op, true, "desligado");
    expect(segundo).toMatchObject({ id: op, applied_now: false });
    await expect(definir(op, false, "ativo")).rejects.toThrow("extension_idempotency_conflict");
    expect(await estado()).toBe("ativo");
    expect(await linhasDoModulo()).toBe(2);
  });

  it("módulo não instalado é recusado", async () => {
    await expect(
      comoServico("select public.fn_modulo_definir_estado($1, $2, $3, $4, $5) as recibo", [
        plataforma,
        randomUUID(),
        "naoinstalado",
        false,
        "ativo",
      ]),
    ).rejects.toThrow("extension_module_not_installed");
  });
});
