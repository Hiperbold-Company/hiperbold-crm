import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * Migration 0975 — visão de negócios sem custo por linha.
 *
 * As policies de `crm_leads` e das filhas (`crm_lead_activities`, `crm_lead_links`,
 * `crm_lead_itens`) chamavam `fn_can_view_lead` em CADA linha, e ela relê o contexto do
 * suporte duas vezes. Medido em produção: 19 s para um gerente ler 300 negócios de uma
 * organização de 6.588. A 0975 pergunta antes `organization_id in (select
 * fn_orgs_com_visao_total())`, avaliado uma vez por consulta, e só cai na função por
 * linha para o agent.
 *
 * O que este arquivo prova:
 *   (a) a matriz de quem vê o quê NÃO mudou: cada papel, nos três modos de
 *       visibilidade, com e sem dono, e outra organização — tanto pelos valores
 *       esperados escritos aqui quanto pela paridade com `fn_can_view_lead` linha a
 *       linha (a regra antiga, avaliada com as mesmas claims);
 *   (b) o suporte ativo (full e somente leitura) continua entrando pelo atalho;
 *   (c) desempenho: para o gerente, `fn_can_view_lead` não é chamada nenhuma vez
 *       (contagem de `pg_stat_xact_user_functions`, com controle do agent e da policy
 *       antiga), o atalho roda uma vez só no plano e a consulta fica abaixo de 1,5 s.
 *
 * Namespace de ids e975…, exclusivo deste arquivo. Sem PII: títulos sintéticos.
 */

const id = (bloco: string, n: number) =>
  `e9750000-${bloco}-4000-8000-${String(n).padStart(12, "0")}`;

const ORG_PADRAO = id("0001", 1); // visibility_mode ausente = own_and_unassigned
const ORG_TODOS = id("0001", 2); // 'all'
const ORG_PROPRIO = id("0001", 3); // 'own' (qualquer outro valor: só o próprio)
const ORG_ALHEIA = id("0001", 4); // ninguém daqui é membro
const ORG_PERF = id("0001", 5);

const ADMIN = id("0002", 1);
const GERENTE = id("0002", 2);
const LEITOR = id("0002", 3);
const AGENTE_A = id("0002", 4);
const AGENTE_B = id("0002", 5);
const REVOGADO = id("0002", 6);
const GERENTE_PERF = id("0002", 7);
const AGENTE_PERF = id("0002", 8);
// Donos dos negócios da organização alheia: o gatilho de responsável exige membro da própria organização.
const FORA_A = id("0002", 9);
const FORA_B = id("0002", 10);

const ORGS: Array<[string, string, string]> = [
  [ORG_PADRAO, "pad", "null"],
  [ORG_TODOS, "tod", `jsonb_build_object('visibility_mode', 'all')`],
  [ORG_PROPRIO, "pro", `jsonb_build_object('visibility_mode', 'own')`],
  [ORG_ALHEIA, "alh", "null"],
];

const comClaims = (usuario: string) =>
  `select set_config('request.jwt.claims', '{"sub":"${usuario}"}', true);`;

/** Lista (ordenada, separada por vírgula) do que a consulta devolve com RLS, como o usuário. */
function vistoComo(usuario: string, consulta: string): string {
  return lastLine(
    sql(`begin;
      set local role authenticated;
      ${comClaims(usuario)}
      ${consulta}
      rollback;`)
      .split("\n")
      .filter(
        (l) => l !== "" && l !== "BEGIN" && l !== "SET" && l !== "ROLLBACK" && !l.startsWith("{"),
      )
      .join("\n") || "",
  );
}

/** A mesma pergunta pela REGRA ANTIGA: superusuário (ignora RLS) com as mesmas claims. */
function pelaRegraAntiga(usuario: string, consulta: string): string {
  return lastLine(
    sql(`begin;
      ${comClaims(usuario)}
      ${consulta}
      rollback;`)
      .split("\n")
      .filter((l) => l !== "" && l !== "BEGIN" && l !== "ROLLBACK" && !l.startsWith("{"))
      .join("\n") || "",
  );
}

