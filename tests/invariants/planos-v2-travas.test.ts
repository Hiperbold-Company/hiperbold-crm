import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * PLANOS V2: AS TRAVAS DE AGENTES DE IA E DE AUTOMAÇÕES, migration 1002 (D-227, fork Hiperbold).
 *
 *  1. Pro (1 agente, 10 automações): o 2º agente e a 11ª automação dão PT402 com `detail` certo, no modo
 *     `avisar` (os dois itens bloqueiam sempre, como Conexões);
 *  2. Max (3 agentes): o 3º passa, o 4º é recusado;
 *  3. desarquivar um agente acima do teto é recusado; arquivar libera a vaga;
 *  4. organização do Pro que já tem 2 agentes continua com os 2 (nada é apagado nem arquivado);
 *  5. follow-up e roteiro não contam como automação;
 *  6. o cadastro do próprio visitante nasce no Max;
 *  7. isolamento: o uso de uma organização não conta na outra.
 */

const ORG_PRO = "10020000-0000-4000-8000-000000000001";
const ORG_MAX = "10020000-0000-4000-8000-000000000002";
const ORG_ACIMA = "10020000-0000-4000-8000-000000000003";
const ORG_TRIAL = "10020000-0000-4000-8000-000000000004";

const MARCA = "SONDA|";

function sonda(corpo: string): string[] {
  return sql(corpo)
    .split("\n")
    .filter((l) => l.startsWith(MARCA))
    .map((l) => l.slice(MARCA.length));
}

