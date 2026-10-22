import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0976 — filhas e escrita de negócios sem custo por linha (continuação da 0975).
 *
 * As 16 policies restritivas `visibilidade_por_atendente` (0939) chamavam
 * `fn_registro_filho_visivel` em CADA linha, e a função começa por `fn_user_role_in_org`
 * mesmo para o gerente. As policies de escrita de `crm_leads` chamavam
 * `fn_role_at_least(organization_id, ...)` duas vezes por linha. A 0976 põe o atalho da
 * 0975 (`fn_orgs_com_visao_total`, uma vez por consulta) na frente das filhas e troca o
 * `fn_role_at_least` por linha por uma subconsulta sem correlação.
 *
 * O que este arquivo prova:
 *   (a) gerente, admin e leitor veem exatamente as mesmas linhas de antes, em cada tabela e
 *       em cada modo de visibilidade — pelos valores escritos aqui E pela paridade com as
 *       policies da 0939 recriadas na mesma transação;
 *   (b) o agent continua vendo só o que é dele (e a fila, conforme o modo);
 *   (c) isolamento entre duas organizações: o gerente de uma não vê nada da outra;
 *   (d) desempenho: para o gerente, `fn_registro_filho_visivel` não é chamada nenhuma vez, e
 *       a escrita em lote de `crm_leads` chama `fn_role_at_least` um número fixo de vezes, não
 *       uma por linha (contagem de `pg_stat_xact_user_functions`, com controle da policy
 *       antiga); o plano mostra o atalho como subplano em hash avaliado uma vez.
 *
 * Namespace de ids e976…, exclusivo deste arquivo. Sem PII: textos sintéticos.
 */

const id = (bloco: string, n: number) => `e9760000-${bloco}-4000-8000-${String(n).padStart(12, "0")}`;

const ORG1 = id("0001", 1);
const ORG2 = id("0001", 2);
const ORG_PERF = id("0001", 3);

const ADMIN = id("0002", 1);
const GERENTE = id("0002", 2);
const LEITOR = id("0002", 3);
const AGENTE_A = id("0002", 4);
const AGENTE_B = id("0002", 5);
const REVOGADO = id("0002", 6);
const FORA_GERENTE = id("0002", 7);
const FORA_AGENTE = id("0002", 8);

const CONV_A = id("0003", 1);
const CONV_B = id("0003", 2);
const CONV_FILA = id("0003", 3);
const CONV_X = id("0003", 4);
const LEAD_A = id("0004", 1);
const LEAD_B = id("0004", 2);
const LEAD_FILA = id("0004", 3);
const LEAD_X = id("0004", 4);

const PIPE = (n: number) => id("0005", n);
const ETAPA = (n: number) => id("0006", n);

const u = (v: string | null) => (v === null ? "null" : `'${v}'`);

interface Tabela {
  nome: string;
  coluna: "conversation_id" | "lead_id";
  admiteSemVinculo: boolean;
  /** Os argumentos de fn_registro_filho_visivel na policy da 0939. */
  args: string;
  inserir: (org: string, v: string | null) => string;
}

