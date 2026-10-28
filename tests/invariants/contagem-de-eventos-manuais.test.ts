import { beforeAll, describe, expect, it } from "vitest";

import { countAs, indexExists, sql } from "./gov-helpers";

/**
 * MIGRATION 0979 — `fn_contar_eventos_manuais_do_funil`, contra Postgres real.
 *
 * O filtro "Eventos manuais" do quadro do funil compara um número por negócio, e
 * esse número é desta função. O que se prova aqui:
 *
 *  - CONTA SÓ o registro manual (`type = 'note'` E `source_module = 'manual'`):
 *    nota de outra origem e evento manual de outro tipo não entram;
 *  - por NEGÓCIO e só do FUNIL pedido; negócio sem evento manual não aparece;
 *  - ISOLAMENTO: a organização vem do parâmetro E da RLS do chamador — membro
 *    de outra organização recebe zero linhas mesmo passando o id certo; com
 *    visibilidade `own`, o atendente só conta os negócios dele;
 *  - `anon` não executa a função; o índice parcial existe.
 *
 * Namespace 0979aaaa = exclusivo deste arquivo.
 */
const ORG = "0979aaaa-0000-4000-8000-000000000001";
const ORG_OUTRA = "0979aaaa-0000-4000-8000-000000000002";
const AGENTE_A = "0979aaaa-1111-4000-8000-000000000001";
const AGENTE_B = "0979aaaa-1111-4000-8000-000000000002";
const GERENTE = "0979aaaa-1111-4000-8000-000000000003";
const INTRUSO = "0979aaaa-1111-4000-8000-000000000004";
const PIPELINE = "0979aaaa-5555-4000-8000-000000000001";
const PIPELINE_2 = "0979aaaa-5555-4000-8000-000000000002";
const STAGE = "0979aaaa-5555-4000-8000-000000000011";
const STAGE_2 = "0979aaaa-5555-4000-8000-000000000012";
const LEAD_A = "0979aaaa-6666-4000-8000-000000000001";
const LEAD_B = "0979aaaa-6666-4000-8000-000000000002";
const LEAD_SEM = "0979aaaa-6666-4000-8000-000000000003";
const LEAD_OUTRO_FUNIL = "0979aaaa-6666-4000-8000-000000000004";

