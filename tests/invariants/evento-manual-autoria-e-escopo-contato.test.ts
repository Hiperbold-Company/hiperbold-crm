import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql, writeCountAs } from "./gov-helpers";

/**
 * Ficha do negócio: evento manual + timeline do contato, contra Postgres real.
 *
 * (1) MIGRATION 0970 — a autoria e a data do evento manual não se forjam pela
 *     REST. A rota grava pelo cliente da sessão (RLS); a policy restritiva
 *     `crm_lead_activities_manual_autoria` é o que impede o mesmo membro, falando
 *     direto com o PostgREST, de assinar com o nome de um colega ou de datar no
 *     futuro.
 * (2) ESCOPO CONTATO em visibilidade `own` — a consulta que a rota faz com o
 *     JWT do atendente (atividades cujo negócio pertence ao contato) só devolve o
 *     que ele pode ver: o negócio de outro dono não vaza pela história do contato.
 *
 * Namespace 0970aaaa = exclusivo deste arquivo (cada arquivo roda em banco
 * próprio, mas o namespace evita colisão com seeds compartilhados).
 */
const ORG = "0970aaaa-0000-4000-8000-000000000001";
const AGENTE_A = "0970aaaa-1111-4000-8000-000000000001";
const AGENTE_B = "0970aaaa-1111-4000-8000-000000000002";
const CONTATO = "0970aaaa-3333-4000-8000-000000000001";
const PIPELINE = "0970aaaa-5555-4000-8000-000000000001";
const STAGE = "0970aaaa-5555-4000-8000-000000000002";
const LEAD_A = "0970aaaa-6666-4000-8000-000000000001";
const LEAD_B = "0970aaaa-6666-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${AGENTE_A}', 'ev-a@invariant.test'), ('${AGENTE_B}', 'ev-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG}', 'ev-manual', 'Evento Manual Org', 'Evento Manual',
              jsonb_build_object('visibility_mode', 'own'))
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${AGENTE_A}', '${ORG}', 'agent', now()), ('${AGENTE_B}', '${ORG}', 'agent', now())
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO}', '${ORG}', 'Contato com dois negócios') on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPELINE}', '${ORG}', 'Funil', 'funil-ev') on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE}', '${ORG}', '${PIPELINE}', 'Novo', 'novo', 1000) on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id, owner_user_id) values
      ('${LEAD_A}', '${ORG}', '${PIPELINE}', '${STAGE}', 'Negócio do A', '${CONTATO}', '${AGENTE_A}'),
      ('${LEAD_B}', '${ORG}', '${PIPELINE}', '${STAGE}', 'Negócio do B', '${CONTATO}', '${AGENTE_B}')
      on conflict do nothing;
    insert into public.crm_lead_activities (organization_id, lead_id, contact_id, type, source_module, actor_kind, reason) values
      ('${ORG}', '${LEAD_A}', '${CONTATO}', 'stage_changed', 'seed', 'system', 'seed A'),
      ('${ORG}', '${LEAD_A}', null, 'lead_edited', 'seed', 'system', 'seed A sem contato'),
      ('${ORG}', '${LEAD_B}', '${CONTATO}', 'stage_changed', 'seed', 'system', 'seed B'),
      ('${ORG}', '${LEAD_B}', null, 'lead_edited', 'seed', 'system', 'seed B sem contato');
  `);
});

/** Insere uma atividade como o usuário (JWT simulado); devolve linhas gravadas (0 = RLS recusou). */
function inserir(
  userId: string,
  campos: { fonte: string; autor: string | null; ator: string; quando: string },
): number {
  const autor = campos.autor ? `'${campos.autor}'` : "null";
  return writeCountAs(
    userId,
    `insert into public.crm_lead_activities
       (organization_id, lead_id, contact_id, type, source_module, actor_kind, performed_by_user_id, performed_at, reason, payload)
     values ('${ORG}', '${LEAD_A}', '${CONTATO}', 'note', '${campos.fonte}', '${campos.ator}', ${autor},
             ${campos.quando}, 'probe', '{"subtype":"nota","text":"probe"}'::jsonb)`,
  );
}

describe("0970 — evento manual: autoria e data não se forjam pela REST", () => {
  it("o próprio autor, agora: passa", () => {
    expect(inserir(AGENTE_A, { fonte: "manual", autor: AGENTE_A, ator: "user", quando: "now()" })).toBe(1);
  });

  it("o próprio autor, no passado: passa", () => {
    expect(
      inserir(AGENTE_A, { fonte: "manual", autor: AGENTE_A, ator: "user", quando: "now() - interval '40 days'" }),
    ).toBe(1);
  });

  it("até 5 minutos à frente (relógio adiantado): passa", () => {
    expect(
      inserir(AGENTE_A, { fonte: "manual", autor: AGENTE_A, ator: "user", quando: "now() + interval '2 minutes'" }),
    ).toBe(1);
  });

  it("autor de COLEGA: recusado", () => {
    expect(inserir(AGENTE_A, { fonte: "manual", autor: AGENTE_B, ator: "user", quando: "now()" })).toBe(0);
  });

  it("sem autor: recusado", () => {
    expect(inserir(AGENTE_A, { fonte: "manual", autor: null, ator: "user", quando: "now()" })).toBe(0);
  });

  it("data no futuro: recusada", () => {
    expect(
      inserir(AGENTE_A, { fonte: "manual", autor: AGENTE_A, ator: "user", quando: "now() + interval '1 day'" }),
    ).toBe(0);
  });

  it("ator que não é 'user': recusado", () => {
    expect(inserir(AGENTE_A, { fonte: "manual", autor: AGENTE_A, ator: "system", quando: "now()" })).toBe(0);
  });

  it("linha NÃO manual continua exatamente como antes (a policy não a alcança)", () => {
    expect(inserir(AGENTE_A, { fonte: "kanban", autor: AGENTE_A, ator: "user", quando: "now()" })).toBe(1);
    // O limite de sempre, que esta migration não afrouxa nem endurece: outra
    // origem não tem a trava de autoria. Fica escrito para ninguém achar que a
    // 0970 a fechou.
    expect(inserir(AGENTE_A, { fonte: "kanban", autor: AGENTE_B, ator: "user", quando: "now()" })).toBe(1);
  });

  it("o servidor (service_role/postgres) não é afetado: grava manual de qualquer autor", () => {
    sql(`
      insert into public.crm_lead_activities
        (organization_id, lead_id, contact_id, type, source_module, actor_kind, performed_by_user_id, reason)
      values ('${ORG}', '${LEAD_A}', '${CONTATO}', 'note', 'manual', 'user', '${AGENTE_B}', 'servidor');
    `);
  });
});

describe("escopo contato em visibilidade 'own'", () => {
  // A consulta da rota (`crm_lead_activities` com `crm_leads!inner` filtrado por
  // contato) vira, no banco, esta junção sob o JWT do atendente — a RLS vale nas
  // DUAS tabelas.
  const doContato = `select count(*) from public.crm_lead_activities a
     join public.crm_leads l on l.id = a.lead_id
     where l.contact_id = '${CONTATO}' and a.source_module = 'seed'`;

  it("o atendente A só enxerga as atividades do negócio dele, mesmo com o outro negócio no mesmo contato", () => {
    expect(countAs(AGENTE_A, doContato)).toBe(2); // as duas do LEAD_A
    expect(countAs(AGENTE_B, doContato)).toBe(2); // as duas do LEAD_B
  });

  it("e o que A enxerga é do negócio de A, não do de B", () => {
    expect(
      countAs(
        AGENTE_A,
        `select count(*) from public.crm_lead_activities a
           join public.crm_leads l on l.id = a.lead_id
          where l.contact_id = '${CONTATO}' and a.lead_id = '${LEAD_B}'`,
      ),
    ).toBe(0);
  });

  it("controle: sem o filtro de RLS (postgres) as quatro existem — o isolamento vem da policy", () => {
    expect(
      Number(
        sql(`select count(*) from public.crm_lead_activities a
               join public.crm_leads l on l.id = a.lead_id
              where l.contact_id = '${CONTATO}' and a.source_module = 'seed';`),
      ),
    ).toBe(4);
  });
});
