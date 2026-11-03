import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0986 — a raia das AUTOMAÇÕES no motor dos follow-ups, cobrada no
 * banco que o clone recebe (baseline aplicado por `scripts/test-db.sh`).
 *
 * Sob prova:
 *  1. a vaga única do FOLLOW-UP continua igual (um vivo por contato na org);
 *  2. a automação tem vaga própria: duas automações em paralelo para o mesmo
 *     contato, e o follow-up dele ao lado;
 *  3. a mesma automação duas vezes para o mesmo contato é recusada (23505 na
 *     escrita direta; `ja_em_execucao` + evento na RPC);
 *  4. o mesmo evento drenado de novo não abre execução (`duplicada`);
 *  5. a raia vem da superfície e é imutável;
 *  6. reentrada `restart` cancela a viva e abre outra;
 *  7. anonimizar o contato zera `vars` e encerra a automação viva;
 *  8. `fn_automacao_iniciar` não é alcançável por anon/authenticated.
 *
 * Namespace `0986aaaa-…`: os arquivos de invariante rodam em paralelo contra o
 * MESMO container.
 */
const ORG = "0986aaaa-0000-4000-8000-000000000001";
const CONTATO = "0986aaaa-3333-4000-8000-000000000001";
const CONTATO_LGPD = "0986aaaa-3333-4000-8000-000000000002";
const V_AUTO = "0986aaaa-5555-4000-8000-000000000001";
const V_RESTART = "0986aaaa-5555-4000-8000-000000000002";
const V_FOLLOW = "0986aaaa-5555-4000-8000-000000000003";
const P_A = "0986aaaa-6666-4000-8000-000000000001";
const P_B = "0986aaaa-6666-4000-8000-000000000002";
const P_RESTART = "0986aaaa-6666-4000-8000-000000000003";
const P_FOLLOW_1 = "0986aaaa-6666-4000-8000-000000000004";
const P_FOLLOW_2 = "0986aaaa-6666-4000-8000-000000000005";

function grafo(policy: "skip_if_running" | "restart"): string {
  return JSON.stringify({
    nodes: [
      {
        id: "t",
        type: "trigger",
        label: "Início",
        position: { x: 0, y: 0 },
        config: { triggers: [{ kind: "manual" }], reentry: { policy, cooldown_minutes: 0 } },
      },
      { id: "f", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "converted" } },
    ],
    edges: [{ id: "e1", source: "t", target: "f", priority: 0, condition: { type: "always" } }],
  });
}

const GRAFO_FOLLOW = JSON.stringify({
  nodes: [
    { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    { id: "f", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "e1", source: "t", target: "f", priority: 0, condition: { type: "always" } }],
});

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("passou — a trava não existe neste banco");
}

function iniciar(pointer: string, contato: string, evento: string | null = null): { resultado: string; enrollment_id?: string } {
  const out = sql(
    `select public.fn_automacao_iniciar('${ORG}', '${pointer}', '${contato}', '{"gatilho":{"tipo":"manual"}}'::jsonb, ${
      evento ? `'${evento}'` : "null"
    }, null)::text;`,
  );
  return JSON.parse(out.split("\n").at(-1)!);
}