function manual(lead: string, autor: string, n: number): string {
  return Array.from(
    { length: n },
    () =>
      `('${ORG}', '${lead}', 'note', 'manual', 'user', '${autor}', 'Registro manual', '{"subtype":"ligacao","text":"x"}'::jsonb)`,
  ).join(",\n");
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENTE_A}', 'c-a@invariant.test'), ('${AGENTE_B}', 'c-b@invariant.test'),
      ('${GERENTE}', 'c-g@invariant.test'), ('${INTRUSO}', 'c-i@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG}', 'contagem-ev', 'Contagem Org', 'Contagem', jsonb_build_object('visibility_mode', 'own')),
      ('${ORG_OUTRA}', 'contagem-ev-outra', 'Outra Org', 'Outra', '{}'::jsonb)
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENTE_A}', '${ORG}', 'agent', now()), ('${AGENTE_B}', '${ORG}', 'agent', now()),
      ('${GERENTE}', '${ORG}', 'manager', now()), ('${INTRUSO}', '${ORG_OUTRA}', 'admin', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPELINE}', '${ORG}', 'Funil', 'funil-contagem'),
      ('${PIPELINE_2}', '${ORG}', 'Funil 2', 'funil-contagem-2')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${STAGE}', '${ORG}', '${PIPELINE}', 'Novo', 'novo', 1000),
      ('${STAGE_2}', '${ORG}', '${PIPELINE_2}', 'Novo', 'novo', 1000)
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id) values
      ('${LEAD_A}', '${ORG}', '${PIPELINE}', '${STAGE}', 'Negócio A', '${AGENTE_A}'),
      ('${LEAD_B}', '${ORG}', '${PIPELINE}', '${STAGE}', 'Negócio B', '${AGENTE_B}'),
      ('${LEAD_SEM}', '${ORG}', '${PIPELINE}', '${STAGE}', 'Sem eventos', '${AGENTE_A}'),
      ('${LEAD_OUTRO_FUNIL}', '${ORG}', '${PIPELINE_2}', '${STAGE_2}', 'Outro funil', '${AGENTE_A}')
      on conflict do nothing;
    insert into public.crm_lead_activities
      (organization_id, lead_id, type, source_module, actor_kind, performed_by_user_id, reason, payload) values
      ${manual(LEAD_A, AGENTE_A, 6)},
      ${manual(LEAD_B, AGENTE_B, 2)},
      ${manual(LEAD_OUTRO_FUNIL, AGENTE_A, 3)};
    -- O que NÃO é registro manual e não pode contar:
    insert into public.crm_lead_activities (organization_id, lead_id, type, source_module, actor_kind, reason) values
      ('${ORG}', '${LEAD_A}', 'note', 'ai', 'system', 'nota do agente'),
      ('${ORG}', '${LEAD_A}', 'stage_changed', 'crm', 'system', 'mudou de etapa'),
      ('${ORG}', '${LEAD_SEM}', 'note', 'automation', 'system', 'nota de automação');
  `);
});

/** Linhas `lead_id|total` que a função devolve ao usuário (JWT simulado). */
function contagemComo(userId: string, org = ORG, funil = PIPELINE): Map<string, number> {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    select lead_id || '|' || total from public.fn_contar_eventos_manuais_do_funil('${org}', '${funil}');
  `);
  const mapa = new Map<string, number>();
  for (const linha of out.split("\n")) {
    const m = /^([0-9a-f-]{36})\|(\d+)$/.exec(linha.trim());
    if (m) mapa.set(m[1]!, Number(m[2]));
  }
  return mapa;
}

describe("0979 — contagem de eventos manuais por negócio", () => {
  it("o gerente (visão total) conta só o registro manual, por negócio, só deste funil", () => {
    const mapa = contagemComo(GERENTE);
    expect(mapa.get(LEAD_A)).toBe(6); // nota do agente e stage_changed não entram
    expect(mapa.get(LEAD_B)).toBe(2);
    expect(mapa.has(LEAD_SEM)).toBe(false); // nota de automação não é manual: zero = ausente
    expect(mapa.has(LEAD_OUTRO_FUNIL)).toBe(false);
    expect(mapa.size).toBe(2);
  });

  it("o outro funil tem a sua própria contagem", () => {
    expect(contagemComo(GERENTE, ORG, PIPELINE_2).get(LEAD_OUTRO_FUNIL)).toBe(3);
  });

  it("visibilidade 'own': o atendente conta só os negócios dele (a RLS do chamador vale)", () => {
    const deA = contagemComo(AGENTE_A);
    expect(deA.get(LEAD_A)).toBe(6);
    expect(deA.has(LEAD_B)).toBe(false);
  });

  it("membro de OUTRA organização não conta nada, nem passando o id da organização certa", () => {
    expect(contagemComo(INTRUSO).size).toBe(0);
    expect(contagemComo(INTRUSO, ORG_OUTRA).size).toBe(0);
  });

  it("controle: o mesmo membro, com a organização errada no parâmetro, também não conta nada", () => {
    expect(contagemComo(GERENTE, ORG_OUTRA).size).toBe(0);
  });

  it("anon não executa a função; authenticated executa", () => {
    expect(
      sql(
        `select has_function_privilege('anon', 'public.fn_contar_eventos_manuais_do_funil(uuid, uuid)', 'execute');`,
      )
        .trim()
        .split("\n")
        .pop(),
    ).toBe("f");
    expect(
      countAs(
        GERENTE,
        `select count(*) from public.fn_contar_eventos_manuais_do_funil('${ORG}', '${PIPELINE}')`,
      ),
    ).toBe(2);
  });

  it("o índice parcial dos eventos manuais existe", () => {
    expect(indexExists("idx_lead_activities_manuais_por_lead")).toBe(true);
  });
});
