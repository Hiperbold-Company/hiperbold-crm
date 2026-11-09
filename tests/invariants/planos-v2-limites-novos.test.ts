import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * PLANOS V2 E OS SEIS LIMITES NOVOS, migration 1001 (D-227, fork Hiperbold).
 *
 *  1. `fn_billing_limites_validos` aceita o plano com 7 chaves OU 13, recusa o
 *     meio-termo, a chave desconhecida e liga/desliga fora de 0/1; o ajuste
 *     aceita subconjunto com chave nova;
 *  2. a versão 2 de pro, max e escale existe com os preços e limites da
 *     decisão, e é a ativa e à venda; a versão 1 saiu de venda e ficou íntegra;
 *  3. `fn_billing_limites_efetivos` devolve as 13 chaves: contrato na v1 tem as
 *     novas como null (sem limite), contrato na v2 tem os valores, o ajuste
 *     parcial com chave nova sobrepõe, e o Ilimitado segue todo null;
 *  4. reaplicar a migration não duplica nem sobrescreve o que o admin mudou.
 *
 * Fala com o Postgres pelo mesmo transporte dos outros invariantes de plano, e
 * roda como `postgres`: tudo aqui é regra de negócio, não RLS.
 */

const ORG_V1 = "10010000-0000-4000-8000-000000000001";
const ORG_V2 = "10010000-0000-4000-8000-000000000002";
const ORG_SEM_CONTRATO = "10010000-0000-4000-8000-000000000003";

const MARCA = "SONDA|";