// Mesmas tabelas, colunas e formas de inserção de tests/invariants/lote13a-banco.test.ts.
const TABELAS: Tabela[] = [
  { nome: "agent_cases", coluna: "conversation_id", admiteSemVinculo: false, args: "organization_id, conversation_id, lead_id", inserir: (o, v) => `insert into public.agent_cases (organization_id, conversation_id, title, summary, blocker) values ('${o}', ${u(v)}, 't', 's', 'b')` },
  { nome: "ai_agent_runs", coluna: "conversation_id", admiteSemVinculo: true, args: "organization_id, conversation_id, null", inserir: (o, v) => `insert into public.ai_agent_runs (organization_id, agent_id, agent_version_id, conversation_id) values ('${o}', gen_random_uuid(), gen_random_uuid(), ${u(v)})` },
  { nome: "ai_invocations", coluna: "conversation_id", admiteSemVinculo: true, args: "organization_id, conversation_id, null", inserir: (o, v) => `insert into public.ai_invocations (organization_id, invocation_kind, model, latency_ms, conversation_id) values ('${o}', 'bot_respond', 'm', 1, ${u(v)})` },
  { nome: "ai_router_decisions", coluna: "conversation_id", admiteSemVinculo: true, args: "organization_id, conversation_id, null", inserir: (o, v) => `insert into public.ai_router_decisions (organization_id, outcome, conversation_id) values ('${o}', 'classified', ${u(v)})` },
  { nome: "contact_field_proposals", coluna: "conversation_id", admiteSemVinculo: true, args: "organization_id, conversation_id, null", inserir: (o, v) => `insert into public.contact_field_proposals (organization_id, contact_id, campo, valor_proposto, expires_at, conversation_id) values ('${o}', gen_random_uuid(), 'name', 'v', now() + interval '1 day', ${u(v)})` },
  { nome: "conversation_notes", coluna: "conversation_id", admiteSemVinculo: false, args: "organization_id, conversation_id, null", inserir: (o, v) => `insert into public.conversation_notes (organization_id, conversation_id, body) values ('${o}', ${u(v)}, 'nota v976')` },
  { nome: "demanda_conversas", coluna: "conversation_id", admiteSemVinculo: false, args: "organization_id, conversation_id, null", inserir: (o, v) => `insert into public.demanda_conversas (organization_id, demanda_id, conversation_id) values ('${o}', gen_random_uuid(), ${u(v)})` },
  { nome: "followup_enrollments", coluna: "conversation_id", admiteSemVinculo: true, args: "organization_id, conversation_id, null", inserir: (o, v) => `insert into public.followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, conversation_id) values ('${o}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'n', ${u(v)})` },
  { nome: "jev_observacoes", coluna: "conversation_id", admiteSemVinculo: true, args: "organization_id, conversation_id, null", inserir: (o, v) => `insert into public.jev_observacoes (organization_id, tarefa, estado, conversation_id) values ('${o}', 't', 'observando', ${u(v)})` },
  { nome: "lead_checkpoints", coluna: "conversation_id", admiteSemVinculo: true, args: "organization_id, conversation_id, null", inserir: (o, v) => `insert into public.lead_checkpoints (organization_id, contact_id, conversation_id, rolling_summary) values ('${o}', gen_random_uuid(), ${u(v)}, 'resumo')` },
  { nome: "crm_lead_reactivations", coluna: "lead_id", admiteSemVinculo: false, args: "organization_id, null, lead_id", inserir: (o, v) => `insert into public.crm_lead_reactivations (lead_id, organization_id, expires_at) values (${u(v)}, '${o}', now() + interval '1 day')` },
  { nome: "crm_lead_risk_states", coluna: "lead_id", admiteSemVinculo: false, args: "organization_id, null, lead_id", inserir: (o, v) => `insert into public.crm_lead_risk_states (lead_id, organization_id, bucket, since, cold_hours) values (${u(v)}, '${o}', 'em_dia', now() - interval '1 hour', 1)` },
  { nome: "crm_lead_scores", coluna: "lead_id", admiteSemVinculo: false, args: "organization_id, null, lead_id", inserir: (o, v) => `insert into public.crm_lead_scores (lead_id, organization_id) values (${u(v)}, '${o}')` },
  { nome: "demandas", coluna: "lead_id", admiteSemVinculo: true, args: "organization_id, null, lead_id", inserir: (o, v) => `insert into public.demandas (organization_id, contact_id, lead_id) values ('${o}', gen_random_uuid(), ${u(v)})` },
  { nome: "golden_candidates", coluna: "lead_id", admiteSemVinculo: true, args: "organization_id, null, lead_id", inserir: (o, v) => `insert into public.golden_candidates (organization_id, job_id, fonte, skill, motivo, lead_id) values ('${o}', gen_random_uuid(), 'skill_match_miss', 's', 'm', ${u(v)})` },
  { nome: "voice_calls", coluna: "lead_id", admiteSemVinculo: true, args: "organization_id, null, lead_id", inserir: (o, v) => `insert into public.voice_calls (organization_id, direction, peer_phone, status, lead_id) values ('${o}', 'outbound', '+5511999997600', 'ended', ${u(v)})` },
];

const VINCULOS = {
  conversation_id: { meu: CONV_A, alheio: CONV_B, fila: CONV_FILA, fora: CONV_X },
  lead_id: { meu: LEAD_A, alheio: LEAD_B, fila: LEAD_FILA, fora: LEAD_X },
} as const;

