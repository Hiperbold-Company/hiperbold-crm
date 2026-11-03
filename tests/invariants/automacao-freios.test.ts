import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0986 — os freios de `fn_automacao_iniciar`, no banco que o clone
 * recebe (baseline aplicado por `scripts/test-db.sh`).
 *
 * Sob prova:
 *  1. com reentrada `restart`, uma tentativa barrada pela espera (cooldown) ou
 *     pelo teto por hora NÃO cancela a execução que estava viva (B7);
 *  2. automações em cadeia: A → B → A é cortada (`ciclo`), com UM aviso na
 *     Central por automação, sem duplicar (B6);
 *  3. cadeia de 5 passos é cortada (`cadeia_longa`).
 *
 * Namespace `0986ffff-…`: os arquivos de invariante rodam em paralelo contra o
 * MESMO container.
 */
const ORG = "0986ffff-0000-4000-8000-000000000001";
const CONTATO = "0986ffff-3333-4000-8000-000000000001";
const CONTATO_TETO = "0986ffff-3333-4000-8000-000000000002";
const CONTATO_CADEIA = "0986ffff-3333-4000-8000-000000000003";
const V_RESTART_ESPERA = "0986ffff-5555-4000-8000-000000000001";
const V_RESTART = "0986ffff-5555-4000-8000-000000000002";
const V_SIMPLES = "0986ffff-5555-4000-8000-000000000003";
const P_ESPERA = "0986ffff-6666-4000-8000-000000000001";
const P_TETO = "0986ffff-6666-4000-8000-000000000002";
const P_A = "0986ffff-6666-4000-8000-000000000003";
const P_B = "0986ffff-6666-4000-8000-000000000004";
const P_CADEIA = ["0986ffff-6666-4000-8000-000000000010", "0986ffff-6666-4000-8000-000000000011",
  "0986ffff-6666-4000-8000-000000000012", "0986ffff-6666-4000-8000-000000000013",
  "0986ffff-6666-4000-8000-000000000014", "0986ffff-6666-4000-8000-000000000015"];

function grafo(policy: "skip_if_running" | "restart", cooldown: number): string {
  return JSON.stringify({
    nodes: [
      {
        id: "t",
        type: "trigger",
        label: "Início",
        position: { x: 0, y: 0 },
        config: { triggers: [{ kind: "manual" }], reentry: { policy, cooldown_minutes: cooldown } },
      },
      { id: "f", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "converted" } },
    ],
    edges: [{ id: "e1", source: "t", target: "f", priority: 0, condition: { type: "always" } }],
  });
}

function iniciar(pointer: string, contato: string, pai: string | null = null): { resultado: string; enrollment_id?: string } {
  const out = sql(
    `select public.fn_automacao_iniciar('${ORG}', '${pointer}', '${contato}', '{"gatilho":{"tipo":"manual"}}'::jsonb, null, ${
      pai ? `'${pai}'` : "null"
    })::text;`,
  );
  return JSON.parse(out.split("\n").at(-1)!);
}

function statusDe(id: string): string {
  return sql(`select status from public.followup_enrollments where id='${id}';`).split("\n").at(-1)!;
}