/** Linhas afetadas por um DML como o usuário, desfeito no fim. Negação da RLS conta 0. */
function escreveComo(usuario: string, dml: string): number {
  try {
    const out = sql(`begin;
      set local role authenticated;
      ${comClaims(usuario)}
      with w as (${dml} returning 1) select count(*) from w;
      rollback;`);
    const linhas = out.split("\n").filter((l) => /^\d+$/.test(l));
    return Number(linhas[linhas.length - 1]);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (stderr.includes("row-level security")) return 0;
    throw err;
  }
}

const TITULOS = `select coalesce(string_agg(l.title, ',' order by l.title), '-') from public.crm_leads l where l.title like 'v975 %'`;

beforeAll(() => {
  const usuarios = [
    ADMIN,
    GERENTE,
    LEITOR,
    AGENTE_A,
    AGENTE_B,
    REVOGADO,
    GERENTE_PERF,
    AGENTE_PERF,
    FORA_A,
    FORA_B,
  ]
    .map((u, i) => `('${u}', 'v975-${i}@invariant.test')`)
    .join(", ");
  const membros: string[] = [];
  const leads: string[] = [];
  const filhos: string[] = [];
  ORGS.forEach(([org, sigla, settings], i) => {
    const pipe = id("0003", i + 1);
    const etapa = id("0004", i + 1);
    membros.push(`
      insert into public.organizations (id, slug, legal_name, display_name, settings)
        values ('${org}', 'v975-${sigla}', 'V975 ${sigla}', 'V975 ${sigla}', coalesce(${settings}, '{}'::jsonb))
        on conflict do nothing;
      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${pipe}', '${org}', 'V975', 'v975') on conflict do nothing;
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('${etapa}', '${org}', '${pipe}', 'Novo', 'novo', 1000) on conflict do nothing;`);
    if (org !== ORG_ALHEIA) {
      membros.push(`
        insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at) values
          ('${ADMIN}', '${org}', 'admin', now(), null),
          ('${GERENTE}', '${org}', 'manager', now(), null),
          ('${LEITOR}', '${org}', 'viewer', now(), null),
          ('${AGENTE_A}', '${org}', 'agent', now(), null),
          ('${AGENTE_B}', '${org}', 'agent', now(), null),
          ('${REVOGADO}', '${org}', 'manager', now(), now())
          on conflict do nothing;`);
    } else {
      membros.push(`
        insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
          ('${FORA_A}', '${org}', 'agent', now()), ('${FORA_B}', '${org}', 'agent', now())
          on conflict do nothing;`);
    }
    const alheia = org === ORG_ALHEIA;
    (
      [
        ["A", alheia ? FORA_A : AGENTE_A],
        ["B", alheia ? FORA_B : AGENTE_B],
        ["0", null],
      ] as const
    ).forEach(([dono, usuario], j) => {
      const lead = id("0005", i * 10 + j + 1);
      const owner = usuario ? `'${usuario}'` : "null";
      leads.push(`('${lead}', '${org}', '${pipe}', '${etapa}', 'v975 ${sigla}-${dono}', ${owner})`);
      filhos.push(`
        insert into public.crm_lead_activities (organization_id, lead_id, source_module, type, payload)
          values ('${org}', '${lead}', 'invariant', 'note', '{"note":"v975 ${sigla}-${dono}"}'::jsonb);
        insert into public.crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind)
          values ('${org}', '${lead}', 'external', '${id("0006", i * 10 + j + 1)}', 'reference');
        insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
          values ('${org}', '${lead}', 'v975 ${sigla}-${dono}', 1, 100);`);
    });
  });

  sql(`
    insert into auth.users (id, email) values ${usuarios} on conflict do nothing;
    ${membros.join("\n")}
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id)
      values ${leads.join(",\n")} on conflict (id) do nothing;
    ${filhos.join("\n")}

    -- Organização de desempenho: 3.000 negócios, um gerente e um agente.
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_PERF}', 'v975-perf', 'V975 perf', 'V975 perf') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GERENTE_PERF}', '${ORG_PERF}', 'manager', now()),
      ('${AGENTE_PERF}', '${ORG_PERF}', 'agent', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${id("0003", 9)}', '${ORG_PERF}', 'V975 perf', 'v975-perf') on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${id("0004", 9)}', '${ORG_PERF}', '${id("0003", 9)}', 'Novo', 'novo', 1000) on conflict do nothing;
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, owner_user_id, custom_fields)
      select '${ORG_PERF}', '${id("0003", 9)}', '${id("0004", 9)}', 'perf ' || g,
             case when g % 3 = 0 then '${AGENTE_PERF}'::uuid end,
             jsonb_build_object('n', g)
        from generate_series(1, 3000) g;
    update public.crm_leads set updated_at = now() - make_interval(mins => (random() * 100000)::int)
      where organization_id = '${ORG_PERF}';
    analyze public.crm_leads;
  `);
});