/** As 16 policies como a 0939 as criou: a regra ANTIGA, recriada dentro da transação para comparar. */
const FILHAS_ANTIGAS = TABELAS.map((t) => {
  const usando =
    t.nome === "voice_calls"
      ? `(public.fn_registro_filho_visivel(${t.args}) or owner_user_id = (select auth.uid()) or created_by = (select auth.uid()))`
      : `public.fn_registro_filho_visivel(${t.args})`;
  return `drop policy visibilidade_por_atendente on public.${t.nome};
    create policy visibilidade_por_atendente on public.${t.nome} as restrictive for select using (${usando});`;
}).join("\n");

/** As policies de escrita de crm_leads como a 0975 as deixou: fn_role_at_least por linha. */
const ESCRITA_ANTIGA = (() => {
  const expr = `public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or (organization_id in (select public.fn_orgs_com_visao_total())
                 or public.fn_can_view_lead(organization_id, owner_user_id))))`;
  return `drop policy "crm_leads_insert" on public.crm_leads;
    create policy "crm_leads_insert" on public.crm_leads for insert with check (${expr});
    drop policy "crm_leads_update" on public.crm_leads;
    create policy "crm_leads_update" on public.crm_leads for update using (${expr}) with check (${expr});
    drop policy "crm_leads_delete" on public.crm_leads;
    create policy "crm_leads_delete" on public.crm_leads for delete using (${expr});`;
})();

const comClaims = (usuario: string) => `select set_config('request.jwt.claims', '{"sub":"${usuario}"}', true);`;
const modo = (valor: string) =>
  `update public.organizations set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{visibility_mode}', '"${valor}"') where id = '${ORG1}';`;

/** Por tabela: `meu/alheio/fila/sem|fora/semfora` (ORG1 | ORG2), numa consulta só, como o usuário. */
function enxerga(usuario: string, antes = ""): string {
  const consultas = TABELAS.map((t) => {
    const v = VINCULOS[t.coluna];
    return `select '${t.nome}:' || count(*) filter (where organization_id = '${ORG1}' and ${t.coluna} = '${v.meu}')
       || '/' || count(*) filter (where organization_id = '${ORG1}' and ${t.coluna} = '${v.alheio}')
       || '/' || count(*) filter (where organization_id = '${ORG1}' and ${t.coluna} = '${v.fila}')
       || '/' || count(*) filter (where organization_id = '${ORG1}' and ${t.coluna} is null)
       || '|' || count(*) filter (where organization_id = '${ORG2}' and ${t.coluna} = '${v.fora}')
       || '/' || count(*) filter (where organization_id = '${ORG2}' and ${t.coluna} is null)
       from public.${t.nome} where organization_id in ('${ORG1}', '${ORG2}')`;
  }).join("\nunion all\n");
  return sql(`begin;
    ${antes}
    set local role authenticated;
    ${comClaims(usuario)}
    ${consultas};
    rollback;`)
    .split("\n")
    .filter((l) => l.includes(":") && l.includes("|"))
    .sort()
    .join("\n");
}

/** O esperado por papel, montado da regra escrita (e não do banco). */
function esperado(ve: (t: Tabela) => { meu: boolean; alheio: boolean; fila: boolean; sem: boolean; fora: boolean }): string {
  return TABELAS.map((t) => {
    const e = ve(t);
    const n = (b: boolean) => (b ? 1 : 0);
    const sem = t.admiteSemVinculo ? n(e.sem) : 0;
    const semFora = t.admiteSemVinculo ? n(e.fora) : 0;
    return `${t.nome}:${n(e.meu)}/${n(e.alheio)}/${n(e.fila)}/${sem}|${n(e.fora)}/${semFora}`;
  })
    .sort()
    .join("\n");
}

const TUDO_ORG1 = esperado(() => ({ meu: true, alheio: true, fila: true, sem: true, fora: false }));
const TUDO_ORG2 = esperado(() => ({ meu: false, alheio: false, fila: false, sem: false, fora: true }));
const NADA = esperado(() => ({ meu: false, alheio: false, fila: false, sem: false, fora: false }));

