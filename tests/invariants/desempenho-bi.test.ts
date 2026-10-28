import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Desempenho (BI) — migrations 0981 e 0982. Dataset conhecido e números EXATOS,
 * no banco do baseline, sob a role `authenticated` com o JWT de cada pessoa:
 * é a RLS de verdade que escopa o atendente, porque as três funções são
 * SECURITY INVOKER.
 *
 * Fuso da organização: America/Sao_Paulo (UTC-3). Janela [01/07 00:00, 04/07
 * 00:00) de São Paulo = [01/07 03:00Z, 04/07 03:00Z). Janela anterior, do
 * mesmo tamanho: [28/06 03:00Z, 01/07 03:00Z).
 *
 * O seed roda com `session_replication_role = replica` para que os gatilhos de
 * atendimento (0222) não reescrevam a revisão que o teste fixa à mão: o que se
 * mede aqui é a CONTA das funções, não o carimbo dos gatilhos.
 *
 * Namespace d9810981… exclusivo deste arquivo. Sem PII.
 */

const ORG = "d9810981-0000-4000-8000-000000000001";
const OUTRA = "d9810981-0000-4000-8000-000000000002";
const A = "d9810981-1111-4000-8000-000000000001"; // agent
const B = "d9810981-1111-4000-8000-000000000002"; // agent
const M = "d9810981-1111-4000-8000-000000000003"; // manager
const X = "d9810981-1111-4000-8000-000000000004"; // admin da OUTRA
const SESSAO = "d9810981-2222-4000-8000-000000000001";
const P1 = "d9810981-5555-4000-8000-000000000001";
const P2 = "d9810981-5555-4000-8000-000000000002";
const PX = "d9810981-5555-4000-8000-000000000003";
const S1 = "d9810981-6666-4000-8000-000000000001";
const S2 = "d9810981-6666-4000-8000-000000000002";
const S3 = "d9810981-6666-4000-8000-000000000003";
const T1 = "d9810981-6666-4000-8000-000000000004";
const SX = "d9810981-6666-4000-8000-000000000005";
const C1 = "d9810981-3333-4000-8000-000000000001";
const C2 = "d9810981-3333-4000-8000-000000000002";
const C3 = "d9810981-3333-4000-8000-000000000003";
const CX = "d9810981-3333-4000-8000-000000000004";
const L1 = "d9810981-7777-4000-8000-000000000001";
const L2 = "d9810981-7777-4000-8000-000000000002";
const L3 = "d9810981-7777-4000-8000-000000000003";
const L4 = "d9810981-7777-4000-8000-000000000004";
const CONV1 = "d9810981-4444-4000-8000-000000000001";
const CONV2 = "d9810981-4444-4000-8000-000000000002";
const CONV3 = "d9810981-4444-4000-8000-000000000003";

const FROM = "2026-07-01T03:00:00+00";
const TO = "2026-07-04T03:00:00+00";