describe("0975: a matriz de visibilidade de negócios não mudou", () => {
  const TUDO = [
    "v975 pad-0,v975 pad-A,v975 pad-B",
    "v975 pro-0,v975 pro-A,v975 pro-B",
    "v975 tod-0,v975 tod-A,v975 tod-B",
  ].join(",");

  const ESPERADO: Array<[string, string, string]> = [
    ["admin", ADMIN, TUDO],
    ["manager", GERENTE, TUDO],
    ["viewer", LEITOR, TUDO],
    // own_and_unassigned: o próprio e o sem dono; all: tudo; own: só o próprio.
    ["agent A", AGENTE_A, "v975 pad-0,v975 pad-A,v975 pro-A,v975 tod-0,v975 tod-A,v975 tod-B"],
    ["agent B", AGENTE_B, "v975 pad-0,v975 pad-B,v975 pro-B,v975 tod-0,v975 tod-A,v975 tod-B"],
    ["vínculo revogado", REVOGADO, "-"],
  ];

  for (const [papel, usuario, esperado] of ESPERADO) {
    it(`${papel}: crm_leads devolve exatamente o esperado (e nada da outra organização)`, () => {
      expect(vistoComo(usuario, `${TITULOS};`)).toBe(esperado);
    });

    it(`${papel}: crm_leads bate com fn_can_view_lead linha a linha`, () => {
      expect(vistoComo(usuario, `${TITULOS};`)).toBe(
        pelaRegraAntiga(
          usuario,
          `${TITULOS} and public.fn_can_view_lead(l.organization_id, l.owner_user_id);`,
        ),
      );
    });

    it(`${papel}: atividades, vínculos e itens seguem o negócio-pai`, () => {
      const atividades = vistoComo(
        usuario,
        `select coalesce(string_agg(a.payload->>'note', ',' order by a.payload->>'note'), '-')
           from public.crm_lead_activities a where a.payload->>'note' like 'v975 %';`,
      );
      const itens = vistoComo(
        usuario,
        `select coalesce(string_agg(i.nome_snapshot, ',' order by i.nome_snapshot), '-')
           from public.crm_lead_itens i where i.nome_snapshot like 'v975 %';`,
      );
      const vinculos = vistoComo(
        usuario,
        `select count(*) from public.crm_lead_links k where k.target_id::text like 'e9750000-0006-%';`,
      );
      expect(atividades).toBe(esperado);
      expect(itens).toBe(esperado);
      expect(Number(vinculos)).toBe(esperado === "-" ? 0 : esperado.split(",").length);
    });
  }

  it("escrita em crm_leads: manager e admin alcançam tudo, agent o que vê, viewer e revogado nada", () => {
    const mover = `update public.crm_leads set position_in_stage = position_in_stage + 1 where title like 'v975 %'`;
    expect(escreveComo(ADMIN, mover)).toBe(9);
    expect(escreveComo(GERENTE, mover)).toBe(9);
    expect(escreveComo(AGENTE_A, mover)).toBe(6);
    expect(escreveComo(LEITOR, mover)).toBe(0);
    expect(escreveComo(REVOGADO, mover)).toBe(0);
  });

  it("criar e apagar negócio: agent só para si ou sem dono; manager para qualquer um", () => {
    const criar = (dono: string) =>
      `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, owner_user_id)
         values ('${ORG_PADRAO}', '${id("0003", 1)}', '${id("0004", 1)}', 'v975 novo', ${dono})`;
    expect(escreveComo(AGENTE_A, criar(`'${AGENTE_A}'`))).toBe(1);
    expect(escreveComo(AGENTE_A, criar(`'${AGENTE_B}'`))).toBe(0);
    expect(escreveComo(GERENTE, criar(`'${AGENTE_B}'`))).toBe(1);
    expect(escreveComo(LEITOR, criar("null"))).toBe(0);
    const apagar = `delete from public.crm_leads where title like 'v975 pad-%'`;
    expect(escreveComo(AGENTE_A, apagar)).toBe(2);
    expect(escreveComo(GERENTE, apagar)).toBe(3);
    expect(escreveComo(LEITOR, apagar)).toBe(0);
  });

  it("itens do negócio: escrita segue a visibilidade do pai", () => {
    const mexer = `update public.crm_lead_itens set quantidade = quantidade + 1 where nome_snapshot like 'v975 %'`;
    expect(escreveComo(GERENTE, mexer)).toBe(9);
    expect(escreveComo(AGENTE_A, mexer)).toBe(6);
    expect(escreveComo(LEITOR, mexer)).toBe(0);
    const inserir = (sufixo: string) =>
      `insert into public.crm_lead_itens (organization_id, lead_id, nome_snapshot, quantidade, valor_unitario_cents)
         select organization_id, id, 'v975 extra', 1, 100 from public.crm_leads where title = 'v975 ${sufixo}'`;
    expect(escreveComo(AGENTE_A, inserir("pad-A"))).toBe(1);
    expect(escreveComo(GERENTE, inserir("pro-B"))).toBe(1);
  });

  it("o atalho só lista organização onde o papel efetivo é viewer, manager ou admin", () => {
    const orgs = (u: string) =>
      vistoComo(
        u,
        `select coalesce(string_agg(o::text, ',' order by o::text), '-') from public.fn_orgs_com_visao_total() o;`,
      );
    const tres = [ORG_PADRAO, ORG_TODOS, ORG_PROPRIO].sort().join(",");
    expect(orgs(GERENTE)).toBe(tres);
    expect(orgs(LEITOR)).toBe(tres);
    expect(orgs(AGENTE_A)).toBe("-");
    expect(orgs(REVOGADO)).toBe("-");
  });

  it("EXECUTE da função nova: authenticated e service_role sim, anon e PUBLIC não", () => {
    expect(
      sql(`select has_function_privilege('anon', 'public.fn_orgs_com_visao_total()', 'execute')
                , has_function_privilege('authenticated', 'public.fn_orgs_com_visao_total()', 'execute')
                , has_function_privilege('service_role', 'public.fn_orgs_com_visao_total()', 'execute')
                , exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                           where p.oid = 'public.fn_orgs_com_visao_total()'::regprocedure and a.grantee = 0);`),
    ).toBe("f|t|t|f");
  });
});