beforeAll(() => {
  const usuarios = [ADMIN, GERENTE, LEITOR, AGENTE_A, AGENTE_B, REVOGADO, FORA_GERENTE, FORA_AGENTE]
    .map((x, i) => `('${x}', 'v976-${i}@invariant.test')`)
    .join(", ");
  const filhos = TABELAS.flatMap((t) => {
    const v = VINCULOS[t.coluna];
    const linhas = [v.meu, v.alheio, v.fila].map((x) => `${t.inserir(ORG1, x)};`);
    linhas.push(`${t.inserir(ORG2, v.fora)};`);
    if (t.admiteSemVinculo) linhas.push(`${t.inserir(ORG1, null)};`, `${t.inserir(ORG2, null)};`);
    return linhas;
  });
  sql(`
    insert into auth.users (id, email) values ${usuarios} on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG1}', 'v976-um', 'V976 um', 'V976 um'),
      ('${ORG2}', 'v976-dois', 'V976 dois', 'V976 dois'),
      ('${ORG_PERF}', 'v976-perf', 'V976 perf', 'V976 perf')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at) values
      ('${ADMIN}', '${ORG1}', 'admin', now(), null),
      ('${GERENTE}', '${ORG1}', 'manager', now(), null),
      ('${LEITOR}', '${ORG1}', 'viewer', now(), null),
      ('${AGENTE_A}', '${ORG1}', 'agent', now(), null),
      ('${AGENTE_B}', '${ORG1}', 'agent', now(), null),
      ('${REVOGADO}', '${ORG1}', 'manager', now(), now()),
      ('${FORA_GERENTE}', '${ORG2}', 'manager', now(), null),
      ('${FORA_AGENTE}', '${ORG2}', 'agent', now(), null),
      ('${GERENTE}', '${ORG_PERF}', 'manager', now(), null),
      ('${AGENTE_A}', '${ORG_PERF}', 'agent', now(), null)
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${PIPE(1)}', '${ORG1}', 'V976', 'v976'), ('${PIPE(2)}', '${ORG2}', 'V976', 'v976'),
      ('${PIPE(3)}', '${ORG_PERF}', 'V976', 'v976') on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${ETAPA(1)}', '${ORG1}', '${PIPE(1)}', 'Novo', 'novo', 1000),
      ('${ETAPA(2)}', '${ORG2}', '${PIPE(2)}', 'Novo', 'novo', 1000),
      ('${ETAPA(3)}', '${ORG_PERF}', '${PIPE(3)}', 'Novo', 'novo', 1000) on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id) values
      ('${LEAD_A}', '${ORG1}', '${PIPE(1)}', '${ETAPA(1)}', 'v976 A', '${AGENTE_A}'),
      ('${LEAD_B}', '${ORG1}', '${PIPE(1)}', '${ETAPA(1)}', 'v976 B', '${AGENTE_B}'),
      ('${LEAD_FILA}', '${ORG1}', '${PIPE(1)}', '${ETAPA(1)}', 'v976 fila', null),
      ('${LEAD_X}', '${ORG2}', '${PIPE(2)}', '${ETAPA(2)}', 'v976 X', '${FORA_AGENTE}')
      on conflict (id) do nothing;

    -- Conversas e filhas entram pelo dono do banco com FKs e gatilhos desligados na sessão: o assunto é a leitura.
    set session_replication_role = replica;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id) values
      ('${CONV_A}', '${ORG1}', gen_random_uuid(), gen_random_uuid(), 'claimed', '${AGENTE_A}'),
      ('${CONV_B}', '${ORG1}', gen_random_uuid(), gen_random_uuid(), 'claimed', '${AGENTE_B}'),
      ('${CONV_FILA}', '${ORG1}', gen_random_uuid(), gen_random_uuid(), 'open', null),
      ('${CONV_X}', '${ORG2}', gen_random_uuid(), gen_random_uuid(), 'claimed', '${FORA_AGENTE}')
      on conflict (id) do nothing;
    ${filhos.join("\n")}

    -- Desempenho: 3.000 demandas e 3.000 negócios na organização de desempenho.
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, owner_user_id)
      select '${ORG_PERF}', '${PIPE(3)}', '${ETAPA(3)}', 'v976 perf ' || g,
             case when g % 3 = 0 then '${AGENTE_A}'::uuid end
        from generate_series(1, 3000) g;
    insert into public.demandas (organization_id, contact_id, lead_id)
      select '${ORG_PERF}', gen_random_uuid(), l.id from public.crm_leads l where l.organization_id = '${ORG_PERF}';
    set session_replication_role = origin;
    analyze public.crm_leads;
    analyze public.demandas;
  `);
});

