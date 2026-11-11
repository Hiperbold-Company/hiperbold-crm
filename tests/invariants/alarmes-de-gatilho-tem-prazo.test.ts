/**
 * D-074 (migration 1009): `fn_podar_alarmes_de_gatilho` apaga o alarme de gatilho de plano vencido, com o
 * piso de 90 dias no CORPO. Medido em Postgres real, como `service_role` (o papel do cron).
 *
 * Previsão (sabotagem): trocar `greatest(..., 90)` por `coalesce(p_retencao_dias, 90)` faz o caso
 * "knob 1 dia" apagar também o alarme de 30 dias, e ele fica vermelho.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "d1009000-0000-4000-8000-000000000001";

function alarme(idadeDias: number): void {
  sql(`insert into public.billing_trigger_alarmes (organization_id, gatilho, falha, criado_em)
         values ('${ORG}', 'fn_billing_trava_crm_leads', 'sonda 1009', now() - interval '${idadeDias} days');`);
}

function podarComoServidor(args: string): number {
  return Number(lastLine(sql(`set role service_role; select public.fn_podar_alarmes_de_gatilho(${args});`)));
}

const idades = (): string =>
  sql(`select coalesce(string_agg((extract(day from now() - criado_em))::int::text, ',' order by criado_em), '')
         from public.billing_trigger_alarmes where organization_id = '${ORG}';`);

beforeAll(() => {
  sql(`insert into public.organizations (id, slug, legal_name, display_name)
         values ('${ORG}', 'org-1009', 'Org 1009 LTDA', 'Org 1009') on conflict (id) do nothing;`);
});

beforeEach(() => {
  sql(`delete from public.billing_trigger_alarmes where organization_id = '${ORG}';`);
});

describe("fn_podar_alarmes_de_gatilho: o piso de 90 dias mora no corpo", () => {
  it("knob de 1 dia é elevado a 90: sai o de 120, ficam o de 60 e o de 1", () => {
    alarme(120);
    alarme(60);
    alarme(1);
    expect(podarComoServidor("1, 10000")).toBe(1);
    expect(idades()).toBe("60,1");
  });

  it("sem argumento usa 90: sai só o de 91", () => {
    alarme(91);
    alarme(89);
    expect(podarComoServidor("")).toBe(1);
    expect(idades()).toBe("89");
  });

  it("knob acima do piso é respeitado: com 200, o de 150 fica", () => {
    alarme(250);
    alarme(150);
    expect(podarComoServidor("200, 10000")).toBe(1);
    expect(idades()).toBe("150");
  });

  it("apaga em lote: limite 2 com três vencidos apaga 2, a rodada seguinte apaga o resto", () => {
    alarme(300);
    alarme(200);
    alarme(100);
    expect(podarComoServidor("90, 2")).toBe(2);
    expect(idades()).toBe("100");
    expect(podarComoServidor("90, 2")).toBe(1);
    expect(idades()).toBe("");
  });
});

describe("a porta é só a função, e só para o servidor", () => {
  it.each(["anon", "authenticated"])("%s não executa", (papel) => {
    expect(
      sql(`select has_function_privilege('${papel}', 'public.fn_podar_alarmes_de_gatilho(int,int)', 'EXECUTE');`),
    ).toBe("f");
  });

  it("controle positivo: service_role executa", () => {
    expect(
      sql(`select has_function_privilege('service_role', 'public.fn_podar_alarmes_de_gatilho(int,int)', 'EXECUTE');`),
    ).toBe("t");
  });

  it("service_role continua sem DELETE direto na tabela", () => {
    expect(sql(`select has_table_privilege('service_role', 'public.billing_trigger_alarmes', 'DELETE');`)).toBe("f");
  });

  it("é security definer com search_path public, pg_temp", () => {
    expect(
      sql(`select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc
            where oid = 'public.fn_podar_alarmes_de_gatilho(int,int)'::regprocedure;`),
    ).toBe("true|search_path=public, pg_temp");
  });

  it("o índice em criado_em existe", () => {
    expect(sql(`select count(*) from pg_indexes where schemaname = 'public' and indexname = 'billing_trigger_alarmes_criado_em_idx';`)).toBe("1");
  });
});