describe("0975: suporte temporário continua entrando pelo atalho", () => {
  const ator = id("0007", 1);
  const sessao = id("0007", 2);
  const outra = id("0007", 3);
  const semente = `
    insert into auth.users (id, email) values ('${ator}', 'v975-suporte@invariant.test');
    insert into auth.sessions (id, user_id, aal) values ('${sessao}', '${ator}', 'aal1'), ('${outra}', '${ator}', 'aal1');
    insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
      values ('${ator}', '${ator}', 'full', false, 'Local test');`;
  const claims = (s: string) =>
    `select set_config('request.jwt.claims', '{"sub":"${ator}","session_id":"${s}","aal":"aal1"}', true);`;

  function sob(modo: "full" | "support_readonly", s: string) {
    const out = sql(`begin;
      ${semente}
      select public.fn_start_support('${ator}', '${sessao}', '${ORG_PADRAO}', null, '${modo}', 600);
      set local role authenticated;
      ${claims(s)}
      select (select count(*) from public.fn_orgs_com_visao_total() o where o = '${ORG_PADRAO}')
          || '|' || (select count(*) from public.crm_leads where title like 'v975 pad-%')
          || '|' || (select count(*) from public.crm_lead_activities where payload->>'note' like 'v975 pad-%');
      rollback;`);
    return out
      .split("\n")
      .filter((l) => /^\d+\|\d+\|\d+$/.test(l))
      .pop();
  }

  it("suporte full: a organização entra no atalho e o ator vê os três negócios e as atividades", () => {
    expect(sob("full", sessao)).toBe("1|3|3");
  });

  it("suporte somente leitura: idem (o papel efetivo é viewer)", () => {
    expect(sob("support_readonly", sessao)).toBe("1|3|3");
  });

  it("CONTROLE: outra sessão do mesmo ator não recebe o atalho", () => {
    // O ator é admin da plataforma, então ainda vê pelos ramos de admin; o que se mede é o atalho.
    expect(sob("full", outra)?.split("|")[0]).toBe("0");
  });
});