describe("0976: forma das policies no banco", () => {
  it("as 16 visibilidade_por_atendente são restritivas de SELECT e perguntam o atalho ANTES da função por linha", () => {
    const linhas = sql(`select tablename || '|' || permissive || '|' || cmd || '|' ||
        (position('fn_orgs_com_visao_total' in qual) > 0
         and position('fn_orgs_com_visao_total' in qual) < position('fn_registro_filho_visivel' in qual))
      from pg_policies where schemaname = 'public' and policyname = 'visibilidade_por_atendente' order by 1;`).split("\n");
    expect(linhas).toEqual(TABELAS.map((t) => `${t.nome}|RESTRICTIVE|SELECT|true`).sort());
  });

  it("escrita de crm_leads: nenhuma chamada de fn_role_at_least sobre a coluna da linha", () => {
    const out = sql(`select policyname || '|' || (coalesce(qual, '') || coalesce(with_check, '') ~ 'fn_role_at_least\\(organization_id')
      from pg_policies where schemaname = 'public' and tablename = 'crm_leads'
        and policyname in ('crm_leads_insert', 'crm_leads_update', 'crm_leads_delete') order by 1;`);
    expect(out.split("\n")).toEqual(["crm_leads_delete|false", "crm_leads_insert|false", "crm_leads_update|false"]);
  });
});

describe("0976: quem vê o quê nas 16 filhas não mudou", () => {
  it("fixture: cada tabela recebeu cada vínculo nas duas organizações", () => {
    expect(enxerga(GERENTE)).not.toBe(NADA);
    for (const t of TABELAS) {
      const n = Number(sql(`select count(*) from public.${t.nome} where organization_id in ('${ORG1}', '${ORG2}');`));
      expect(n, t.nome).toBe(4 + (t.admiteSemVinculo ? 2 : 0));
    }
  });

  for (const m of ["own_and_unassigned", "own", "all"] as const) {
    describe(`modo ${m}`, () => {
      // own_and_unassigned: o próprio e a fila; own: só o próprio; all: tudo. Sem vínculo vale a organização.
      const AGENTE = esperado(() => ({ meu: true, alheio: m === "all", fila: m !== "own", sem: true, fora: false }));

      const CASOS: Array<[string, string, string]> = [
        ["admin", ADMIN, TUDO_ORG1],
        ["manager", GERENTE, TUDO_ORG1],
        ["viewer", LEITOR, TUDO_ORG1],
        ["agent A", AGENTE_A, AGENTE],
        ["vínculo revogado", REVOGADO, NADA],
        ["gerente da outra organização", FORA_GERENTE, TUDO_ORG2],
      ];

      for (const [papel, usuario, valor] of CASOS) {
        it(`${papel}: devolve exatamente o esperado (e nada da outra organização)`, () => {
          expect(enxerga(usuario, modo(m))).toBe(valor);
        });
      }

      for (const [papel, usuario] of [...CASOS.map(([p, x]) => [p, x] as const), ["agent B", AGENTE_B] as const]) {
        it(`${papel}: paridade com as policies da 0939 recriadas na mesma transação`, () => {
          expect(enxerga(usuario, modo(m))).toBe(enxerga(usuario, `${modo(m)}\n${FILHAS_ANTIGAS}`));
        });
      }
    });
  }

  it("agent B vê o dele e não o de A (modo own)", () => {
    const visto = enxerga(AGENTE_B, modo("own"));
    for (const linha of visto.split("\n")) expect(linha, linha).toMatch(/:0\/1\/0\/[01]\|0\/0$/);
  });

  it("ligação: quem fez a chamada ainda a vê sem ver o negócio (ramo de voice_calls preservado)", () => {
    const out = sql(`begin;
      ${modo("own")}
      set session_replication_role = replica;
      insert into public.voice_calls (organization_id, direction, peer_phone, status, lead_id, owner_user_id)
        values ('${ORG1}', 'outbound', '+5511999997601', 'ended', '${LEAD_B}', '${AGENTE_A}');
      set session_replication_role = origin;
      set local role authenticated;
      ${comClaims(AGENTE_A)}
      select count(*) from public.voice_calls where peer_phone = '+5511999997601';
      rollback;`);
    expect(out.split("\n").filter((l) => /^\d+$/.test(l)).pop()).toBe("1");
  });
});

