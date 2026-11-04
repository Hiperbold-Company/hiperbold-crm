/**
 * Direct no fluxo (caso ManyChat): comentário → resposta privada → a automação
 * ESPERA a pessoa responder no Direct → manda o conteúdo pela conversa que a
 * resposta criou.
 *
 * Banco em memória que filtra de verdade (`tests/helpers/banco-em-memoria.ts`):
 * outra conexão, outra pessoa e outra organização são medidas pelo desfecho.
 * Só a borda é simulada: `sendMessageHandler` e o pool do drain (que aplica a
 * regra da consulta aos dados).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { enviarMock } = vi.hoisted(() => ({ enviarMock: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: enviarMock }));
vi.mock("@/app/api/v1/cron/recover-stuck-messages/route", () => ({ recoverStuckMessages: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";
import { ehCanalDeWhatsapp } from "@/lib/channels/canal-de-whatsapp";
import { ehCanalDoDirect } from "@/lib/channels/canal-do-direct";
import { createSupabaseAdminClient } from "@/lib/followup/engine";
import { descreveEvento } from "@/lib/followup/eventos-legiveis";
import { flowGraphSchema, type FlowGraph, type FlowNode } from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { acordarAutomacaoEmEspera, ultimaRespostaDaAutomacao } from "@/lib/relogio/executar";

import { criarBancoEmMemoria, type Linha } from "../../tests/helpers/banco-em-memoria";
import { pisoDaRespostaNoDirect } from "./conversa";
import { escopoDoDirect } from "./conversa-do-direct";
import { devolverTurnoAoAgente } from "./devolver-turno";
import { executarConversa } from "./efeitos/conversa";
import type { Contexto } from "./efeitos/index";
import { createSupabaseGatilhosDb } from "./gatilhos.handler";
import { automacaoEsperaRespostaNaConversa, automacaoEsperaRespostaNaConversaSupabase } from "./uma-voz";

const CANAL_DO_DIRECT = PROVIDERS_DE_MENSAGEM.find((p) => ehCanalDoDirect(p))!;
const CANAL_DE_WHATSAPP = PROVIDERS_DE_MENSAGEM.find((p) => ehCanalDeWhatsapp(p))!;

const ORG = "org-1";
const OUTRA_ORG = "org-2";
const CONTATO = "contato-ig";
const SESSAO_IG = "11111111-1111-4111-8111-111111111111";
const OUTRA_SESSAO = "22222222-2222-4222-8222-222222222222";
const IGSID = "6543210987654321";
const ENR = "enr-ig";
const ESTACIONOU = "2026-11-03T11:00:00.000Z";
const AGORA = new Date("2026-11-03T11:30:00.000Z");
const seg = (s: number) => new Date(Date.parse(ESTACIONOU) + s * 1000).toISOString();

const VARS = {
  gatilho: {
    tipo: "instagram_comment",
    comment_id: "17958276893123456",
    channel_session_id: SESSAO_IG,
    autor_id: IGSID,
  },
};

function conversaIg(over: Linha = {}): Linha {
  return {
    id: "conv-ig",
    organization_id: ORG,
    contact_id: CONTATO,
    is_group: false,
    channel_session_id: SESSAO_IG,
    provider_conversation_id: IGSID,
    last_inbound_at: seg(30),
    channel_sessions: { provider: CANAL_DO_DIRECT },
    ...over,
  };
}

function inbound(over: Linha = {}): Linha {
  return {
    id: "quero",
    organization_id: ORG,
    contact_id: CONTATO,
    conversation_id: "conv-ig",
    channel_session_id: SESSAO_IG,
    direction: "inbound",
    type: "text",
    body: "QUERO",
    metadata: {},
    sent_at: seg(30),
    created_at: seg(30),
    ...over,
  };
}

function execucao(over: Linha = {}): Linha {
  return {
    id: ENR,
    organization_id: ORG,
    lane: "automacao",
    status: "waiting_reply",
    contact_id: CONTATO,
    current_node_id: "espera",
    next_eval_at: "2026-11-04T11:00:00.000Z",
    created_at: seg(-60),
    vars: VARS,
    ...over,
  };
}

function bancoBase(over: Record<string, Linha[]> = {}) {
  return criarBancoEmMemoria({
    contacts: [{ id: CONTATO, organization_id: ORG, phone_number: null, is_blocked: false }],
    conversations: [],
    messages: [],
    followup_enrollments: [execucao()],
    followup_enrollment_events: [
      {
        organization_id: ORG,
        enrollment_id: ENR,
        node_id: "espera",
        event_type: "wait_started",
        payload: { wake_status: "waiting_reply" },
        created_at: ESTACIONOU,
      },
    ],
    ...over,
  });
}

const admin = (b: ReturnType<typeof criarBancoEmMemoria>) => b as unknown as SupabaseClient;

describe("escopoDoDirect", () => {
  it("só a execução que começou por comentário tem escopo do Direct", () => {
    expect(escopoDoDirect(VARS)).toEqual({ channelSessionId: SESSAO_IG, autorId: IGSID });
    expect(escopoDoDirect({ gatilho: { tipo: "message_received", channel_session_id: SESSAO_IG } })).toBeNull();
    expect(escopoDoDirect({})).toBeNull();
  });
});

describe("a espera acorda pela resposta no Direct, numa conversa que nasceu depois", () => {
  beforeEach(() => {
    enviarMock.mockReset();
    enviarMock.mockResolvedValue({ id: "msg-1", status: "sent" });
  });

  it("sem conversa ainda: não acorda; a pessoa responde (conversa nasce): acorda, lê a resposta e o bloco seguinte envia por ela", async () => {
    const b = bancoBase();
    const escopo = escopoDoDirect(VARS);
    expect(await ultimaRespostaDaAutomacao(admin(b), ORG, [CONTATO], escopo)).toBeNull();
    expect(await createSupabaseAdminClient(admin(b)).loadRespostasDaEspera!(ORG, CONTATO, ESTACIONOU, escopo)).toEqual([]);

    // A pessoa responde "QUERO" no Direct: o canal cria a conversa e a mensagem.
    b.tabelas.conversations!.push(conversaIg());
    b.tabelas.messages!.push(inbound());

    const chegou = await ultimaRespostaDaAutomacao(admin(b), ORG, [CONTATO], escopo);
    expect(chegou).toEqual({ sent_at: seg(30), created_at: seg(30) });
    const enr = b.tabelas.followup_enrollments![0]!;
    expect(
      await acordarAutomacaoEmEspera(
        admin(b),
        enr as unknown as Parameters<typeof acordarAutomacaoEmEspera>[1],
        chegou!,
        AGORA,
      ),
    ).toBe(true);
    expect(enr.next_eval_at).toBe(AGORA.toISOString());
    expect(
      await createSupabaseAdminClient(admin(b)).loadRespostasDaEspera!(ORG, CONTATO, ESTACIONOU, escopo),
    ).toEqual([{ texto: "QUERO", replyId: null }]);

    // O bloco seguinte (Mensagem com o link) acha a conversa que a resposta criou.
    const c: Contexto = {
      admin: admin(b),
      org: ORG,
      pointerId: "ptr-1",
      enrollmentId: ENR,
      chave: "msg:1",
      contatoId: CONTATO,
      fatos: null,
      vars: VARS,
      handler: { requestId: "automacao:ptr-1:req" } as Contexto["handler"],
      agora: AGORA,
    };
    const no = {
      id: "msg",
      type: "message",
      label: "Link",
      position: { x: 0, y: 0 },
      config: { body: "Aqui está o link" },
    } as unknown as Extract<FlowNode, { type: "message" }>;
    const r = await executarConversa(c, no, { tipo: "enviar", envio: "mensagem" }, "msg", async () => ({ ok: true, detalhe: {} }));
    expect(r.desfecho.ok).toBe(true);
    expect((enviarMock.mock.calls[0]![2] as { conversation_id: string }).conversation_id).toBe("conv-ig");
  });

  it("inbound de outra pessoa, de outra conexão ou de outra organização não acorda nem conta como resposta", async () => {
    const b = bancoBase({
      conversations: [
        conversaIg({ id: "outra-pessoa", provider_conversation_id: "999", contact_id: "outro" }),
        conversaIg({ id: "outra-conexao", channel_session_id: OUTRA_SESSAO }),
        conversaIg({ id: "outra-org", organization_id: OUTRA_ORG }),
        // O MESMO contato pelo WhatsApp: na execução do comentário não conta.
        conversaIg({ id: "wa", channel_session_id: OUTRA_SESSAO, provider_conversation_id: null, channel_sessions: { provider: CANAL_DE_WHATSAPP } }),
      ],
      messages: [
        inbound({ id: "1", conversation_id: "outra-pessoa", contact_id: "outro" }),
        inbound({ id: "2", conversation_id: "outra-conexao" }),
        inbound({ id: "3", conversation_id: "outra-org", organization_id: OUTRA_ORG }),
        inbound({ id: "4", conversation_id: "wa" }),
      ],
    });
    const escopo = escopoDoDirect(VARS);
    expect(await ultimaRespostaDaAutomacao(admin(b), ORG, [CONTATO], escopo)).toBeNull();
    expect(await createSupabaseAdminClient(admin(b)).loadRespostasDaEspera!(ORG, CONTATO, ESTACIONOU, escopo)).toEqual([]);
  });

  it("execução de WhatsApp segue lendo pelo contato (sem escopo), como antes", async () => {
    const b = bancoBase({ messages: [inbound({ conversation_id: "qualquer" })] });
    expect(await ultimaRespostaDaAutomacao(admin(b), ORG, [CONTATO])).not.toBeNull();
    expect(await createSupabaseAdminClient(admin(b)).loadRespostasDaEspera!(ORG, CONTATO, ESTACIONOU)).toHaveLength(1);
  });
});

describe("o \"quero\" é da automação que espera no Direct (não dispara mensagem recebida)", () => {
  const pergunta = (b: ReturnType<typeof criarBancoEmMemoria>, conversa: string, chegadaEm = seg(30)) =>
    createSupabaseGatilhosDb(admin(b)).respostaAAutomacaoNaConversa(ORG, conversa, chegadaEm);

  it("conversa do Direct de quem comentou, com a execução esperando: é resposta", async () => {
    const b = bancoBase({ conversations: [conversaIg()], messages: [inbound()] });
    expect(await pergunta(b, "conv-ig")).toBe(true);
    // E também depois que a execução já consumiu e saiu da espera (evento lido atrasado).
    b.tabelas.followup_enrollments![0]!.status = "completed";
    b.tabelas.followup_enrollment_events!.push({
      organization_id: ORG,
      enrollment_id: ENR,
      node_id: "espera",
      event_type: "node_advanced",
      payload: {},
      created_at: seg(60),
    });
    expect(await pergunta(b, "conv-ig")).toBe(true);
  });

  it("outra conexão, outra pessoa ou execução que nasceu depois da mensagem: não é resposta", async () => {
    const b = bancoBase({
      conversations: [
        conversaIg({ id: "outra-conexao", channel_session_id: OUTRA_SESSAO }),
        conversaIg({ id: "outra-pessoa", provider_conversation_id: "999" }),
        conversaIg(),
      ],
    });
    expect(await pergunta(b, "outra-conexao")).toBe(false);
    expect(await pergunta(b, "outra-pessoa")).toBe(false);
    // Uma execução nova (outro comentário) que começou a esperar DEPOIS da mensagem.
    b.tabelas.followup_enrollments![0]!.created_at = seg(120);
    b.tabelas.followup_enrollment_events![0]!.created_at = seg(150);
    expect(await pergunta(b, "conv-ig", seg(30))).toBe(false);
  });

  it("automação sem comentário e sem envio na conversa continua não sendo dona da mensagem", async () => {
    const b = bancoBase({
      conversations: [conversaIg()],
      followup_enrollments: [execucao({ vars: { gatilho: { tipo: "message_received" } } })],
    });
    expect(await automacaoEsperaRespostaNaConversaSupabase(admin(b), { organizationId: ORG, conversationId: "conv-ig", chegadaEm: seg(30) })).toBe(false);
  });
});

describe("uma voz no Direct: a IA cede enquanto a execução espera nesta conversa", () => {
  /** Aplica a regra da consulta do drain aos dados, como o Postgres. */
  function pool(execucoes: Linha[], conversas: Linha[]): Pick<pg.Pool, "query"> {
    return {
      query: vi.fn(async (_sql: string, params: unknown[] = []) => {
        const [org, conversa] = params as [string, string];
        const c = conversas.find((x) => x.organization_id === org && x.id === conversa);
        const achou = execucoes.some((e) => {
          const g = (e.vars as { gatilho?: Record<string, unknown> } | undefined)?.gatilho;
          return (
            e.organization_id === org &&
            e.lane === "automacao" &&
            e.status === "waiting_reply" &&
            !!c &&
            g?.tipo === "instagram_comment" &&
            g.channel_session_id === c.channel_session_id &&
            g.autor_id === c.provider_conversation_id
          );
        });
        return { rows: achou ? [{ "?column?": 1 }] : [] };
      }),
    } as unknown as Pick<pg.Pool, "query">;
  }

  it("cede na conversa do Direct de quem comentou; não cede noutra conexão nem depois que a execução saiu da espera", async () => {
    const conversas = [conversaIg(), conversaIg({ id: "outra-conexao", channel_session_id: OUTRA_SESSAO })];
    expect(await automacaoEsperaRespostaNaConversa(pool([execucao()], conversas), { organizationId: ORG, conversationId: "conv-ig" })).toBe(true);
    expect(await automacaoEsperaRespostaNaConversa(pool([execucao()], conversas), { organizationId: ORG, conversationId: "outra-conexao" })).toBe(false);
    expect(await automacaoEsperaRespostaNaConversa(pool([execucao({ status: "completed" })], conversas), { organizationId: ORG, conversationId: "conv-ig" })).toBe(false);
  });

  it("a consulta do drain inclui a ligação pelo gatilho (conexão e IGSID)", async () => {
    const p = pool([], []);
    await automacaoEsperaRespostaNaConversa(p, { organizationId: ORG, conversationId: "conv-ig" });
    const sql = (p.query as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).toContain("provider_conversation_id = e.vars->'gatilho'->>'autor_id'");
    expect(sql).toContain("channel_session_id::text = e.vars->'gatilho'->>'channel_session_id'");
  });

  it("a automação recusa a resposta e termina: o turno volta para a IA pela conversa do Direct (sem envio da automação nela)", async () => {
    const b = bancoBase({
      conversations: [conversaIg({ channel_session_id: SESSAO_IG })],
      messages: [inbound({ created_at: seg(30) })],
      event_log: [],
      job_queue: [],
    });
    expect(await devolverTurnoAoAgente(admin(b), { organizationId: ORG, enrollmentId: ENR, desde: ESTACIONOU })).toBe("emitido");
    expect(b.chamadasRpc[0]?.args).toMatchObject({ p_entity_id: "quero" });
  });
});