interface No {
  "Parent Relationship"?: string;
  "Actual Loops"?: number;
  Filter?: string;
  Plans?: No[];
}

describe("0975: o gerente não paga fn_can_view_lead por linha", () => {
  const CONSULTA = `select custom_fields from public.crm_leads where organization_id = '${ORG_PERF}' order by updated_at desc limit 300`;

  /** Chamadas de fn_can_view_lead e linhas devolvidas, numa transação desfeita. `antes` roda como superusuário. */
  function chamadas(usuario: string, antes = ""): { chamadas: number; linhas: number } {
    const out = sql(`begin;
      ${antes}
      set local track_functions = 'all';
      set local role authenticated;
      ${comClaims(usuario)}
      create temporary table if not exists v975_n (n int) on commit drop;
      insert into v975_n select count(*) from (${CONSULTA}) q;
      reset role;
      select (select n from v975_n) || '|' || coalesce((select calls from pg_stat_xact_user_functions
               where schemaname = 'public' and funcname = 'fn_can_view_lead'), 0);
      rollback;`);
    const [linhas, n] = out
      .split("\n")
      .filter((l) => /^\d+\|\d+$/.test(l))
      .pop()!
      .split("|");
    return { chamadas: Number(n), linhas: Number(linhas) };
  }

  const POLICY_ANTIGA = `
    drop policy "crm_leads_select" on public.crm_leads;
    create policy "crm_leads_select" on public.crm_leads
      for select using (public.fn_can_view_lead(organization_id, owner_user_id));`;

  it("gerente: 300 linhas e ZERO chamadas de fn_can_view_lead", () => {
    expect(chamadas(GERENTE_PERF)).toEqual({ chamadas: 0, linhas: 300 });
  });

  it("CONTROLE do instrumento: com a policy antiga o mesmo gerente chama fn_can_view_lead por linha", () => {
    const r = chamadas(GERENTE_PERF, POLICY_ANTIGA);
    expect(r.linhas).toBe(300);
    expect(r.chamadas).toBeGreaterThanOrEqual(300);
  });

  it("CONTROLE: o agent continua na regra por linha (e vê só os próprios e os sem dono)", () => {
    const r = chamadas(AGENTE_PERF);
    expect(r.linhas).toBe(300);
    expect(r.chamadas).toBeGreaterThan(0);
  });

  it("plano: fn_orgs_com_visao_total é subplano em hash avaliado uma vez, e a consulta fica abaixo de 1,5 s", () => {
    const out = sql(`begin;
      set local role authenticated;
      ${comClaims(GERENTE_PERF)}
      explain (analyze, verbose, format json) ${CONSULTA};
      rollback;`);
    const json = out.slice(out.indexOf("["), out.lastIndexOf("]") + 1);
    const [plano] = JSON.parse(json) as Array<{ Plan: No; "Execution Time": number }>;

    // O subplano cuja saída é fn_orgs_com_visao_total() (com `verbose`, a chamada aparece em Output).
    const subplanos: No[] = [];
    const filtros: string[] = [];
    const visitar = (no: No) => {
      if (typeof no.Filter === "string") filtros.push(no.Filter);
      if (
        no["Parent Relationship"] === "SubPlan" &&
        JSON.stringify(no).includes("fn_orgs_com_visao_total()")
      ) {
        subplanos.push(no);
      }
      for (const filho of no.Plans ?? []) visitar(filho);
    };
    visitar(plano!.Plan);

    expect(subplanos.length, "fn_orgs_com_visao_total não aparece como subplano").toBe(1);
    expect(subplanos[0]!["Actual Loops"], "o subplano rodou mais de uma vez").toBe(1);
    // Na varredura de crm_leads o atalho vem ANTES de fn_can_view_lead, e em hash.
    const filtro = filtros.find((f) => f.includes("fn_can_view_lead")) ?? "";
    // O texto em volta do subplano muda entre majors do Postgres; a ordem atalho-antes-da-função, não.
    const atalho = filtro.search(/hashed SubPlan \d+/);
    expect(atalho, filtro).toBeGreaterThan(-1);
    expect(atalho, filtro).toBeLessThan(filtro.indexOf("fn_can_view_lead"));
    expect(plano!["Execution Time"]).toBeLessThan(1500);
  });
});