/**
 * Chamadas de uma função e o resultado do comando, numa transação desfeita. `comando` grava a
 * contagem em `v976_n`; `antes` roda como superusuário.
 */
function chamadas(usuario: string, comando: string, funcao: string, antes = ""): { chamadas: number; resultado: number } {
  const out = sql(`begin;
    ${antes}
    create temporary table v976_n (n int) on commit drop;
    grant insert, select on v976_n to authenticated;
    set local track_functions = 'all';
    set local role authenticated;
    ${comClaims(usuario)}
    ${comando};
    reset role;
    select (select n from v976_n) || '|' || coalesce((select calls from pg_stat_xact_user_functions
             where schemaname = 'public' and funcname = '${funcao}'), 0);
    rollback;`);
  const [resultado, n] = out
    .split("\n")
    .filter((l) => /^\d+\|\d+$/.test(l))
    .pop()!
    .split("|");
  return { chamadas: Number(n), resultado: Number(resultado) };
}

interface No {
  "Parent Relationship"?: string;
  "Actual Loops"?: number;
  Filter?: string;
  Plans?: No[];
}

describe("0976: o gerente não paga fn_registro_filho_visivel por linha", () => {
  const CONTA = `insert into v976_n select count(*) from public.demandas where organization_id = '${ORG_PERF}'`;

  it("gerente: 3.000 demandas e ZERO chamadas de fn_registro_filho_visivel", () => {
    expect(chamadas(GERENTE, CONTA, "fn_registro_filho_visivel")).toEqual({ chamadas: 0, resultado: 3000 });
  });

  it("CONTROLE do instrumento: com a policy da 0939 o mesmo gerente chama a função por linha", () => {
    const r = chamadas(GERENTE, CONTA, "fn_registro_filho_visivel", FILHAS_ANTIGAS);
    expect(r.resultado).toBe(3000);
    expect(r.chamadas).toBeGreaterThanOrEqual(3000);
  });

  it("CONTROLE: o agent continua na regra por linha e vê só o próprio e a fila", () => {
    const r = chamadas(AGENTE_A, CONTA, "fn_registro_filho_visivel");
    expect(r.resultado).toBe(3000); // ORG_PERF sem visibility_mode: own_and_unassigned; 1/3 dele, 2/3 sem dono
    expect(r.chamadas).toBeGreaterThan(0);
  });

  it("plano: fn_orgs_com_visao_total é subplano em hash avaliado uma vez, antes da função por linha", () => {
    const out = sql(`begin;
      set local role authenticated;
      ${comClaims(GERENTE)}
      explain (analyze, verbose, format json) select * from public.demandas where organization_id = '${ORG_PERF}';
      rollback;`);
    const [plano] = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1)) as Array<{ Plan: No }>;
    const subplanos: No[] = [];
    const filtros: string[] = [];
    const visitar = (no: No) => {
      if (typeof no.Filter === "string") filtros.push(no.Filter);
      if (no["Parent Relationship"] === "SubPlan" && JSON.stringify(no).includes("fn_orgs_com_visao_total()")) subplanos.push(no);
      for (const filho of no.Plans ?? []) visitar(filho);
    };
    visitar(plano!.Plan);
    expect(subplanos.length, "fn_orgs_com_visao_total não aparece como subplano").toBeGreaterThanOrEqual(1);
    for (const s of subplanos) expect(s["Actual Loops"], "o subplano rodou mais de uma vez").toBe(1);
    const filtro = filtros.find((f) => f.includes("fn_registro_filho_visivel")) ?? "";
    const atalho = filtro.search(/hashed SubPlan \d+/);
    expect(atalho, filtro).toBeGreaterThan(-1);
    expect(atalho, filtro).toBeLessThan(filtro.indexOf("fn_registro_filho_visivel"));
  });
});

/**
 * Resultado de um DML como o usuário, desfeito no fim: o número de linhas afetadas, `RLS` quando a
 * policy recusou, ou `ERRO: <mensagem>` para qualquer outra recusa (comparável entre as duas regras).
 */
