import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql } from "./gov-helpers";

/**
 * Migration 0986 — isolamento entre organizações nas AUTOMAÇÕES.
 *
 *  1. `fn_automacao_iniciar` (service role, ignora RLS) não cruza organização:
 *     automação de outra org → `inativa`; contato de outra org → `contato_invalido`;
 *  2. pela REST (papel `authenticated`), o membro de A não lê automação nem
 *     execução (com as `vars`) de B, e lê as suas;
 *  3. `authenticated` não chama a RPC (o grant é só do service_role).
 */
const ORG_A = "0986dddd-0000-4000-8000-000000000001";
const ORG_B = "0986eeee-0000-4000-8000-000000000002";
const USER_A = "0986dddd-1111-4000-8000-000000000001";
const CONTATO_A = "0986dddd-3333-4000-8000-000000000001";
const CONTATO_B = "0986eeee-3333-4000-8000-000000000002";
const V_A = "0986dddd-5555-4000-8000-000000000001";
const V_B = "0986eeee-5555-4000-8000-000000000002";
const P_A = "0986dddd-6666-4000-8000-000000000001";
const P_B = "0986eeee-6666-4000-8000-000000000002";

const GRAFO = JSON.stringify({
  nodes: [
    {
      id: "t",
      type: "trigger",
      label: "Início",
      position: { x: 0, y: 0 },
      config: { triggers: [{ kind: "manual" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
    },
    { id: "f", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "e1", source: "t", target: "f", priority: 0, condition: { type: "always" } }],
});

function iniciar(org: string, pointer: string, contato: string): string {
  const out = sql(`select (public.fn_automacao_iniciar('${org}', '${pointer}', '${contato}',
    '{"gatilho":{"tipo":"manual"},"segredo":"so-da-org"}'::jsonb, null, null))->>'resultado';`);
  return out.split("\n").at(-1)!;
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${USER_A}', 'auto-0986-a@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-0986-iso-a', 'Inv 0986 Iso A', 'Iso A'),
      ('${ORG_B}', 'inv-0986-iso-b', 'Inv 0986 Iso B', 'Iso B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USER_A}', '${ORG_A}', 'manager', now()) on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A}', '${ORG_A}', 'Contato A'), ('${CONTATO_B}', '${ORG_B}', 'Contato B') on conflict do nothing;
    insert into public.followup_flow_versions (id, organization_id, graph) values
      ('${V_A}', '${ORG_A}', '${GRAFO}'::jsonb), ('${V_B}', '${ORG_B}', '${GRAFO}'::jsonb) on conflict do nothing;
    insert into public.followup_flow_pointers (id, organization_id, name, status, active_version_id, surface) values
      ('${P_A}', '${ORG_A}', 'Iso A', 'active', '${V_A}', 'automacao'),
      ('${P_B}', '${ORG_B}', 'Iso B', 'active', '${V_B}', 'automacao') on conflict do nothing;
    delete from public.followup_enrollments where organization_id in ('${ORG_A}', '${ORG_B}');
  `);
});

describe("0986 — automações não cruzam organização", () => {
  it("a RPC recusa automação e contato de outra organização", () => {
    expect(iniciar(ORG_A, P_B, CONTATO_A)).toBe("inativa");
    expect(iniciar(ORG_A, P_A, CONTATO_B)).toBe("contato_invalido");
    expect(iniciar(ORG_A, P_A, CONTATO_A)).toBe("iniciada");
    expect(iniciar(ORG_B, P_B, CONTATO_B)).toBe("iniciada");
  });

  it("o membro de A lê as automações e execuções de A, e nenhuma de B", () => {
    expect(countAs(USER_A, `select count(*) from public.followup_flow_pointers where id = '${P_A}';`)).toBe(1);
    expect(countAs(USER_A, `select count(*) from public.followup_flow_pointers where id = '${P_B}';`)).toBe(0);
    expect(countAs(USER_A, `select count(*) from public.followup_enrollments where organization_id = '${ORG_A}';`)).toBe(1);
    expect(
      countAs(USER_A, `select count(*) from public.followup_enrollments where organization_id = '${ORG_B}' or vars ? 'segredo' and organization_id <> '${ORG_A}';`),
    ).toBe(0);
  });

  it("authenticated não executa fn_automacao_iniciar", () => {
    expect(() =>
      sql(`set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${USER_A}"}', false);
        select public.fn_automacao_iniciar('${ORG_A}', '${P_A}', '${CONTATO_A}', '{}'::jsonb, null, null);`),
    ).toThrow(/permission denied/);
  });
});