beforeAll(() => {
  sql(`
    set session_replication_role = replica;

    insert into auth.users (id, email) values
      ('${A}', 'bi-a@invariant.test'), ('${B}', 'bi-b@invariant.test'),
      ('${M}', 'bi-m@invariant.test'), ('${X}', 'bi-x@invariant.test')
    on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name, timezone) values
      ('${ORG}', 'bi-org', 'BI Org', 'BI Org', 'America/Sao_Paulo'),
      ('${OUTRA}', 'bi-outra', 'BI Outra', 'BI Outra', 'America/Sao_Paulo')
    on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${A}', '${ORG}', 'agent', now()),
      ('${B}', '${ORG}', 'agent', now()),
      ('${M}', '${ORG}', 'manager', now()),
      ('${X}', '${OUTRA}', 'admin', now())
    on conflict do nothing;

    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'bi-org', '\\x00'::bytea) on conflict do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug, position) values
      ('${P1}', '${ORG}', 'Vendas', 'vendas', 1000),
      ('${P2}', '${ORG}', 'Exterior', 'exterior', 2000),
      ('${PX}', '${OUTRA}', 'Outra', 'outra', 1000)
    on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${S1}', '${ORG}', '${P1}', 'Novo', 'novo', 1000),
      ('${S2}', '${ORG}', '${P1}', 'Proposta', 'proposta', 2000),
      ('${S3}', '${ORG}', '${P1}', 'Fechamento', 'fechamento', 3000),
      ('${T1}', '${ORG}', '${P2}', 'Entrada', 'entrada', 1000),
      ('${SX}', '${OUTRA}', '${PX}', 'Entrada', 'entrada', 1000)
    on conflict do nothing;

    insert into public.contacts (id, organization_id, display_name) values
      ('${C1}', '${ORG}', 'BI Contato 1'), ('${C2}', '${ORG}', 'BI Contato 2'),
      ('${C3}', '${ORG}', 'BI Contato 3'), ('${CX}', '${OUTRA}', 'BI Contato X')
    on conflict do nothing;

    -- NEGÓCIOS. Fuso SP: 07-03T02:00Z ainda é 02/07 em São Paulo.
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status, owner_user_id, value_cents, currency, created_at, closed_at, lost_reason, custom_fields) values
      ('${L1}', '${ORG}', '${P1}', '${S1}', '${C1}', 'L1', 'open', '${A}', 10000, 'BRL', '2026-07-01T15:00:00Z', null, null, '{"utm_source":"Google","utm_campaign":"black"}'),
      ('${L2}', '${ORG}', '${P1}', '${S2}', '${C1}', 'L2', 'won',  '${A}', 20000, 'BRL', '2026-07-01T15:00:00Z', '2026-07-02T15:00:00Z', null, '{"utm_source":" google "}'),
      ('${L3}', '${ORG}', '${P1}', '${S2}', '${C3}', 'L3', 'lost', '${B}', 5000,  'BRL', '2026-07-02T15:00:00Z', '2026-07-03T15:00:00Z', 'price', '{"utm_source":"facebook"}'),
      ('${L4}', '${ORG}', '${P1}', '${S3}', '${C3}', 'L4', 'lost', '${B}', null,  'BRL', '2026-07-02T15:00:00Z', '2026-07-03T15:00:00Z', 'moved_to_another_pipeline', '{}');
    insert into public.crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, status, owner_user_id, value_cents, currency, created_at, closed_at, lost_reason) values
      ('${ORG}', '${P2}', '${T1}', '${C2}', 'L5 USD', 'won', '${B}', 7000, 'USD', '2026-07-02T15:00:00Z', '2026-07-02T16:00:00Z', null),
      ('${ORG}', '${P1}', '${S1}', '${C3}', 'L6 antigo aberto', 'open', '${B}', 3000, 'BRL', '2026-05-01T15:00:00Z', null, null),
      ('${ORG}', '${P1}', '${S1}', '${C1}', 'L7 antigo ganho', 'won', '${A}', 1000, 'BRL', '2026-05-01T15:00:00Z', '2026-07-03T02:00:00Z', null),
      ('${OUTRA}', '${PX}', '${SX}', '${CX}', 'LX', 'open', '${X}', 999, 'BRL', '2026-07-01T15:00:00Z', null, null);

    -- MOVIMENTAÇÕES: as duas formas de payload que os emissores gravam.
    insert into public.crm_lead_activities (organization_id, lead_id, source_module, type, payload, performed_at) values
      ('${ORG}', '${L2}', 'crm', 'stage_changed', '{"from_stage_id":"${S1}","to_stage_id":"${S2}"}', '2026-07-01T16:00:00Z'),
      ('${ORG}', '${L3}', 'crm', 'stage_changed', '{"de":"${S1}","para":"${S2}"}', '2026-07-02T16:00:00Z'),
      ('${ORG}', '${L4}', 'crm', 'stage_changed', '{"from_stage_id":"${S2}","to_stage_id":"${S3}"}', '2026-07-02T17:00:00Z'),
      ('${ORG}', '${L1}', 'crm', 'stage_changed', '{"to_stage_id":"${S1}"}', '2026-05-01T16:00:00Z'),
      ('${ORG}', '${L1}', 'crm', 'note_added', '{}', '2026-07-01T16:00:00Z');

    -- CONVERSAS. CONV1 (A): revisão 1 encerrada e revisão 2 em curso, cliente esperando.
    -- CONV2 (B): atendimento começado na janela ANTERIOR, com resposta dentro da atual.
    -- CONV3 (B): atendimento de maio — fora das duas janelas.
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at, assignee_kind,
                                      service_revision, service_started_at, service_closed_at, last_inbound_at, last_outbound_at) values
      ('${CONV1}', '${ORG}', '${C1}', '${SESSAO}', 'claimed', '${A}', '2026-07-01T12:00:00Z', 'user', 2, '2026-07-02T12:00:00Z', null, '2026-07-02T13:00:00Z', '2026-07-02T12:02:00Z'),
      ('${CONV2}', '${ORG}', '${C2}', '${SESSAO}', 'claimed', '${B}', '2026-06-29T12:00:00Z', 'user', 1, '2026-06-29T12:00:00Z', '2026-07-03T10:00:00Z', '2026-07-03T09:00:00Z', '2026-07-03T09:00:30Z'),
      ('${CONV3}', '${ORG}', '${C3}', '${SESSAO}', 'claimed', '${B}', '2026-05-01T12:00:00Z', 'user', 1, '2026-05-01T12:00:00Z', null, '2026-07-01T20:00:00Z', null);

    insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, sent_via, sent_by_user_id, sent_at, service_revision) values
      ('${ORG}', '${CONV1}', '${SESSAO}', '${C1}', 'text', 'inbound',  'crm',  null,   '2026-07-01T12:00:00Z', 1),
      ('${ORG}', '${CONV1}', '${SESSAO}', '${C1}', 'text', 'outbound', 'user', '${A}', '2026-07-01T12:01:00Z', 1),
      ('${ORG}', '${CONV1}', '${SESSAO}', '${C1}', 'text', 'inbound',  'crm',  null,   '2026-07-01T12:05:00Z', 1),
      ('${ORG}', '${CONV1}', '${SESSAO}', '${C1}', 'text', 'outbound', 'ai',   null,   '2026-07-01T12:06:00Z', 1),
      ('${ORG}', '${CONV1}', '${SESSAO}', '${C1}', 'text', 'inbound',  'crm',  null,   '2026-07-02T12:00:00Z', 2),
      ('${ORG}', '${CONV1}', '${SESSAO}', '${C1}', 'text', 'outbound', 'user', '${A}', '2026-07-02T12:02:00Z', 2),
      ('${ORG}', '${CONV1}', '${SESSAO}', '${C1}', 'text', 'inbound',  'crm',  null,   '2026-07-02T13:00:00Z', 2),
      ('${ORG}', '${CONV2}', '${SESSAO}', '${C2}', 'text', 'inbound',  'crm',  null,   '2026-06-29T12:00:00Z', 1),
      ('${ORG}', '${CONV2}', '${SESSAO}', '${C2}', 'text', 'outbound', 'user', '${B}', '2026-06-29T12:10:00Z', 1),
      ('${ORG}', '${CONV2}', '${SESSAO}', '${C2}', 'text', 'inbound',  'crm',  null,   '2026-07-03T09:00:00Z', 1),
      ('${ORG}', '${CONV2}', '${SESSAO}', '${C2}', 'text', 'outbound', 'user', '${B}', '2026-07-03T09:00:30Z', 1),
      ('${ORG}', '${CONV3}', '${SESSAO}', '${C3}', 'text', 'inbound',  'crm',  null,   '2026-05-01T12:00:00Z', 1),
      ('${ORG}', '${CONV3}', '${SESSAO}', '${C3}', 'text', 'inbound',  'crm',  null,   '2026-07-01T20:00:00Z', 1);

    set session_replication_role = origin;
    analyze public.crm_leads;
    analyze public.messages;
  `);
});

