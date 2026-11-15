/**
 * Migration 1013: mover o MESMO negócio para uma etapa de outro funil, só pelo caminho nomeado.
 *
 * Provado no Postgres real:
 *  - o UPDATE solto que troca `pipeline_id` (com a etapa coerente, que a 0934 deixava passar) é
 *    recusado, como dono do banco e como `authenticated` com papel de gerente;
 *  - `fn_mover_negocio_para_outro_funil` (service_role) move: id, contato, responsável e
 *    `custom_fields` intactos, funil/etapa/posição novos, `stage_changed_at` carimbado;
 *  - isolamento entre duas organizações: etapa ou negócio de outra empresa = "não encontrado",
 *    sem mover nada; `anon` e `authenticated` não executam a função;
 *  - etapa do mesmo funil e trava otimista vencida são recusadas.
 *
 * Roda via `pnpm test:db tests/invariants/mover-negocio-entre-funis.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_CONTACT_1, GOV_MANAGER, GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov } from "./gov-helpers";
import { motivoDoErro, sql } from "./psql-transporte";

const ORG_B = "10130000-a5aa-4000-8000-000000000002";
const PIPE_A2 = "10130000-c0c0-4000-8000-000000000001";
const ETAPA_A2 = "10130000-c0c0-4000-8000-000000000002";
const PIPE_B = "10130000-c0c0-4000-8000-000000000003";
const ETAPA_B = "10130000-c0c0-4000-8000-000000000004";
const CONTATO_B = "10130000-c0c0-4000-8000-000000000005";
const LEAD = "10130000-d0d0-4000-8000-000000000001";
const LEAD_B = "10130000-d0d0-4000-8000-000000000002";
const LEAD_TRAVA = "10130000-d0d0-4000-8000-000000000003";

function recusado(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return motivoDoErro(err);
  }
  return "";
}

function comoServico(corpo: string): string {
  return sql(`set role service_role;\n${corpo}`);
}

function como(usuario: string, corpo: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${usuario}","role":"authenticated","aal":"aal2"}', false);
    ${corpo}
  `);
}

const mover = (org: string, lead: string, etapa: string, esperado = "null") =>
  comoServico(`select public.fn_mover_negocio_para_outro_funil('${org}', '${lead}', '${etapa}', null, ${esperado});`);

const linha = (lead: string) =>
  sql(`select pipeline_id || '|' || stage_id || '|' || coalesce(contact_id::text,'') || '|' || coalesce(owner_user_id::text,'') || '|' || custom_fields::text
         from public.crm_leads where id = '${lead}';`).split("\n").pop();

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'mover-1013-b', 'Mover 1013 B', 'Mover 1013 B') on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name) values ('${CONTATO_B}', '${ORG_B}', 'Contato B 1013') on conflict (id) do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPE_A2}', '${GOV_ORG}', 'Pós-venda 1013', 'pos-venda-1013'),
      ('${PIPE_B}', '${ORG_B}', 'Funil B 1013', 'funil-b-1013') on conflict (id) do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${ETAPA_A2}', '${GOV_ORG}', '${PIPE_A2}', 'Triagem 1013', 'triagem-1013', 1000),
      ('${ETAPA_B}', '${ORG_B}', '${PIPE_B}', 'Novo B 1013', 'novo-b-1013', 1000) on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id, owner_user_id, custom_fields, stage_changed_at) values
      ('${LEAD}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead 1013', '${GOV_CONTACT_1}', '${GOV_MANAGER}', '{"cpf":"123","origem":"site"}', now() - interval '3 days'),
      ('${LEAD_TRAVA}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_STAGE}', 'Lead trava 1013', null, null, '{}', now()),
      ('${LEAD_B}', '${ORG_B}', '${PIPE_B}', '${ETAPA_B}', 'Lead B 1013', '${CONTATO_B}', null, '{}', now())
      on conflict (id) do nothing;
  `);
});

describe("1013: a troca de funil por UPDATE solto continua recusada", () => {
  it("dono do banco e gerente (authenticated) não trocam pipeline_id, mesmo com etapa coerente", () => {
    const solto = `update public.crm_leads set pipeline_id = '${PIPE_A2}', stage_id = '${ETAPA_A2}' where id = '${LEAD_TRAVA}';`;
    expect(recusado(() => sql(solto))).toContain("pipeline_immutable_use_clone");
    expect(recusado(() => como(GOV_MANAGER, solto))).toContain("pipeline_immutable_use_clone");
    expect(linha(LEAD_TRAVA)).toMatch(new RegExp(`^${GOV_PIPELINE}\\|${GOV_STAGE}\\|`));
  });

  it("a chave de liberação vale só para o negócio dela: chave de outro id não abre", () => {
    expect(
      recusado(() =>
        sql(`begin;
          select set_config('deskcomm.mover_entre_funis', '${LEAD}', true);
          update public.crm_leads set pipeline_id = '${PIPE_A2}', stage_id = '${ETAPA_A2}' where id = '${LEAD_TRAVA}';
          commit;`),
      ),
    ).toContain("pipeline_immutable_use_clone");
  });

  it("mexer em outra coluna ou reenviar o mesmo funil não dispara a trava", () => {
    expect(recusado(() => sql(`update public.crm_leads set title = 'Lead trava 1013 b', pipeline_id = '${GOV_PIPELINE}' where id = '${LEAD_TRAVA}';`))).toBe("");
  });
});

describe("1013: isolamento entre duas organizações e quem pode chamar", () => {
  it("etapa de outra organização: 'Etapa não encontrada', e nada se move", () => {
    expect(recusado(() => mover(GOV_ORG, LEAD, ETAPA_B))).toContain("Etapa não encontrada");
    expect(recusado(() => mover(ORG_B, LEAD_B, ETAPA_A2))).toContain("Etapa não encontrada");
    expect(linha(LEAD)).toMatch(new RegExp(`^${GOV_PIPELINE}\\|${GOV_STAGE}\\|`));
    expect(linha(LEAD_B)).toMatch(new RegExp(`^${PIPE_B}\\|${ETAPA_B}\\|`));
  });

  it("negócio de outra organização: 'Negócio não encontrado', mesmo com etapa da organização informada", () => {
    expect(recusado(() => mover(GOV_ORG, LEAD_B, ETAPA_A2))).toContain("Negócio não encontrado");
    expect(linha(LEAD_B)).toMatch(new RegExp(`^${PIPE_B}\\|${ETAPA_B}\\|`));
  });

  it("anon e authenticated não executam a função", () => {
    const chamada = `select public.fn_mover_negocio_para_outro_funil('${GOV_ORG}', '${LEAD}', '${ETAPA_A2}');`;
    expect(recusado(() => sql(`set role anon;\n${chamada}`))).toContain("permission denied");
    expect(recusado(() => como(GOV_MANAGER, chamada))).toContain("permission denied");
  });
});

describe("1013: a troca pelo caminho nomeado", () => {
  it("etapa do mesmo funil e trava otimista vencida são recusadas", () => {
    expect(recusado(() => mover(GOV_ORG, LEAD, GOV_STAGE))).toContain("mesmo funil");
    expect(recusado(() => mover(GOV_ORG, LEAD, ETAPA_A2, "'2000-01-01T00:00:00Z'"))).toContain("concorrentemente");
  });

  it("move o MESMO negócio: id, contato, responsável e campos intactos; funil, etapa e carimbo novos", () => {
    const atualizado = sql(`select updated_at from public.crm_leads where id = '${LEAD}';`).split("\n").pop();
    const saida = mover(GOV_ORG, LEAD, ETAPA_A2, `'${atualizado}'`).split("\n").pop() ?? "";
    expect(JSON.parse(saida)).toMatchObject({
      lead_id: LEAD,
      from_pipeline_id: GOV_PIPELINE,
      from_stage_id: GOV_STAGE,
      to_pipeline_id: PIPE_A2,
      to_stage_id: ETAPA_A2,
    });
    expect(linha(LEAD)).toBe(`${PIPE_A2}|${ETAPA_A2}|${GOV_CONTACT_1}|${GOV_MANAGER}|{"cpf": "123", "origem": "site"}`);
    expect(sql(`select count(*) from public.crm_leads where id = '${LEAD}';`).split("\n").pop()).toBe("1");
    expect(sql(`select stage_changed_at > now() - interval '1 minute' from public.crm_leads where id = '${LEAD}';`).split("\n").pop()).toBe("t");
    // A chave de transação não vaza: depois da troca, o UPDATE solto volta a ser recusado.
    expect(
      recusado(() => sql(`update public.crm_leads set pipeline_id = '${GOV_PIPELINE}', stage_id = '${GOV_STAGE}' where id = '${LEAD}';`)),
    ).toContain("pipeline_immutable_use_clone");
  });
});