function erroDe(script: string): string | null {
  try {
    sql(`\\set VERBOSITY verbose\n${script}`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

const agente = (org: string, nome: string, extra = "") =>
  `insert into public.ai_agents (organization_id, name, system_prompt${extra ? ", archived_at" : ""})
     values ('${org}', '${nome}', 'p'${extra ? `, ${extra}` : ""});`;

const automacao = (org: string, nome: string, surface = "automacao") =>
  `insert into public.followup_flow_pointers (organization_id, name, surface) values ('${org}', '${nome}', '${surface}');`;

const noPlano = (org: string, code: string) =>
  `update public.billing_contracts
      set plan_id = (select id from public.billing_plans where code = '${code}' and version = 2)
    where organization_id = '${org}';`;

const uso = (org: string, item: string) =>
  sonda(`select 'SONDA|' || (public.fn_billing_uso('${org}') ->> '${item}');`)[0];

beforeAll(() => {
  sql(`
    update public.billing_settings set modo = 'avisar' where id = 1;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_PRO}', 'travas-v2-pro', 'Travas V2 Pro', 'Travas V2 Pro'),
      ('${ORG_MAX}', 'travas-v2-max', 'Travas V2 Max', 'Travas V2 Max'),
      ('${ORG_ACIMA}', 'travas-v2-acima', 'Travas V2 Acima', 'Travas V2 Acima')
    on conflict (id) do nothing;
    ${noPlano(ORG_PRO, "pro")}
    ${noPlano(ORG_MAX, "pro")}
    -- A organização "acima do teto" ganha 2 agentes ANTES de cair no Pro (estava no Ilimitado).
    ${agente(ORG_ACIMA, "acima-1")}
    ${agente(ORG_ACIMA, "acima-2")}
    ${noPlano(ORG_ACIMA, "pro")}
  `);
});

describe("agentes de IA", () => {
  it("Pro: o 1º agente passa, o 2º dá PT402 agentes_ia (modo avisar)", () => {
    expect(erroDe(agente(ORG_PRO, "pro-1"))).toBeNull();
    const erro = erroDe(agente(ORG_PRO, "pro-2"));
    expect(erro).toContain("PT402");
    expect(erro).toContain("agentes_ia");
    expect(uso(ORG_PRO, "agentes_ia")).toBe("1");
  });

  it("rascunho arquivado não conta; desarquivar acima do teto é recusado", () => {
    expect(erroDe(agente(ORG_PRO, "pro-arquivado", "now()"))).toBeNull();
    const erro = erroDe(
      `update public.ai_agents set archived_at = null where organization_id = '${ORG_PRO}' and name = 'pro-arquivado';`,
    );
    expect(erro).toContain("PT402");
    expect(erro).toContain("agentes_ia");
  });

  it("arquivar libera a vaga e desarquivar volta a caber", () => {
    expect(
      erroDe(`
        update public.ai_agents set archived_at = now() where organization_id = '${ORG_PRO}' and name = 'pro-1';
        update public.ai_agents set archived_at = null where organization_id = '${ORG_PRO}' and name = 'pro-arquivado';`),
    ).toBeNull();
    expect(uso(ORG_PRO, "agentes_ia")).toBe("1");
  });

  it("Max: o 3º agente passa, o 4º é recusado", () => {
    sql(noPlano(ORG_MAX, "max"));
    for (const n of [1, 2, 3]) expect(erroDe(agente(ORG_MAX, `max-${n}`)), `max-${n}`).toBeNull();
    const erro = erroDe(agente(ORG_MAX, "max-4"));
    expect(erro).toContain("PT402");
    expect(erro).toContain("agentes_ia");
  });

  it("Pro que já tinha 2 agentes continua com os 2, editáveis, e não cria o 3º", () => {
    expect(uso(ORG_ACIMA, "agentes_ia")).toBe("2");
    expect(
      erroDe(`update public.ai_agents set name = name || '-editado' where organization_id = '${ORG_ACIMA}';`),
    ).toBeNull();
    expect(
      sonda(`select 'SONDA|' || count(*) from public.ai_agents where organization_id = '${ORG_ACIMA}' and archived_at is null;`)[0],
    ).toBe("2");
    expect(erroDe(agente(ORG_ACIMA, "acima-3"))).toContain("agentes_ia");
  });
});

describe("automações", () => {
  it("Pro: a 10ª passa, a 11ª dá PT402 automacoes; follow-up e roteiro não contam", () => {
    const dez = Array.from({ length: 10 }, (_, i) => automacao(ORG_PRO, `auto-${i + 1}`)).join("\n");
    expect(erroDe(dez)).toBeNull();
    const erro = erroDe(automacao(ORG_PRO, "auto-11"));
    expect(erro).toContain("PT402");
    expect(erro).toContain("automacoes");
    expect(erroDe(automacao(ORG_PRO, "um-followup", "followup"))).toBeNull();
    expect(uso(ORG_PRO, "automacoes")).toBe("10");
  });

  it("excluir uma automação libera a vaga", () => {
    expect(
      erroDe(`
        delete from public.followup_flow_pointers where organization_id = '${ORG_PRO}' and name = 'auto-10';
        ${automacao(ORG_PRO, "auto-nova")}`),
    ).toBeNull();
  });
});

describe("isolamento e pode_criar", () => {
  it("o uso de uma organização não conta na outra", () => {
    expect(uso(ORG_MAX, "automacoes")).toBe("0");
    expect(erroDe(automacao(ORG_MAX, "max-auto-1"))).toBeNull();
    expect(uso(ORG_MAX, "agentes_ia")).toBe("3");
    expect(uso(ORG_PRO, "agentes_ia")).toBe("1");
  });

  it("fn_billing_pode_criar conhece os dois itens", () => {
    const [linha] = sonda(`
      select 'SONDA|' || (public.fn_billing_pode_criar('${ORG_PRO}', 'agentes_ia') ->> 'pode') || ','
        || (public.fn_billing_pode_criar('${ORG_MAX}', 'automacoes') ->> 'pode');`);
    expect(linha).toBe("false,true");
  });
});

describe("organização nova", () => {
  it("o cadastro do próprio visitante nasce no Max", () => {
    const [linha] = sonda(`
      insert into public.organizations (id, slug, legal_name, display_name, settings)
        values ('${ORG_TRIAL}', 'travas-v2-trial', 'X', 'X', '{"billing_inicio":"sem_plano"}'::jsonb)
        on conflict (id) do nothing;
      select 'SONDA|' || bp.code || '|' || bc.status from public.billing_contracts bc
        join public.billing_plans bp on bp.id = bc.plan_id where bc.organization_id = '${ORG_TRIAL}';`);
    expect(linha).toBe("max|suspensa");
  });
});
