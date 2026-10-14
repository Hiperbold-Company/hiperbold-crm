import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration 0955 (cupons de desconto na compra do plano, fork Hiperbold): este arquivo cobre a FORMA.
 * Migration e baseline dizem a mesma coisa, no lugar certo (depois da 0954 e antes da VARREDURA anon, porque
 * cria função), registradas no MANIFEST, reaplicáveis com o app no ar. O COMPORTAMENTO em banco é provado por
 * `tests/invariants/cupons-banco.test.ts` (`pnpm test:db`).
 */

const BASELINE = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const MANIFEST = readFileSync(join(process.cwd(), "supabase/migrations/MANIFEST.md"), "utf8");

const ARQUIVO = "20261014100000_0955_cupons_de_desconto_na_compra_do_plano.sql";
const migration = readFileSync(join(process.cwd(), "supabase/migrations", ARQUIVO), "utf8");

function marcador(n: string): string {
  const achado = BASELINE.match(new RegExp(`^-- ---- .*\\(migration ${n}, fork Hiperbold[^\\n]*$`, "m"));
  if (!achado) throw new Error(`bloco da ${n} não está no baseline`);
  return achado[0];
}

function extraiBloco(n: string): string {
  const m = marcador(n);
  const inicio = BASELINE.lastIndexOf(m);
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + m.length);
  return BASELINE.slice(inicio, fim + 1);
}

function codigo(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0 && !linha.startsWith("--"))
    .join("\n");
}

const c = codigo(migration);

describe("0955: posição, igualdade e registro", () => {
  it("bloco único no baseline, depois da 0954 e antes da VARREDURA anon (cria função)", () => {
    const inicio = BASELINE.lastIndexOf(marcador("0955"));
    expect(BASELINE.split(marcador("0955")).length - 1).toBe(1);
    expect(inicio).toBeGreaterThan(BASELINE.lastIndexOf(marcador("0954")));
    expect(inicio).toBeLessThan(BASELINE.lastIndexOf("-- ---- VARREDURA anon:"));
  });

  it("o SQL da migration e o do bloco são iguais, ignorando comentários", () => {
    expect(codigo(extraiBloco("0955"))).toBe(c);
  });

  it("registrada no MANIFEST", () => {
    expect(MANIFEST).toContain("`0955_cupons_de_desconto_na_compra_do_plano`");
  });

  it("sem travessão, sem apagar dado, e os únicos drops são as assinaturas antigas de fn_billing_criar_pedido e do resolver", () => {
    expect(migration.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(c).not.toMatch(/drop table|delete from|truncate table/);
    expect(c.match(/drop function/g)?.length).toBe(3);
    expect(c).toMatch(/drop function if exists public\.fn_billing_criar_pedido\(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer\);/);
    expect(c).toMatch(/drop function if exists public\.fn_billing_criar_pedido\(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer, text\);/);
    expect(c).toMatch(/drop function if exists public\.fn_billing_cupom_resolver\(uuid, text, text, text, integer, boolean, boolean\);/);
  });
});

describe("0955: o que ela faz", () => {
  it("billing_cupons: de plataforma, RLS ligada, sem policy e sem escrita para nenhum papel", () => {
    expect(c).toContain("create table if not exists public.billing_cupons");
    const inicio = c.indexOf("create table if not exists public.billing_cupons");
    const tabela = c.slice(inicio, c.indexOf("\n);", inicio));
    expect(tabela.length).toBeGreaterThan(100);
    expect(tabela).not.toContain("organization_id");
    expect(c).toContain("alter table public.billing_cupons enable row level security;");
    expect(c).not.toMatch(/create policy/);
    expect(c).toContain("revoke all on public.billing_cupons from anon, authenticated;");
    expect(c).toContain("revoke insert, update, delete, truncate on public.billing_cupons from service_role;");
    expect(c).toContain("grant select on public.billing_cupons to service_role;");
  });

  it("as colunas novas de billing_orders só nascem quando faltam, e o check de coerência é guardado", () => {
    expect(c).toContain("add column if not exists cupom_id uuid references public.billing_cupons(id)");
    expect(c).toContain("add column if not exists desconto_cents integer not null default 0");
    expect(c).toContain("add column if not exists preco_cheio_cents integer");
    expect(c).toMatch(/if not exists \(select 1 from pg_constraint where conname = 'billing_orders_cupom_coerente'\)/);
  });

  it("o parâmetro novo de fn_billing_criar_pedido é o último e tem default nulo", () => {
    expect(c).toMatch(/p_total_cents integer default null,\s+p_cupom_codigo text default null,\s+p_pagador_impressao text default null\s*\)/);
  });

  it("o código é comparado como citext (citext = text compararia com diferença de maiúsculas)", () => {
    expect(c).toContain("where codigo = v_codigo::citext");
    expect(c).not.toMatch(/where codigo = v_codigo[^:]/);
  });

  it("as recusas existem com 22023", () => {
    for (const codigoDoErro of [
      "billing_cupom_invalido",
      "billing_cupom_expirado",
      "billing_cupom_nao_vale_para_o_plano",
      "billing_cupom_nao_vale_para_o_ciclo",
      "billing_cupom_ja_usado",
      "billing_cupom_esgotado",
      "billing_cupom_sem_desconto",
      "billing_cupom_parcela_minima",
    ]) {
      expect(c).toContain(`raise exception '${codigoDoErro}' using errcode = '22023'`);
    }
  });

  it("todas as funções são security definer com search_path fixo, e a ACL é repetida na mesma transação", () => {
    expect(c.match(/^begin;$/gm)?.length).toBe(1);
    expect(c.match(/^commit;$/gm)?.length).toBe(1);
    expect(c.match(/security definer/g)?.length).toBeGreaterThanOrEqual(6);
    expect(c).toMatch(/revoke execute on function public\.fn_billing_criar_pedido\(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer, text, text\) from public, anon, authenticated;/);
    expect(c).toMatch(/grant execute on function public\.fn_billing_criar_pedido\(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer, text, text\) to service_role;/);
    for (const assinatura of [
      "fn_billing_cupom_simular(uuid, text, text, text, integer)",
      "fn_billing_cupom_criar(text, text, integer, text[], text[], timestamptz, integer, text, uuid)",
      "fn_billing_cupom_definir_ativo(uuid, boolean, uuid)",
      "fn_billing_cupom_listar()",
    ]) {
      const escapada = assinatura.replace(/[()[\]]/g, "\\$&");
      expect(c).toMatch(new RegExp(`revoke execute on function public\\.${escapada} from public, anon, authenticated;`));
      expect(c).toMatch(new RegExp(`grant execute on function public\\.${escapada} to service_role;`));
    }
    expect(c).toContain("revoke execute on function public.fn_billing_cupom_desconto(text, integer, integer) from public, anon, authenticated, service_role;");
    expect(c).toContain("revoke execute on function public.fn_billing_cupom_resolver(uuid, text, text, text, integer, boolean, boolean, text) from public, anon, authenticated, service_role;");
  });

  it("fn_billing_asaas_aplicar_pagamento NÃO é redefinida (a conciliação continua a mesma)", () => {
    expect(c).not.toContain("fn_billing_asaas_aplicar_pagamento");
  });
});