beforeAll(() => {
  const ponteirosCadeia = P_CADEIA.map(
    (p, i) => `('${p}', '${ORG}', 'Cadeia ${i} 0986', 'active', '${V_SIMPLES}', 'automacao')`,
  ).join(",\n      ");
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'inv-0986-f', 'Inv 0986 F', 'Inv 0986 F') on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO}', '${ORG}', 'Contato freio 0986'),
      ('${CONTATO_TETO}', '${ORG}', 'Contato teto 0986'),
      ('${CONTATO_CADEIA}', '${ORG}', 'Contato cadeia 0986')
      on conflict do nothing;
    insert into public.followup_flow_versions (id, organization_id, graph) values
      ('${V_RESTART_ESPERA}', '${ORG}', '${grafo("restart", 60)}'::jsonb),
      ('${V_RESTART}', '${ORG}', '${grafo("restart", 0)}'::jsonb),
      ('${V_SIMPLES}', '${ORG}', '${grafo("skip_if_running", 0)}'::jsonb)
      on conflict do nothing;
    insert into public.followup_flow_pointers (id, organization_id, name, status, active_version_id, surface) values
      ('${P_ESPERA}', '${ORG}', 'Espera 0986', 'active', '${V_RESTART_ESPERA}', 'automacao'),
      ('${P_TETO}', '${ORG}', 'Teto 0986', 'active', '${V_RESTART}', 'automacao'),
      ('${P_A}', '${ORG}', 'A 0986', 'active', '${V_SIMPLES}', 'automacao'),
      ('${P_B}', '${ORG}', 'B 0986', 'active', '${V_SIMPLES}', 'automacao'),
      ${ponteirosCadeia}
      on conflict do nothing;
    delete from public.agent_inbox_items where organization_id = '${ORG}';
    delete from public.followup_enrollments where organization_id = '${ORG}';
  `);
});

describe("0986 — freios do início de uma automação", () => {
  it("restart barrado pela espera não cancela a execução viva", () => {
    // Uma execução anterior terminou há pouco (dentro da espera de 60 min).
    sql(`insert into public.followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status, completed_at)
         values ('${ORG}', '${P_ESPERA}', '${V_RESTART_ESPERA}', '${CONTATO}', 'f', 'completed', now() - interval '5 minutes');`);
    const viva = sql(`insert into public.followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status)
         values ('${ORG}', '${P_ESPERA}', '${V_RESTART_ESPERA}', '${CONTATO}', 't', 'active') returning id;`)
      .split("\n")
      .find((l) => /^[0-9a-f-]{36}$/.test(l.trim()))!
      .trim();
    expect(iniciar(P_ESPERA, CONTATO).resultado).toBe("em_espera");
    expect(statusDe(viva)).toBe("active");
  });

  it("restart barrado pelo teto por hora não cancela a execução viva", () => {
    for (let i = 0; i < 10; i++) {
      sql(`insert into public.followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status, completed_at, cancel_reason)
           values ('${ORG}', '${P_TETO}', '${V_RESTART}', '${CONTATO_TETO}', 'f', 'cancelled', now(), 'reiniciada');`);
    }
    const viva = sql(`update public.followup_enrollments set status='active', completed_at=null, cancel_reason=null
         where id = (select id from public.followup_enrollments where pointer_id='${P_TETO}' limit 1) returning id;`)
      .split("\n")
      .find((l) => /^[0-9a-f-]{36}$/.test(l.trim()))!
      .trim();
    expect(iniciar(P_TETO, CONTATO_TETO).resultado).toBe("limite_por_hora");
    expect(statusDe(viva)).toBe("active");
  });

  it("A → B → A é cortado como ciclo, com um aviso só na Central", () => {
    const a = iniciar(P_A, CONTATO);
    expect(a.resultado).toBe("iniciada");
    const b = iniciar(P_B, CONTATO, a.enrollment_id!);
    expect(b.resultado).toBe("iniciada");
    expect(iniciar(P_A, CONTATO, b.enrollment_id!).resultado).toBe("ciclo");
    expect(iniciar(P_A, CONTATO, b.enrollment_id!).resultado).toBe("ciclo");
    const avisos = sql(`select count(*) from public.agent_inbox_items
      where organization_id='${ORG}' and ref_kind='followup_flow_pointer' and ref_id='${P_A}' and status='open';`);
    expect(avisos.split("\n").at(-1)).toBe("1");
    // A execução viva de A não foi tocada.
    expect(statusDe(a.enrollment_id!)).toBe("active");
  });

  it("cadeia de 5 passos é cortada", () => {
    let pai: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r = iniciar(P_CADEIA[i]!, CONTATO_CADEIA, pai);
      expect(r.resultado).toBe("iniciada");
      pai = r.enrollment_id!;
    }
    expect(iniciar(P_CADEIA[5]!, CONTATO_CADEIA, pai).resultado).toBe("cadeia_longa");
  });
});