describe("publicação: no Instagram, Mensagem/Pergunta só depois de esperar a resposta", () => {
  const pos = { x: 0, y: 0 };
  const INICIO = (kind = "instagram_comment") => ({
    id: "t",
    type: "trigger",
    label: "Início",
    position: pos,
    config: {
      triggers: [kind === "instagram_comment" ? { kind, match: "any", keywords: [] } : { kind, match: "any", keywords: [] }],
      reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
    },
  });
  const PRIV = { id: "priv", type: "instagram_private_reply", label: "Privada", position: pos, config: { text: "Responda QUERO" } };
  const ESPERA = { id: "espera", type: "wait", label: "Aguardar", position: pos, config: { mode: "until_reply", timeout_ms: 86_400_000 } };
  const MSG = { id: "msg", type: "message", label: "Link", position: pos, config: { body: "Aqui está" } };
  const FIM = { id: "fim", type: "end", label: "Fim", position: pos, config: { outcome: "converted" } };
  const a = (id: string, source: string, target: string, branch?: string) => ({
    id,
    source,
    target,
    condition: branch ? { type: "branch", branch_id: branch } : { type: "always" },
  });
  const grafo = (nodes: unknown[], edges: unknown[]): FlowGraph => flowGraphSchema.parse({ nodes, edges });
  const erros = (g: FlowGraph) => {
    const r = validateFlowForPublish(g, { surface: "automacao" });
    return r.ok ? [] : r.errors.filter((e) => e.code === "instagram_mensagem_antes_da_resposta");
  };

  it("privada → Mensagem direto é recusada com a frase legível", () => {
    const e = erros(grafo([INICIO(), PRIV, MSG, FIM], [a("1", "t", "priv"), a("2", "priv", "msg"), a("3", "msg", "fim")]));
    expect(e).toHaveLength(1);
    expect(e[0]!.node_id).toBe("msg");
    expect(e[0]!.message).toContain(
      "No Instagram, a conversa só abre quando a pessoa responde. Ponha um 'Aguardar o contato responder' antes.",
    );
  });

  it("privada → Aguardar até responder → (Respondeu) Mensagem passa", () => {
    const g = grafo(
      [INICIO(), PRIV, ESPERA, MSG, FIM],
      [a("1", "t", "priv"), a("2", "priv", "espera"), a("3", "espera", "msg"), a("4", "espera", "fim", "no_reply"), a("5", "msg", "fim")],
    );
    expect(erros(g)).toEqual([]);
  });

  it("Mensagem na saída \"Sem resposta\" da espera continua recusada (a pessoa não respondeu)", () => {
    const g = grafo(
      [INICIO(), PRIV, ESPERA, MSG, FIM],
      [a("1", "t", "priv"), a("2", "priv", "espera"), a("3", "espera", "fim"), a("4", "espera", "msg", "no_reply"), a("5", "msg", "fim")],
    );
    expect(erros(g).map((x) => x.node_id)).toEqual(["msg"]);
  });

  it("automação de WhatsApp (gatilho de mensagem) não muda", () => {
    const g = grafo([INICIO("message_received"), MSG, FIM], [a("1", "t", "msg"), a("2", "msg", "fim")]);
    expect(erros(g)).toEqual([]);
  });
});