function inserirFollowup(pointer: string, versao: string): void {
  sql(`insert into public.followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status)
       values ('${ORG}', '${pointer}', '${versao}', '${CONTATO}', 't', 'active');`);
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'inv-0986-a', 'Inv 0986 A', 'Inv 0986 A') on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO}', '${ORG}', 'Contato 0986'),
      ('${CONTATO_LGPD}', '${ORG}', 'Contato LGPD 0986')
      on conflict do nothing;
    insert into public.followup_flow_versions (id, organization_id, graph) values
      ('${V_AUTO}', '${ORG}', '${grafo("skip_if_running")}'::jsonb),
      ('${V_RESTART}', '${ORG}', '${grafo("restart")}'::jsonb),
      ('${V_FOLLOW}', '${ORG}', '${GRAFO_FOLLOW}'::jsonb)
      on conflict do nothing;
    insert into public.followup_flow_pointers (id, organization_id, name, status, active_version_id, surface) values
      ('${P_A}', '${ORG}', 'Auto A 0986', 'active', '${V_AUTO}', 'automacao'),
      ('${P_B}', '${ORG}', 'Auto B 0986', 'active', '${V_AUTO}', 'automacao'),
      ('${P_RESTART}', '${ORG}', 'Auto R 0986', 'active', '${V_RESTART}', 'automacao'),
      ('${P_FOLLOW_1}', '${ORG}', 'Follow 1 0986', 'active', '${V_FOLLOW}', 'followup'),
      ('${P_FOLLOW_2}', '${ORG}', 'Follow 2 0986', 'active', '${V_FOLLOW}', 'followup')
      on conflict do nothing;
    delete from public.followup_enrollments where organization_id = '${ORG}';
  `);
});

describe("0986 — raia de automação e vagas", () => {
  it("a superfície 'automacao' é aceita pelo CHECK e as colunas novas existem", () => {
    const out = sql(`select count(*) from information_schema.columns
      where table_schema='public' and table_name='followup_enrollments'
        and column_name in ('lane','vars','origin_event_id','parent_enrollment_id');`);
    expect(out.split("\n").at(-1)).toBe("4");
  });

  it("follow-up: a vaga única por contato continua valendo, e a raia nasce 'followup'", () => {
    inserirFollowup(P_FOLLOW_1, V_FOLLOW);
    expect(erroDe(() => inserirFollowup(P_FOLLOW_2, V_FOLLOW))).toMatch(/idx_followup_enrollments_one_live|duplicate key/);
    const raia = sql(`select lane from public.followup_enrollments where pointer_id='${P_FOLLOW_1}';`);
    expect(raia.split("\n").at(-1)).toBe("followup");
  });

  it("duas automações rodam em paralelo para o mesmo contato, ao lado do follow-up", () => {
    const a = iniciar(P_A, CONTATO);
    const b = iniciar(P_B, CONTATO);
    expect(a.resultado).toBe("iniciada");
    expect(b.resultado).toBe("iniciada");
    const out = sql(`select lane || ':' || status from public.followup_enrollments
      where organization_id='${ORG}' and contact_id='${CONTATO}' and pointer_id in ('${P_A}','${P_B}') order by lane;`);
    expect(out.split("\n")).toEqual(["automacao:active", "automacao:active"]);
  });

  it("a mesma automação de novo: ja_em_execucao na RPC (com evento na execução viva) e 23505 na escrita direta", () => {
    const r = iniciar(P_A, CONTATO);
    expect(r.resultado).toBe("ja_em_execucao");
    const ev = sql(`select count(*) from public.followup_enrollment_events ev
      join public.followup_enrollments e on e.id = ev.enrollment_id
      where e.pointer_id='${P_A}' and ev.event_type='trigger_ignored_running';`);
    expect(Number(ev.split("\n").at(-1))).toBeGreaterThanOrEqual(1);
    expect(
      erroDe(() =>
        sql(`insert into public.followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status)
             values ('${ORG}', '${P_A}', '${V_AUTO}', '${CONTATO}', 't', 'active');`),
      ),
    ).toMatch(/idx_followup_enrollments_automacao_live|duplicate key/);
  });

  it("o mesmo evento drenado de novo não abre segunda execução", () => {
    const evento = "0986aaaa-7777-4000-8000-000000000001";
    sql(`update public.followup_enrollments set status='completed', completed_at=now(), next_eval_at=null
         where pointer_id='${P_B}' and organization_id='${ORG}';`);
    expect(iniciar(P_B, CONTATO, evento).resultado).toBe("iniciada");
    sql(`update public.followup_enrollments set status='completed', completed_at=now(), next_eval_at=null
         where pointer_id='${P_B}' and organization_id='${ORG}';`);
    expect(iniciar(P_B, CONTATO, evento).resultado).toBe("duplicada");
  });

  it("a raia é imutável", () => {
    expect(
      erroDe(() => sql(`update public.followup_enrollments set lane='followup' where pointer_id='${P_A}';`)),
    ).toMatch(/imutável/);
  });

  it("reentrada 'restart' cancela a execução viva e abre outra", () => {
    expect(iniciar(P_RESTART, CONTATO).resultado).toBe("iniciada");
    expect(iniciar(P_RESTART, CONTATO).resultado).toBe("reiniciada");
    const out = sql(`select status || ':' || coalesce(cancel_reason,'') from public.followup_enrollments
      where pointer_id='${P_RESTART}' order by started_at, status;`);
    expect(out.split("\n").sort()).toEqual(["active:", "cancelled:reiniciada"]);
  });

  it("anonimizar o contato zera vars e encerra a automação viva", () => {
    expect(iniciar(P_A, CONTATO_LGPD).resultado).toBe("iniciada");
    sql(`update public.contacts set is_anonymized = true, anonymized_at = now() where id='${CONTATO_LGPD}';`);
    const out = sql(`select status || ':' || vars::text from public.followup_enrollments where contact_id='${CONTATO_LGPD}';`);
    expect(out.split("\n").at(-1)).toBe("cancelled:{}");
  });

  it("fn_automacao_iniciar não é executável por anon nem por authenticated", () => {
    const out = sql(`select has_function_privilege('anon', 'public.fn_automacao_iniciar(uuid,uuid,uuid,jsonb,uuid,uuid)', 'execute')
      || ':' || has_function_privilege('authenticated', 'public.fn_automacao_iniciar(uuid,uuid,uuid,jsonb,uuid,uuid)', 'execute');`);
    expect(out.split("\n").at(-1)).toBe("false:false");
  });
});