function resultadoComo(usuario: string, dml: string, antes = ""): string {
  try {
    const out = sql(`begin;
      ${antes}
      set local role authenticated;
      ${comClaims(usuario)}
      with w as (${dml} returning 1) select count(*) from w;
      rollback;`);
    const linhas = out.split("\n").filter((l) => /^\d+$/.test(l));
    return linhas[linhas.length - 1] ?? "?";
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (stderr.includes("row-level security")) return "RLS";
    // Sem o prefixo `psql:<stdin>:N:`, que muda com o tamanho do script.
    const linha = stderr.split("\n").find((l) => l.includes("ERROR")) ?? stderr;
    return `ERRO: ${linha.replace(/^psql:<stdin>:\d+:\s*/, "")}`;
  }
}

/** Linhas afetadas; recusa da RLS conta 0. */
function escreveComo(usuario: string, dml: string): number {
  const r = resultadoComo(usuario, dml);
  if (r === "RLS") return 0;
  if (!/^\d+$/.test(r)) throw new Error(r);
  return Number(r);
}

describe("0976: quem escreve em crm_leads não mudou", () => {
  const USUARIOS: Array<[string, string]> = [
    ["admin", ADMIN],
    ["manager", GERENTE],
    ["viewer", LEITOR],
    ["agent A", AGENTE_A],
    ["vínculo revogado", REVOGADO],
    ["gerente da outra organização", FORA_GERENTE],
  ];
  const criar = (dono: string | null) =>
    `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, owner_user_id)
       values ('${ORG1}', '${PIPE(1)}', '${ETAPA(1)}', 'v976 novo', ${u(dono)})`;
  const DMLS: Array<[string, string]> = [
    ["mover", `update public.crm_leads set position_in_stage = position_in_stage + 1 where title like 'v976 %' and organization_id in ('${ORG1}', '${ORG2}')`],
    ["trocar de organização", `update public.crm_leads set organization_id = '${ORG2}' where id = '${LEAD_FILA}'`],
    ["apagar", `delete from public.crm_leads where organization_id in ('${ORG1}', '${ORG2}') and title like 'v976 %'`],
    ["criar sem dono", criar(null)],
    ["criar para A", criar(AGENTE_A)],
    ["criar para B", criar(AGENTE_B)],
  ];

  for (const [papel, usuario] of USUARIOS) {
    for (const [acao, dml] of DMLS) {
      it(`${papel} / ${acao}: mesmo resultado que as policies da 0975`, () => {
        expect(resultadoComo(usuario, dml)).toBe(resultadoComo(usuario, dml, ESCRITA_ANTIGA));
      });
    }
  }

  it("valores esperados: manager e admin alcançam tudo da organização, agent o que vê, viewer e revogado nada", () => {
    const mover = DMLS[0]![1];
    expect(escreveComo(ADMIN, mover)).toBe(3);
    expect(escreveComo(GERENTE, mover)).toBe(3);
    expect(escreveComo(AGENTE_A, mover)).toBe(2);
    expect(escreveComo(LEITOR, mover)).toBe(0);
    expect(escreveComo(REVOGADO, mover)).toBe(0);
    expect(escreveComo(FORA_GERENTE, mover)).toBe(1);
    expect(escreveComo(AGENTE_A, criar(AGENTE_B))).toBe(0);
    expect(escreveComo(GERENTE, criar(AGENTE_B))).toBe(1);
  });

  // 600 dos 3.000: com a regra antiga o lote inteiro passa de 30 s neste banco de teste.
  const MOVER_PERF = `with w as (update public.crm_leads set position_in_stage = position_in_stage + 1
      where id in (select id from public.crm_leads where organization_id = '${ORG_PERF}' order by id limit 600)
      returning 1) insert into v976_n select count(*) from w`;

  it("gerente movendo 600 negócios: fn_role_at_least chamada um número fixo de vezes, não por linha", () => {
    const r = chamadas(GERENTE, MOVER_PERF, "fn_role_at_least");
    expect(r.resultado).toBe(600);
    expect(r.chamadas).toBeLessThan(50);
  });

  it("CONTROLE do instrumento: com as policies da 0975 o mesmo lote chama fn_role_at_least por linha", () => {
    const r = chamadas(GERENTE, MOVER_PERF, "fn_role_at_least", ESCRITA_ANTIGA);
    expect(r.resultado).toBe(600);
    expect(r.chamadas).toBeGreaterThanOrEqual(600);
  }, 120_000);
});