describe("histórico: envios e resposta pelo Direct, sem o texto do contato", () => {
  const ev = (detalhes: Array<Record<string, unknown>>) =>
    descreveEvento(
      { id: "x", node_id: null, event_type: "effect_done", payload: { detalhes }, created_at: AGORA.toISOString() },
      {},
      "pt-BR",
      "automacao",
    ).detalhe;

  it("\"Respondeu no Direct\" e \"enviada pelo Direct\"; WhatsApp como antes", () => {
    expect(ev([{ tipo: "wait", envio: "resposta", canal: "direct", ok: true }])).toBe("Respondeu no Direct");
    expect(ev([{ tipo: "message", envio: "resposta", canal: "direct", opcao_rotulo: "Quero", ok: true }])).toBe(
      "Respondeu no Direct: escolheu “Quero”",
    );
    expect(ev([{ tipo: "message", envio: "mensagem", canal: "direct", ok: true }])).toBe("Mensagem: enviada pelo Direct");
    expect(ev([{ tipo: "message", envio: "mensagem", ok: true }])).toBe("Mensagem: enviada");
    expect(ev([{ tipo: "message", envio: "resposta", ok: true }])).toBe("Resposta do contato: registrada");
  });

  it("o evento da resposta registrada no Direct não guarda o texto do contato", async () => {
    const b = bancoBase({ conversations: [conversaIg()] });
    const c: Contexto = {
      admin: admin(b),
      org: ORG,
      pointerId: "ptr-1",
      enrollmentId: ENR,
      chave: "espera:1",
      contatoId: CONTATO,
      fatos: null,
      vars: VARS,
      handler: { requestId: "automacao:ptr-1:req" } as Contexto["handler"],
      agora: AGORA,
    };
    const espera = { id: "espera", type: "wait", label: "Aguardar", position: { x: 0, y: 0 }, config: { mode: "until_reply", timeout_ms: 86_400_000 } } as unknown as Extract<FlowNode, { type: "wait" }>;
    const r = await executarConversa(
      c,
      espera,
      { tipo: "registrar_resposta", valor: "QUERO o link" } as Parameters<typeof executarConversa>[2],
      "espera",
      async () => ({ ok: true, detalhe: {} }),
    );
    expect(r.detalhes?.[0]).toMatchObject({ envio: "resposta", canal: "direct", ok: true });
    expect(JSON.stringify(r.detalhes)).not.toContain("QUERO");
  });
});

