import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * A TAREFA VENCIDA AVISA UMA VEZ, NA ORGANIZAÇÃO DELA (migration 0980).
 *
 * `fn_reivindicar_tarefas_vencidas` é o único ponto em que o vencimento de uma
 * tarefa vira acontecimento (`crm_task.due` no `event_log`). Três coisas não
 * podem falhar, e as três são medidas contra o banco que o kit instala:
 *
 *   1. UMA VEZ por vencimento: rodar o cron de novo não avisa de novo, e
 *      remarcar o prazo rearma o aviso.
 *   2. Só o que pede aviso: aberta, com prazo vencido nas últimas 24h. Tarefa
 *      feita, futura, sem prazo ou atrasada há dias fica de fora.
 *   3. ISOLAMENTO: o evento nasce na organização da própria tarefa. Duas
 *      organizações com tarefa vencendo no mesmo minuto recebem um evento cada,
 *      e nenhum evento de A carrega tarefa de B.
 *
 * E a função não é alcançável pela REST: só `service_role` executa.
 */

const ORG_A = "7a5f0980-0000-4000-8000-00000000000a";
const ORG_B = "7a5f0980-0000-4000-8000-00000000000b";
const ROSANA = "7a5f0980-1111-4000-8000-000000000001";
const BETO = "7a5f0980-1111-4000-8000-000000000002";

const VENCIDA_A = "7a5f0980-2222-4000-8000-000000000001";
const VENCIDA_B = "7a5f0980-2222-4000-8000-000000000002";
const FUTURA = "7a5f0980-2222-4000-8000-000000000003";
const ANTIGA = "7a5f0980-2222-4000-8000-000000000004";
const FEITA = "7a5f0980-2222-4000-8000-000000000005";
const SEM_PRAZO = "7a5f0980-2222-4000-8000-000000000006";

const TODAS = [VENCIDA_A, VENCIDA_B, FUTURA, ANTIGA, FEITA, SEM_PRAZO];

function reivindicar(): string[] {
  const saida = sql(`select task_id from public.fn_reivindicar_tarefas_vencidas(1000);`);
  const ids = saida ? saida.split("\n") : [];
  // Outras suítes do mesmo banco podem ter tarefa vencendo agora: medimos só as nossas.
  return ids.filter((id) => TODAS.includes(id)).sort();
}

function eventos(taskId: string): Array<{ org: string; payloadTask: string }> {
  const saida = sql(`
    select organization_id || '|' || (payload->>'task_id')
      from public.event_log
     where event_type = 'crm_task.due' and entity_id = '${taskId}'
     order by created_at;
  `);
  if (!saida) return [];
  return saida.split("\n").map((l) => {
    const [org, payloadTask] = l.split("|");
    return { org: org ?? "", payloadTask: payloadTask ?? "" };
  });
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ROSANA}', 'rosana-0980@invariant.test'),
      ('${BETO}', 'beto-0980@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'tarefa-vencida-a', 'Tarefa Vencida A', 'Tarefa Vencida A'),
      ('${ORG_B}', 'tarefa-vencida-b', 'Tarefa Vencida B', 'Tarefa Vencida B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ROSANA}', '${ORG_A}', 'agent', now()),
      ('${BETO}', '${ORG_A}', 'agent', now()),
      ('${BETO}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    delete from public.event_log where event_type = 'crm_task.due'
      and entity_id in (${TODAS.map((id) => `'${id}'`).join(", ")});
    delete from public.crm_tasks where id in (${TODAS.map((id) => `'${id}'`).join(", ")});
    insert into public.crm_tasks (id, organization_id, title, due_date, status, created_by, assigned_to) values
      ('${VENCIDA_A}', '${ORG_A}', 'Contatar de novo, voltou de viagem', now() - interval '5 minutes', 'pending', '${ROSANA}', '${BETO}'),
      ('${VENCIDA_B}', '${ORG_B}', 'Tarefa do vizinho', now() - interval '5 minutes', 'in_progress', '${BETO}', null),
      ('${FUTURA}',    '${ORG_A}', 'Ainda não', now() + interval '2 hours', 'pending', '${ROSANA}', null),
      ('${ANTIGA}',    '${ORG_A}', 'Atrasada há dias', now() - interval '3 days', 'pending', '${ROSANA}', null),
      ('${FEITA}',     '${ORG_A}', 'Já feita', now() - interval '5 minutes', 'done', '${ROSANA}', null),
      ('${SEM_PRAZO}', '${ORG_A}', 'Sem prazo', null, 'pending', '${ROSANA}', null);
  `);
});

describe("fn_reivindicar_tarefas_vencidas", () => {
  it("pega só a tarefa aberta que venceu nas últimas 24h", () => {
    expect(reivindicar()).toEqual([VENCIDA_A, VENCIDA_B].sort());
  });

  it("o evento nasce na organização da PRÓPRIA tarefa, um por tarefa", () => {
    expect(eventos(VENCIDA_A)).toEqual([{ org: ORG_A, payloadTask: VENCIDA_A }]);
    expect(eventos(VENCIDA_B)).toEqual([{ org: ORG_B, payloadTask: VENCIDA_B }]);
    // E nenhum evento de A leva tarefa de B (nem o contrário).
    const cruzados = sql(`
      select count(*) from public.event_log
       where event_type = 'crm_task.due'
         and entity_id in ('${VENCIDA_A}', '${VENCIDA_B}')
         and organization_id <> (select organization_id from public.crm_tasks where id = entity_id);
    `);
    expect(cruzados).toBe("0");
  });

  it("o evento leva quem criou e o responsável, para o push saber a quem avisar", () => {
    const destino = sql(`
      select (payload->>'created_by') || '|' || (payload->>'assigned_to')
        from public.event_log where event_type = 'crm_task.due' and entity_id = '${VENCIDA_A}';
    `);
    expect(destino).toBe(`${ROSANA}|${BETO}`);
  });

  it("rodar de novo NÃO avisa de novo", () => {
    expect(reivindicar()).toEqual([]);
    expect(eventos(VENCIDA_A)).toHaveLength(1);
  });

  it("remarcar o prazo rearma o aviso", () => {
    sql(`update public.crm_tasks set due_date = now() - interval '1 minute' where id = '${VENCIDA_A}';`);
    expect(reivindicar()).toEqual([VENCIDA_A]);
    expect(eventos(VENCIDA_A)).toHaveLength(2);
    expect(reivindicar()).toEqual([]);
  });

  it("tarefa remarcada para o futuro não avisa até chegar a hora", () => {
    sql(`update public.crm_tasks set due_date = now() + interval '1 day' where id = '${VENCIDA_B}';`);
    expect(reivindicar()).toEqual([]);
    expect(eventos(VENCIDA_B)).toHaveLength(1);
  });

  it("só service_role executa: anon e authenticated não alcançam pela REST", () => {
    const privilegios = sql(`
      select string_agg(r || '=' || has_function_privilege(r, 'public.fn_reivindicar_tarefas_vencidas(integer)', 'execute')::text, ',' order by r)
        from unnest(array['anon', 'authenticated', 'service_role']) r;
    `);
    expect(privilegios).toBe("anon=false,authenticated=false,service_role=true");
  });
});