function sonda(corpo: string): string[] {
  return sql(corpo)
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

function valida(limites: string, parcial: boolean): string {
  return sonda(`select 'SONDA|' || public.fn_billing_limites_validos('${limites}'::jsonb, ${parcial});`)[0] ?? "";
}

const SETE = {
  funis: 5,
  etapas_por_funil: 10,
  leads: 5000,
  membros: 3,
  conexoes: 3,
  integracoes_webhook: 3,
  tokens_ia_mes: 3000000,
};
const SEIS = {
  agentes_ia: 1,
  automacoes: 10,
  mcp_req_min: 0,
  acesso_api: 0,
  automacao_comentario_instagram: 0,
  fonte_dados_req_min: 60,
};

const json = (o: Record<string, unknown>) => JSON.stringify(o);

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_V1}', 'planos-v2-inv-v1', 'Planos V2 Invariante V1 LTDA', 'Planos V2 V1'),
      ('${ORG_V2}', 'planos-v2-inv-v2', 'Planos V2 Invariante V2 LTDA', 'Planos V2 V2'),
      ('${ORG_SEM_CONTRATO}', 'planos-v2-inv-sem', 'Planos V2 Invariante Sem LTDA', 'Planos V2 Sem')
    on conflict (id) do nothing;

    update public.billing_contracts
       set plan_id = (select id from public.billing_plans where code = 'pro' and version = 1)
     where organization_id = '${ORG_V1}';
    update public.billing_contracts
       set plan_id = (select id from public.billing_plans where code = 'pro' and version = 2)
     where organization_id = '${ORG_V2}';
    delete from public.billing_contracts where organization_id = '${ORG_SEM_CONTRATO}';
  `);
});

describe("1. fn_billing_limites_validos: 7 ou 13, nunca meio-termo", () => {
  it("aceita o plano com as 7 chaves originais e com as 13", () => {
    expect(valida(json(SETE), false)).toBe("true");
    expect(valida(json({ ...SETE, ...SEIS }), false)).toBe("true");
    const tudoNulo = Object.fromEntries(Object.keys({ ...SETE, ...SEIS }).map((k) => [k, null]));
    expect(valida(json(tudoNulo), false)).toBe("true");
  });

  it("recusa o plano com parte das chaves novas", () => {
    expect(valida(json({ ...SETE, agentes_ia: 1 }), false)).toBe("false");
    const { fonte_dados_req_min: _fora, ...cinco } = SEIS;
    expect(valida(json({ ...SETE, ...cinco }), false)).toBe("false");
    const { funis: _semFunis, ...seisOriginais } = SETE;
    expect(valida(json({ ...seisOriginais, ...SEIS }), false)).toBe("false");
  });

  it("recusa chave desconhecida, no plano e no ajuste", () => {
    expect(valida(json({ ...SETE, ...SEIS, chave_estranha: 1 }), false)).toBe("false");
    expect(valida(json({ chave_estranha: 1 }), true)).toBe("false");
  });

  it("liga/desliga só aceita 0, 1 ou null; as demais chaves novas, inteiro até o teto", () => {
    expect(valida(json({ acesso_api: 2 }), true)).toBe("false");
    expect(valida(json({ automacao_comentario_instagram: 2 }), true)).toBe("false");
    expect(valida(json({ acesso_api: 1, automacao_comentario_instagram: null }), true)).toBe("true");
    expect(valida(json({ mcp_req_min: 2147483647 }), true)).toBe("true");
    expect(valida(json({ mcp_req_min: 2147483648 }), true)).toBe("false");
    expect(valida(json({ agentes_ia: 1.5 }), true)).toBe("false");
    expect(valida(json({ automacoes: "3" }), true)).toBe("false");
  });

  it("o ajuste aceita subconjunto com chave nova, inclusive só ela", () => {
    expect(valida(json({ mcp_req_min: 5 }), true)).toBe("true");
    expect(valida(json({ funis: 8, acesso_api: 1 }), true)).toBe("true");
    expect(valida("{}", true)).toBe("true");
  });
});

describe("2. o catálogo: v2 à venda, v1 fora de venda e íntegra", () => {
  it("a v2 de cada plano tem os preços e os limites da decisão de 05/11/2026", () => {
    const linhas = sonda(`
      select 'SONDA|' || code || ',' || name || ',' || active || ',' || for_sale || ',' ||
             price_monthly_cents || ',' || price_semiannual_cents || ',' || price_yearly_cents || ',' ||
             grace_days
        from public.billing_plans where version = 2 order by price_monthly_cents;
    `);
    expect(linhas).toEqual([
      "pro,Pro,true,true,14900,79900,139900,7",
      "max,Max,true,true,29900,159900,284900,7",
      "escale,Scale,true,true,44900,239900,429900,7",
    ]);

    const limites = sonda(`
      select 'SONDA|' || code || '=' || limits::text from public.billing_plans where version = 2;
    `);
    const porCodigo = Object.fromEntries(
      limites.map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), JSON.parse(l.slice(i + 1))];
      }),
    );
    expect(porCodigo.pro).toEqual({ ...SETE, ...SEIS });
    expect(porCodigo.max).toEqual({
      funis: 10, etapas_por_funil: 15, leads: 50000, membros: 15, conexoes: 10,
      integracoes_webhook: 10, tokens_ia_mes: 3000000, agentes_ia: 3, automacoes: 20,
      mcp_req_min: 30, acesso_api: 1, automacao_comentario_instagram: 1, fonte_dados_req_min: 60,
    });
    expect(porCodigo.escale).toEqual({
      funis: 25, etapas_por_funil: 20, leads: 100000, membros: 30, conexoes: 20,
      integracoes_webhook: 20, tokens_ia_mes: 3000000, agentes_ia: 10, automacoes: 30,
      mcp_req_min: 60, acesso_api: 1, automacao_comentario_instagram: 1, fonte_dados_req_min: 120,
    });
  });

  it("a versão em vigor e à venda de cada código pago é a 2", () => {
    const linhas = sonda(`
      select 'SONDA|' || code || ',' || version from public.billing_plans
       where active and for_sale order by code;
    `);
    expect(linhas).toEqual(["escale,2", "max,2", "pro,2"]);
  });

  it("a v1 continua lá, com o preço e as 7 chaves de antes, só fora de venda e de vigor", () => {
    const linhas = sonda(`
      select 'SONDA|' || code || ',' || active || ',' || for_sale || ',' || price_monthly_cents || ',' ||
             (select count(*) from jsonb_object_keys(limits))
        from public.billing_plans where version = 1 and code in ('pro', 'max', 'escale')
       order by price_monthly_cents;
    `);
    expect(linhas).toEqual(["pro,false,false,19900,7", "max,false,false,39900,7", "escale,false,false,59900,7"]);
  });

  it("o Ilimitado segue ativo, fora de venda e sem limite nenhum", () => {
    const linhas = sonda(`
      select 'SONDA|' || active || ',' || for_sale || ',' ||
             (select count(*) from jsonb_each(limits) where jsonb_typeof(value) <> 'null')
        from public.billing_plans where code = 'ilimitado' and active;
    `);
    expect(linhas).toEqual(["true,false,0"]);
  });
});

function efetivos(org: string): Record<string, number | null> {
  const [linha] = sonda(`select 'SONDA|' || public.fn_billing_limites_efetivos('${org}')::text;`);
  return JSON.parse(linha ?? "null");
}

describe("3. fn_billing_limites_efetivos: as 13 chaves", () => {
  it("contrato na v1: as 7 de antes valem, as 6 novas saem null (sem limite)", () => {
    expect(efetivos(ORG_V1)).toEqual({
      ...SETE,
      agentes_ia: null,
      automacoes: null,
      mcp_req_min: null,
      acesso_api: null,
      automacao_comentario_instagram: null,
      fonte_dados_req_min: null,
    });
  });

  it("contrato na v2: as 13 do plano", () => {
    expect(efetivos(ORG_V2)).toEqual({ ...SETE, ...SEIS });
  });

  it("sem contrato: o Ilimitado, as 13 null", () => {
    const e = efetivos(ORG_SEM_CONTRATO);
    expect(Object.keys(e)).toHaveLength(13);
    expect(Object.values(e).every((v) => v === null)).toBe(true);
  });

  it("ajuste parcial com chave nova sobrepõe só ela, e null libera", () => {
    const [linha] = sonda(`
      begin;
      select public.fn_billing_ajustar_limites(
        '${ORG_V2}', '{"mcp_req_min": 5, "acesso_api": 1, "agentes_ia": null}'::jsonb, 'invariante 1001', null
      );
      select 'SONDA|' || public.fn_billing_limites_efetivos('${ORG_V2}')::text;
      rollback;
    `);
    expect(JSON.parse(linha ?? "null")).toEqual({ ...SETE, ...SEIS, mcp_req_min: 5, acesso_api: 1, agentes_ia: null });
  });

  it("ajuste com liga/desliga fora de 0/1 é recusado pelo CHECK", () => {
    expect(() =>
      sql(`select public.fn_billing_ajustar_limites('${ORG_V2}', '{"acesso_api": 2}'::jsonb, null, null);`),
    ).toThrow();
  });
});

describe("4. reaplicar a migration", () => {
  it("não duplica versão nem sobrescreve preço ou venda que o admin mudou depois", () => {
    const migration = readFileSync(
      join(process.cwd(), "supabase", "migrations", "20261109130000_1001_planos_v2_limites_novos.sql"),
      "utf8",
    );
    const linhas = sonda(`
      begin;
      update public.billing_plans set price_monthly_cents = 12345, for_sale = false where code = 'pro' and version = 2;
      ${migration}
      select 'SONDA|' || count(*) from public.billing_plans where code in ('pro', 'max', 'escale');
      select 'SONDA|' || price_monthly_cents || ',' || for_sale || ',' || active
        from public.billing_plans where code = 'pro' and version = 2;
      select 'SONDA|' || active || ',' || for_sale from public.billing_plans where code = 'pro' and version = 1;
      rollback;
    `);
    expect(linhas).toEqual(["6", "12345,false,true", "false,false"]);
  });
});