describe("corrida: o \"quero\" que chega antes de a espera estacionar", () => {
  const INICIO = seg(-60);
  const ev = (over: Linha): Linha => ({ organization_id: ORG, enrollment_id: ENR, payload: {}, ...over });
  const historico = (extra: Linha[] = []): Linha[] => [
    ev({ node_id: "t", event_type: "automacao_iniciada", created_at: INICIO }),
    ev({ node_id: "privada", event_type: "effect_done", payload: { detalhes: [{ tipo: "instagram_private_reply", ok: true }] }, created_at: seg(-59) }),
    ev({ node_id: "privada", event_type: "node_advanced", created_at: seg(-59) }),
    ...extra,
    ev({ node_id: "espera", event_type: "wait_started", payload: { wake_status: "waiting_reply" }, created_at: ESTACIONOU }),
  ];

  it("pisoDaRespostaNoDirect: o início da execução; o registro de resposta de outro bloco empurra o piso; sem created_at, nada se afirma", () => {
    const eventos = historico() as unknown as Parameters<typeof pisoDaRespostaNoDirect>[0];
    expect(pisoDaRespostaNoDirect(eventos, "espera", INICIO)).toBe(INICIO);
    const comResposta = historico([
      ev({ node_id: "pergunta", event_type: "effect_done", payload: { detalhes: [{ tipo: "question", envio: "resposta", ok: true }] }, created_at: seg(-30) }),
      ev({ node_id: "pergunta", event_type: "node_advanced", created_at: seg(-30) }),
    ]) as unknown as Parameters<typeof pisoDaRespostaNoDirect>[0];
    expect(pisoDaRespostaNoDirect(comResposta, "espera", INICIO)).toBe(seg(-30));
    const semData = [{ node_id: "t", idempotency_key: null, event_type: "automacao_iniciada" }];
    expect(pisoDaRespostaNoDirect(semData, "espera", INICIO)).toBeNull();
  });

  it("relógio: o \"quero\" de antes da espera (depois do início) acorda a execução do Direct; a de WhatsApp segue a régua de sempre", async () => {
    const antes = { sent_at: seg(-20), created_at: seg(-20) };
    const b = bancoBase({ followup_enrollment_events: historico(), followup_enrollments: [execucao({ started_at: INICIO })] });
    const enr = b.tabelas.followup_enrollments![0]! as unknown as Parameters<typeof acordarAutomacaoEmEspera>[1];
    expect(await acordarAutomacaoEmEspera(admin(b), enr, antes, AGORA)).toBe(true);

    const w = bancoBase({
      followup_enrollment_events: historico(),
      followup_enrollments: [execucao({ started_at: INICIO, vars: {} })],
    });
    const enrW = w.tabelas.followup_enrollments![0]! as unknown as Parameters<typeof acordarAutomacaoEmEspera>[1];
    expect(await acordarAutomacaoEmEspera(admin(w), enrW, antes, AGORA)).toBe(false);

    // Mensagem de ANTES do início da execução (outro comentário, outra conversa) não conta.
    const b2 = bancoBase({ followup_enrollment_events: historico(), followup_enrollments: [execucao({ started_at: INICIO })] });
    const enr2 = b2.tabelas.followup_enrollments![0]! as unknown as Parameters<typeof acordarAutomacaoEmEspera>[1];
    expect(await acordarAutomacaoEmEspera(admin(b2), enr2, { sent_at: seg(-120), created_at: seg(-120) }, AGORA)).toBe(false);
  });

  it("nova tentativa: o piso volta ao da espera em curso, e a resposta já lida não acorda de novo", async () => {
    const eventos = historico();
    // Primeira leitura: resposta inválida → nova tentativa (e nova espera).
    eventos.push(
      ev({ node_id: "espera", event_type: "effect_done", payload: { detalhes: [{ tipo: "question", envio: "nova_tentativa", ok: true }] }, created_at: seg(10) }),
      ev({ node_id: "espera", event_type: "wait_started", payload: { wake_status: "waiting_reply" }, created_at: seg(11) }),
    );
    const b = bancoBase({ followup_enrollment_events: eventos, followup_enrollments: [execucao({ started_at: INICIO })] });
    const enr = b.tabelas.followup_enrollments![0]! as unknown as Parameters<typeof acordarAutomacaoEmEspera>[1];
    expect(await acordarAutomacaoEmEspera(admin(b), enr, { sent_at: seg(-20), created_at: seg(-20) }, AGORA)).toBe(false);
    expect(await acordarAutomacaoEmEspera(admin(b), enr, { sent_at: seg(20), created_at: seg(20) }, AGORA)).toBe(true);
  });

  it("motor: a primeira leitura no Direct lê o \"quero\" de antes da espera pelo piso recuado", async () => {
    const b = bancoBase({ conversations: [conversaIg()], messages: [inbound({ sent_at: seg(-20), created_at: seg(-20) })] });
    const db = createSupabaseAdminClient(admin(b));
    const escopo = escopoDoDirect(VARS);
    expect(await db.loadRespostasDaEspera!(ORG, CONTATO, ESTACIONOU, escopo)).toEqual([]);
    const piso = pisoDaRespostaNoDirect(historico() as never, "espera", INICIO)!;
    expect(await db.loadRespostasDaEspera!(ORG, CONTATO, piso, escopo)).toEqual([{ texto: "QUERO", replyId: null }]);
  });
});
