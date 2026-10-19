import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * "Quem move um lead sem responsável assume": o UPDATE CONDICIONAL de
 * `lib/leads/assumir-ao-mover.ts`, contra Postgres real.
 *
 * É ele — e não a leitura que a rota fez antes — que decide quem vira dono:
 * `where owner_user_id is null and owner_agent_id is null`. Prova-se que:
 *  - lead sem responsável: assume, com o trio de posse coerente (CHECK da 0070) e
 *    `assigned_at`;
 *  - lead com dono HUMANO e lead com dono AGENTE: o UPDATE não os toca (0 linhas,
 *    dono intacto);
 *  - dois UPDATEs CONCORRENTES sobre o mesmo lead: só um vence (o segundo, que
 *    espera o lock da linha, reavalia o predicado depois do commit do primeiro e
 *    não acha mais nada).
 */
const ORG = "0971aaaa-0000-4000-8000-000000000001";
const U1 = "0971aaaa-1111-4000-8000-000000000001";
const U2 = "0971aaaa-1111-4000-8000-000000000002";
const DONO = "0971aaaa-1111-4000-8000-000000000003";
const AGENTE = "0971aaaa-2222-4000-8000-000000000001";
const PIPE = "0971aaaa-3333-4000-8000-000000000001";
const STAGE = "0971aaaa-4444-4000-8000-000000000001";
const L_LIVRE = "0971aaaa-5555-4000-8000-000000000001";
const L_HUMANO = "0971aaaa-5555-4000-8000-000000000002";
const L_AGENTE = "0971aaaa-5555-4000-8000-000000000003";
const L_CORRIDA = "0971aaaa-5555-4000-8000-000000000004";
const L_SESSAO = "0971aaaa-5555-4000-8000-000000000005";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${U1}', 'ao-mover-1@invariant.test'), ('${U2}', 'ao-mover-2@invariant.test'), ('${DONO}', 'ao-mover-d@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'ao-mover', 'Ao Mover Org', 'Ao Mover') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${U1}', '${ORG}', 'agent', now()), ('${U2}', '${ORG}', 'agent', now()), ('${DONO}', '${ORG}', 'agent', now())
      on conflict do nothing;
    insert into public.ai_agents (id, organization_id, name, system_prompt, is_active)
      values ('${AGENTE}', '${ORG}', 'Agente', 'p', true) on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPE}', '${ORG}', 'Funil', 'funil-am') on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE}', '${ORG}', '${PIPE}', 'Novo', 'novo', 1000) on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id, owner_agent_id, owner_kind) values
      ('${L_LIVRE}', '${ORG}', '${PIPE}', '${STAGE}', 'Livre', null, null, null),
      ('${L_HUMANO}', '${ORG}', '${PIPE}', '${STAGE}', 'Do humano', '${DONO}', null, 'user'),
      ('${L_AGENTE}', '${ORG}', '${PIPE}', '${STAGE}', 'Do agente', null, '${AGENTE}', 'ai'),
      ('${L_CORRIDA}', '${ORG}', '${PIPE}', '${STAGE}', 'Corrida', null, null, null),
      ('${L_SESSAO}', '${ORG}', '${PIPE}', '${STAGE}', 'Sessão', null, null, null)
      on conflict do nothing;
  `);
});

/** O UPDATE de `assumirAoMover`, com o mesmo predicado e o trio de `resolveOwnerPatch`. */
const assumir = (lead: string, quem: string) => `
  update public.crm_leads
     set owner_user_id = '${quem}', owner_agent_id = null, owner_kind = 'user',
         assigned_at = now(), updated_at = now()
   where id in ('${lead}') and organization_id = '${ORG}'
     and owner_user_id is null and owner_agent_id is null
  returning id`;

const dono = (lead: string) =>
  sql(`select coalesce(owner_user_id::text,'-') || '|' || coalesce(owner_agent_id::text,'-') || '|' || coalesce(owner_kind,'-') from public.crm_leads where id='${lead}';`);

describe("UPDATE condicional de 'assumir ao mover'", () => {
  it("lead sem responsável: assume, com trio coerente e assigned_at", () => {
    const r = sql(`with w as (${assumir(L_LIVRE, U1)}) select count(*) from w;`);
    expect(r).toBe("1");
    expect(dono(L_LIVRE)).toBe(`${U1}|-|user`);
    expect(sql(`select assigned_at is not null from public.crm_leads where id='${L_LIVRE}';`)).toBe("t");
  });

  it("lead com dono HUMANO: 0 linhas, dono intacto", () => {
    expect(sql(`with w as (${assumir(L_HUMANO, U1)}) select count(*) from w;`)).toBe("0");
    expect(dono(L_HUMANO)).toBe(`${DONO}|-|user`);
  });

  it("lead com dono AGENTE de IA: 0 linhas, agente intacto", () => {
    expect(sql(`with w as (${assumir(L_AGENTE, U1)}) select count(*) from w;`)).toBe("0");
    expect(dono(L_AGENTE)).toBe(`-|${AGENTE}|ai`);
  });

  it("pela sessão do atendente (RLS ligada): assume o negócio sem dono que ele enxerga", () => {
    const r = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${U2}"}', false);
      with w as (${assumir(L_SESSAO, U2)}) select count(*) from w;
    `);
    expect(r.split("\n").pop()).toBe("1");
    expect(dono(L_SESSAO)).toBe(`${U2}|-|user`);
  });

  it("DOIS UPDATEs CONCORRENTES: só um vence, e o dono é o do primeiro", async () => {
    const container = process.env.TEST_DB_CONTAINER as string;
    const run = (script: string) =>
      promisify(execFile)("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-c", script]);
    // A sessão 1 segura o lock da linha por 1,5 s antes de confirmar; a 2 chega no
    // meio, espera o lock e, sob READ COMMITTED, REAVALIA o predicado depois do
    // commit da 1: o dono já não é nulo, e ela não acha linha.
    const primeira = run(`begin; with w as (${assumir(L_CORRIDA, U1)}) select 'p1:' || count(*) from w; select pg_sleep(1.5); commit;`);
    await new Promise((r) => setTimeout(r, 500));
    const segunda = run(`with w as (${assumir(L_CORRIDA, U2)}) select 'p2:' || count(*) from w;`);
    const [a, b] = await Promise.all([primeira, segunda]);
    expect(a.stdout).toContain("p1:1");
    expect(b.stdout).toContain("p2:0");
    expect(dono(L_CORRIDA)).toBe(`${U1}|-|user`);
  });
});