type Json = Record<string, unknown>;

/** Chama a função como `authenticated` com o JWT da pessoa e devolve o JSON. */
function chamar(
  fn: "fn_desempenho_negocios" | "fn_desempenho_origens" | "fn_desempenho_atendimento",
  pessoa: string,
  opts: { org?: string; funil?: string; dono?: string } = {},
): Json {
  const funil = opts.funil ? `'${opts.funil}'::uuid` : "null";
  const dono = opts.dono ? `'${opts.dono}'::uuid` : "null";
  const out = sql(`
    set role authenticated;
    do $c$ begin perform set_config('request.jwt.claims', '{"sub":"${pessoa}"}', false); end $c$;
    select 'J:' || public.${fn}('${opts.org ?? ORG}', '${FROM}', '${TO}', ${funil}, ${dono})::text;
  `);
  const linha = out.split("\n").find((l) => l.startsWith("J:"));
  if (!linha) throw new Error(`saída inesperada: ${out}`);
  return JSON.parse(linha.slice(2)) as Json;
}

const cartao = (j: Json, nome: string) => (j.cartoes as Record<string, unknown>)[nome];

describe("fn_desempenho_negocios", () => {
  it("cartões do gerente: perda por troca de funil não conta, USD fica fora da soma em BRL", () => {
    const j = chamar("fn_desempenho_negocios", M);
    expect(j.moeda).toBe("BRL");
    expect(j.fuso).toBe("America/Sao_Paulo");
    expect(cartao(j, "criados")).toEqual({ quantidade: 5, valor_cents: 35000 });
    expect(cartao(j, "ganhos")).toEqual({ quantidade: 3, valor_cents: 21000 });
    expect(cartao(j, "perdidos")).toEqual({ quantidade: 1, valor_cents: 5000 });
    expect(cartao(j, "em_aberto")).toEqual({ quantidade: 1, valor_cents: 10000 });
    expect(cartao(j, "carteira")).toEqual({ quantidade: 2, valor_cents: 13000 });
    expect(j.fora_da_moeda).toBe(2);
  });

  it("série diária no fuso da organização, um ponto por dia da janela", () => {
    const j = chamar("fn_desempenho_negocios", M);
    const diario = j.diario as Array<Record<string, number | string>>;
    expect(diario.map((d) => d.dia)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(diario.map((d) => d.criados)).toEqual([2, 3, 0]);
    // L7 fechou 07-03T02:00Z = 23:00 de 02/07 em São Paulo.
    expect(diario.map((d) => d.ganhos)).toEqual([0, 3, 0]);
    expect(diario.map((d) => d.ganhos_valor_cents)).toEqual([0, 21000, 0]);
    expect(diario.map((d) => d.perdidos)).toEqual([0, 0, 1]);
    expect(diario.map((d) => d.movimentacoes)).toEqual([1, 2, 0]);
  });

  it("movimentações lêem to_stage_id e para; fora da janela e outro tipo não contam", () => {
    const j = chamar("fn_desempenho_negocios", M);
    const mov = j.movimentacoes as { total: number; por_etapa: Array<Record<string, unknown>> };
    expect(mov.total).toBe(3);
    expect(mov.por_etapa.map((e) => [e.nome, e.quantidade])).toEqual([
      ["Proposta", 2],
      ["Fechamento", 1],
    ]);
  });

  it("filtro de funil: etapas do funil, moeda do escopo", () => {
    const p1 = chamar("fn_desempenho_negocios", M, { funil: P1 });
    expect((p1.etapas as Array<Record<string, unknown>>).map((e) => [e.nome, e.quantidade, e.valor_cents])).toEqual([
      ["Novo", 2, 13000],
      ["Proposta", 0, 0],
      ["Fechamento", 0, 0],
    ]);
    expect(p1.funis).toEqual([]);
    const p2 = chamar("fn_desempenho_negocios", M, { funil: P2 });
    expect(p2.moeda).toBe("USD");
    expect(cartao(p2, "ganhos")).toEqual({ quantidade: 1, valor_cents: 7000 });
    expect(p2.fora_da_moeda).toBe(0);
    const todos = chamar("fn_desempenho_negocios", M);
    expect((todos.funis as Array<Record<string, unknown>>).map((f) => [f.nome, f.quantidade])).toEqual([
      ["Vendas", 2],
      ["Exterior", 0],
    ]);
  });

  it("filtro de atendente e ranking com ticket médio", () => {
    const a = chamar("fn_desempenho_negocios", M, { dono: A });
    expect(cartao(a, "criados")).toEqual({ quantidade: 2, valor_cents: 30000 });
    expect(cartao(a, "ganhos")).toEqual({ quantidade: 2, valor_cents: 21000 });
    expect(cartao(a, "perdidos")).toEqual({ quantidade: 0, valor_cents: 0 });
    expect((a.movimentacoes as { total: number }).total).toBe(1);

    const todos = chamar("fn_desempenho_negocios", M);
    const ranking = todos.atendentes as Array<Record<string, unknown>>;
    expect(ranking.find((r) => r.user_id === A)).toEqual({
      user_id: A, criados: 2, ganhos: 2, perdidos: 0, valor_ganho_cents: 21000, ticket_medio_cents: 10500,
    });
    expect(ranking.find((r) => r.user_id === B)).toEqual({
      user_id: B, criados: 3, ganhos: 1, perdidos: 1, valor_ganho_cents: 0, ticket_medio_cents: null,
    });
  });

  it("atendente vê só os próprios negócios (RLS), sem passar filtro", () => {
    const j = chamar("fn_desempenho_negocios", A);
    expect(cartao(j, "criados")).toEqual({ quantidade: 2, valor_cents: 30000 });
    expect(cartao(j, "ganhos")).toEqual({ quantidade: 2, valor_cents: 21000 });
    expect((j.atendentes as Array<Record<string, unknown>>).map((r) => r.user_id)).toEqual([A]);
  });

  it("isolamento: gerente de uma organização pedindo a outra recebe zero; o admin dela vê a dela", () => {
    const alheia = chamar("fn_desempenho_negocios", M, { org: OUTRA });
    expect(cartao(alheia, "criados")).toEqual({ quantidade: 0, valor_cents: 0 });
    expect(cartao(alheia, "carteira")).toEqual({ quantidade: 0, valor_cents: 0 });
    const propria = chamar("fn_desempenho_negocios", X, { org: OUTRA });
    expect(cartao(propria, "criados")).toEqual({ quantidade: 1, valor_cents: 999 });
    const daOutraVistaPorX = chamar("fn_desempenho_negocios", X, { org: ORG });
    expect(cartao(daOutraVistaPorX, "criados")).toEqual({ quantidade: 0, valor_cents: 0 });
  });
});

describe("fn_desempenho_origens", () => {
  it("agrupa utm sem caixa nem espaço; vazio vira sem origem; taxa = ganhos ÷ criados", () => {
    const j = chamar("fn_desempenho_origens", M);
    expect(j.total).toBe(5);
    expect(j.por_source).toEqual([
      { chave: "google", total: 2, ganhos: 1, perdidos: 0, abertos: 1, valor_ganho_cents: 20000, taxa_de_ganho: 0.5 },
      { chave: null, total: 2, ganhos: 1, perdidos: 0, abertos: 0, valor_ganho_cents: 0, taxa_de_ganho: 0.5 },
      { chave: "facebook", total: 1, ganhos: 0, perdidos: 1, abertos: 0, valor_ganho_cents: 0, taxa_de_ganho: 0 },
    ]);
    expect((j.por_campaign as Array<Record<string, unknown>>).map((o) => [o.chave, o.total])).toEqual([
      [null, 4],
      ["black", 1],
    ]);
  });

  it("filtro de funil, de atendente e isolamento", () => {
    const p2 = chamar("fn_desempenho_origens", M, { funil: P2 });
    expect((p2.por_source as Array<Record<string, unknown>>).map((o) => [o.chave, o.total])).toEqual([[null, 1]]);
    const b = chamar("fn_desempenho_origens", M, { dono: B });
    expect(b.total).toBe(3);
    expect(chamar("fn_desempenho_origens", A).total).toBe(2);
    expect(chamar("fn_desempenho_origens", M, { org: OUTRA }).total).toBe(0);
  });
});

describe("fn_desempenho_atendimento", () => {
  it("atendimentos = conversa × revisão iniciados na janela; anterior para a variação", () => {
    const j = chamar("fn_desempenho_atendimento", M);
    expect(j.cartoes).toEqual({
      atendimentos: 2,
      atendimentos_anterior: 1,
      finalizados: 1,
      em_aberto: 1,
      aguardando: 1,
    });
  });

  it("tempos só humanos: primeira resposta 60s e 120s; turnos 60, 120 e 30", () => {
    const j = chamar("fn_desempenho_atendimento", M);
    expect(j.tempos).toEqual({ primeira_resposta_seg: 90, resposta_seg: 70, respostas: 3 });
    const at = j.atendentes as Array<Record<string, unknown>>;
    expect(at.find((r) => r.user_id === A)).toEqual({
      user_id: A, atendimentos: 2, finalizados: 1, em_aberto: 1,
      primeira_resposta_seg: 90, respostas: 2, resposta_seg: 90,
    });
    expect(at.find((r) => r.user_id === B)).toEqual({
      user_id: B, atendimentos: 0, finalizados: 0, em_aberto: 0,
      primeira_resposta_seg: null, respostas: 1, resposta_seg: 30,
    });
  });

  it("série diária e mapa de calor no fuso da organização", () => {
    const j = chamar("fn_desempenho_atendimento", M);
    const diario = j.diario as Array<Record<string, unknown>>;
    expect(diario.map((d) => [d.dia, d.atendimentos])).toEqual([
      ["2026-07-01", 1],
      ["2026-07-02", 1],
      ["2026-07-03", 0],
    ]);
    const calor = j.mapa_de_calor as Array<{ dow: number; hora: number; quantidade: number }>;
    expect(calor.reduce((s, c) => s + c.quantidade, 0)).toBe(6);
    // 01/07/2026 é quarta-feira (dow 3); 12:00Z e 12:05Z = 09h em São Paulo.
    expect(calor.find((c) => c.dow === 3 && c.hora === 9)?.quantidade).toBe(2);
  });

  it("filtros de atendente e funil, RLS do atendente e isolamento", () => {
    const a = chamar("fn_desempenho_atendimento", M, { dono: A });
    expect((a.cartoes as Json).atendimentos).toBe(2);
    expect((a.cartoes as Json).atendimentos_anterior).toBe(0);
    const p2 = chamar("fn_desempenho_atendimento", M, { funil: P2 });
    expect((p2.cartoes as Json).atendimentos).toBe(0);
    expect((p2.cartoes as Json).atendimentos_anterior).toBe(1);
    expect((p2.tempos as Json).resposta_seg).toBe(30);
    const comoA = chamar("fn_desempenho_atendimento", A);
    expect((comoA.tempos as Json).respostas).toBe(2);
    const alheia = chamar("fn_desempenho_atendimento", M, { org: OUTRA });
    expect((alheia.cartoes as Json).atendimentos).toBe(0);
    expect((alheia.tempos as Json).respostas).toBe(0);
  });
});

describe("EXECUTE das funções novas", () => {
  it("nem PUBLIC nem anon executam; authenticated executa", () => {
    const out = sql(`
      select string_agg(f || ':' || has_function_privilege('anon', f, 'execute')::text || ':' ||
             has_function_privilege('authenticated', f, 'execute')::text, ';' order by f)
      from unnest(array[
        'public.fn_desempenho_negocios(uuid,timestamptz,timestamptz,uuid,uuid)',
        'public.fn_desempenho_origens(uuid,timestamptz,timestamptz,uuid,uuid)',
        'public.fn_desempenho_atendimento(uuid,timestamptz,timestamptz,uuid,uuid)'
      ]) f;
    `);
    expect(out).not.toContain(":true:");
    expect(out.split(";").every((p) => p.endsWith(":false:true"))).toBe(true);
    const publico = sql(`
      select count(*) from pg_proc p, aclexplode(p.proacl) a
      where p.proname in ('fn_desempenho_negocios','fn_desempenho_origens','fn_desempenho_atendimento')
        and a.grantee = 0 and a.privilege_type = 'EXECUTE';
    `);
    expect(publico).toBe("0");
  });
});
