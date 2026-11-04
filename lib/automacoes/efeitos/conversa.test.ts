/**
 * O envio dos blocos de mensagem/pergunta (`executarConversa`, ação `enviar`).
 *
 * Banco em memória que FILTRA de verdade (eq/in/is/not/gte), para que "outra
 * organização" e "teto de 30 por hora" sejam medidos pelo comportamento, não
 * por mock do próprio código. Só a borda é simulada: `sendMessageHandler`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { enviarMock } = vi.hoisted(() => ({ enviarMock: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: enviarMock }));

import { ApiError } from "@/lib/api/types";
import { capabilitiesOf, PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";
import { ehCanalDeWhatsapp } from "@/lib/channels/canal-de-whatsapp";
import { ehCanalDoDirect } from "@/lib/channels/canal-do-direct";
import {
  avancarEnrollmentAtivo,
  type AdminClient,
  type ExecutorDeEfeitos,
  type TickDeps,
} from "@/lib/followup/engine";
import { flowGraphSchema, type FlowNode } from "@/lib/followup/graph-schema";
import type { EnrollmentEventRef, EnrollmentRow } from "@/lib/followup/node-handlers";

import { TETO_DE_MENSAGENS_POR_HORA } from "../teto-de-mensagens";
import { executarConversa, idDaMensagemDoPasso } from "./conversa";
import type { Contexto } from "./index";

type Linha = Record<string, unknown>;
type Tabelas = Record<string, Linha[]>;

function valorDoCaminho(linha: Linha, caminho: string): unknown {
  // "metadata->origem_automacao" lê o objeto aninhado.
  return caminho
    .split("->")
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === "object" ? (acc as Linha)[k] : undefined),
      linha,
    );
}

function criarBanco(tabelas: Tabelas) {
  const consultas: Array<{ tabela: string; eq: Array<[string, unknown]> }> = [];
  const admin = {
    from(tabela: string) {
      const filtros: Array<(l: Linha) => boolean> = [];
      const eqs: Array<[string, unknown]> = [];
      let limite = Infinity;
      let ordem: { col: string; asc: boolean } | null = null;
      let contar = false;
      const executar = () => {
        let linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        if (ordem) {
          const { col, asc } = ordem;
          linhas = [...linhas].sort((a, b) => {
            const x = String(a[col] ?? ""),
              y = String(b[col] ?? "");
            return asc ? x.localeCompare(y) : y.localeCompare(x);
          });
        }
        return linhas.slice(0, limite);
      };
      const b: Record<string, unknown> = {
        select(_cols?: string, opts?: { count?: string }) {
          contar = Boolean(opts?.count);
          return b;
        },
        eq(col: string, v: unknown) {
          eqs.push([col, v]);
          filtros.push((l) => valorDoCaminho(l, col) === v);
          return b;
        },
        in(col: string, vs: unknown[]) {
          filtros.push((l) => vs.includes(valorDoCaminho(l, col)));
          return b;
        },
        is(col: string, v: null) {
          filtros.push((l) => (valorDoCaminho(l, col) ?? null) === v);
          return b;
        },
        not(col: string, _op: string, v: null) {
          filtros.push((l) => (valorDoCaminho(l, col) ?? null) !== v);
          return b;
        },
        gte(col: string, v: string) {
          filtros.push((l) => String(valorDoCaminho(l, col)) >= v);
          return b;
        },
        order(col: string, o?: { ascending?: boolean }) {
          ordem = { col, asc: o?.ascending !== false };
          return b;
        },
        limit(n: number) {
          limite = n;
          return b;
        },
        maybeSingle() {
          consultas.push({ tabela, eq: eqs });
          return Promise.resolve({ data: executar()[0] ?? null, error: null });
        },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          consultas.push({ tabela, eq: eqs });
          const linhas = executar();
          return Promise.resolve(
            contar
              ? { data: null, count: linhas.length, error: null }
              : { data: linhas, error: null },
          ).then(res, rej);
        },
      };
      return b;
    },
  };
  return { admin: admin as unknown as SupabaseClient, consultas };
}

// Os providers vêm da CAPACIDADE, não do nome (cerca lint:channels): um canal de
// WhatsApp que aceita texto livre a qualquer hora e um que fecha a janela de 24h.
const CANAIS_DE_WHATSAPP = PROVIDERS_DE_MENSAGEM.filter((p) => ehCanalDeWhatsapp(p));
const CANAL_SEM_JANELA = CANAIS_DE_WHATSAPP.find((p) => capabilitiesOf(p).freeformOutsideWindow)!;
const CANAL_COM_JANELA = CANAIS_DE_WHATSAPP.find((p) => !capabilitiesOf(p).freeformOutsideWindow)!;

const ORG = "org-1";
const OUTRA_ORG = "org-2";
const CONTATO = "contato-1";
const AGORA = new Date("2026-11-03T12:00:00.000Z");
const HA_1H = new Date(AGORA.getTime() - 60 * 60 * 1000).toISOString();
const HA_2_DIAS = new Date(AGORA.getTime() - 48 * 60 * 60 * 1000).toISOString();

function conversa(over: Linha = {}): Linha {
  return {
    id: "conv-1",
    organization_id: ORG,
    contact_id: CONTATO,
    is_group: false,
    last_inbound_at: HA_1H,
    channel_sessions: { provider: CANAL_SEM_JANELA },
    ...over,
  };
}

function tabelasBase(over: Tabelas = {}): Tabelas {
  return {
    conversations: [conversa()],
    contacts: [{ id: CONTATO, organization_id: ORG, is_blocked: false, phone_number: null }],
    messages: [],
    ...over,
  };
}

function contexto(admin: SupabaseClient, over: Partial<Contexto> = {}): Contexto {
  return {
    admin,
    org: ORG,
    pointerId: "ptr-1",
    enrollmentId: "enr-1",
    chave: "message-1:0",
    contatoId: CONTATO,
    fatos: null,
    handler: { requestId: "automacao:ptr-1:req" } as Contexto["handler"],
    agora: AGORA,
    ...over,
  };
}

const pos = { x: 0, y: 0 };
const NO_MENSAGEM = {
  id: "message-1",
  type: "message",
  label: "Mensagem",
  position: pos,
  config: { body: "Olá, tudo bem?" },
} as unknown as Extract<FlowNode, { type: "message" }>;

const NO_COM_OPCOES = {
  ...NO_MENSAGEM,
  config: {
    body: "Qual o seu interesse?",
    options: {
      kind: "buttons",
      items: [
        { id: "moradia", label: "Moradia" },
        { id: "invest", label: "Investimento" },
      ],
    },
  },
} as unknown as Extract<FlowNode, { type: "message" }>;

const ENVIAR = { tipo: "enviar", envio: "mensagem" } as const;
const noop = async () => ({ ok: true, detalhe: {} });

function erroDe(r: Awaited<ReturnType<typeof executarConversa>>): string | undefined {
  return r.desfecho.ok ? undefined : r.desfecho.erro;
}

describe("executarConversa: envio", () => {
  beforeEach(() => {
    enviarMock.mockReset();
    enviarMock.mockResolvedValue({ id: "msg-1", status: "sent" });
  });

  it("contato sem conversa de WhatsApp: sem_conversa_whatsapp, nada enviado", async () => {
    const { admin } = criarBanco(tabelasBase({ conversations: [] }));
    const r = await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(erroDe(r)).toBe("sem_conversa_whatsapp");
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it("conversa só de grupo ou de Instagram não conta como conversa de WhatsApp", async () => {
    const { admin } = criarBanco(
      tabelasBase({
        conversations: [
          conversa({ id: "g", is_group: true }),
          conversa({ id: "ig", channel_sessions: { provider: "meta_social" } }),
        ],
      }),
    );
    const r = await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(erroDe(r)).toBe("sem_conversa_whatsapp");
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it("contato bloqueado: contato_bloqueado, nada enviado", async () => {
    const { admin } = criarBanco(
      tabelasBase({
        contacts: [{ id: CONTATO, organization_id: ORG, is_blocked: true, phone_number: null }],
      }),
    );
    const r = await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(erroDe(r)).toBe("contato_bloqueado");
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it("janela de 24h fechada no canal oficial: janela_fechada antes de tentar enviar", async () => {
    const { admin } = criarBanco(
      tabelasBase({
        conversations: [
          conversa({
            last_inbound_at: HA_2_DIAS,
            channel_sessions: { provider: CANAL_COM_JANELA },
          }),
        ],
      }),
    );
    const r = await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(erroDe(r)).toBe("janela_fechada");
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it("sendMessageHandler lança ApiError janela_fechada: motivo janela_fechada", async () => {
    const { admin } = criarBanco(tabelasBase());
    enviarMock.mockRejectedValue(new ApiError(409, "janela_fechada", undefined, "req"));
    const r = await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(enviarMock).toHaveBeenCalledTimes(1);
    expect(erroDe(r)).toBe("janela_fechada");
  });

  it("sendMessageHandler lança ApiError 403: contato_bloqueado", async () => {
    const { admin } = criarBanco(tabelasBase());
    enviarMock.mockRejectedValue(new ApiError(403, "contact_blocked", undefined, "req"));
    const r = await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(erroDe(r)).toBe("contato_bloqueado");
  });

  it("teto de 30/h atingido: teto_por_hora e NADA é enviado", async () => {
    const marcadas = Array.from({ length: TETO_DE_MENSAGENS_POR_HORA }, (_, i) => ({
      id: `m-${i}`,
      organization_id: ORG,
      contact_id: CONTATO,
      direction: "outbound",
      created_at: new Date(AGORA.getTime() - 5 * 60 * 1000).toISOString(),
      metadata: { origem_automacao: { enrollment_id: "outra", pointer_id: "p" } },
    }));
    const { admin } = criarBanco(tabelasBase({ messages: marcadas }));
    const r = await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(erroDe(r)).toBe("teto_por_hora");
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it("teto soma o contato e o GÊMEO de telefone: 15 + 15 = 30 e nada é enviado", async () => {
    const FONE = "+5535991234567";
    const recente = new Date(AGORA.getTime() - 5 * 60 * 1000).toISOString();
    const marca = { origem_automacao: { enrollment_id: "outra", pointer_id: "p" } };
    const para = (contato: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${contato}-${i}`,
        organization_id: ORG,
        contact_id: contato,
        direction: "outbound",
        created_at: recente,
        metadata: marca,
      }));
    const contatos = [
      {
        id: CONTATO,
        organization_id: ORG,
        is_blocked: false,
        phone_number: FONE,
        is_merged_into: null,
      },
      {
        id: "gemeo",
        organization_id: ORG,
        is_blocked: false,
        phone_number: FONE,
        is_merged_into: null,
      },
    ];
    const metade = TETO_DE_MENSAGENS_POR_HORA / 2;
    const { admin } = criarBanco(
      tabelasBase({
        contacts: contatos,
        messages: [...para(CONTATO, metade), ...para("gemeo", metade)],
      }),
    );
    const r = await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(erroDe(r)).toBe("teto_por_hora");
    expect(enviarMock).not.toHaveBeenCalled();

    // Sem o gêmeo (outro telefone), as 15 dele não contam: envia.
    const separados = [contatos[0]!, { ...contatos[1]!, phone_number: "+5511988887777" }];
    const b2 = criarBanco(
      tabelasBase({
        contacts: separados,
        messages: [...para(CONTATO, metade), ...para("gemeo", metade)],
      }),
    );
    const r2 = await executarConversa(contexto(b2.admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(r2.desfecho.ok).toBe(true);
  });

  it("29 mensagens na última hora, mais as que não contam (sem marca, fora da hora, outra org): ainda envia", async () => {
    const recente = new Date(AGORA.getTime() - 5 * 60 * 1000).toISOString();
    const marca = { origem_automacao: { enrollment_id: "x", pointer_id: "p" } };
    const base = { contact_id: CONTATO, direction: "outbound" };
    const contam = Array.from({ length: TETO_DE_MENSAGENS_POR_HORA - 1 }, (_, i) => ({
      ...base,
      id: `c-${i}`,
      organization_id: ORG,
      created_at: recente,
      metadata: marca,
    }));
    const naoContam = [
      { ...base, id: "sem-marca", organization_id: ORG, created_at: recente, metadata: {} },
      { ...base, id: "velha", organization_id: ORG, created_at: HA_2_DIAS, metadata: marca },
      {
        ...base,
        id: "outra-org",
        organization_id: OUTRA_ORG,
        created_at: recente,
        metadata: marca,
      },
    ];
    const { admin } = criarBanco(tabelasBase({ messages: [...contam, ...naoContam] }));
    const r = await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(r.desfecho.ok).toBe(true);
    expect(enviarMock).toHaveBeenCalledTimes(1);
  });

  it("envio que falha (status failed ou exceção qualquer): envio_falhou", async () => {
    const { admin } = criarBanco(tabelasBase());
    enviarMock.mockResolvedValueOnce({ id: "msg-1", status: "failed" });
    expect(
      erroDe(await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop)),
    ).toBe("envio_falhou");
    enviarMock.mockRejectedValueOnce(new Error("rede caiu"));
    expect(
      erroDe(await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop)),
    ).toBe("envio_falhou");
  });

  it("corpo que passa do limite DEPOIS de preencher as variáveis: ramo Erro com motivo próprio, nada enviado", async () => {
    const { admin } = criarBanco(tabelasBase());
    const fatos = {
      contato: null,
      negocio: null,
      negocios: [],
      vars: { resposta: { longa: "x".repeat(1100) } },
    } as unknown as Contexto["fatos"];
    const comOpcoes = {
      ...NO_COM_OPCOES,
      config: { ...NO_COM_OPCOES.config, body: "Oi {{resposta.longa}}" },
    } as typeof NO_COM_OPCOES;
    const r = await executarConversa(
      contexto(admin, { fatos }),
      comOpcoes,
      ENVIAR,
      "message-1",
      noop,
    );
    expect(erroDe(r)).toBe("texto_longo_com_opcoes");
    expect(enviarMock).not.toHaveBeenCalled();

    // Sem opções, o limite é 4096: 1100 cabem, 4100 não.
    const semOpcoes = {
      ...NO_MENSAGEM,
      config: { body: "Oi {{resposta.longa}}" },
    } as typeof NO_MENSAGEM;
    expect(
      (await executarConversa(contexto(admin, { fatos }), semOpcoes, ENVIAR, "message-1", noop))
        .desfecho.ok,
    ).toBe(true);
    const enorme = {
      contato: null,
      negocio: null,
      negocios: [],
      vars: { resposta: { longa: "x".repeat(4100) } },
    } as unknown as Contexto["fatos"];
    expect(
      erroDe(
        await executarConversa(
          contexto(admin, { fatos: enorme }),
          semOpcoes,
          ENVIAR,
          "message-1",
          noop,
        ),
      ),
    ).toBe("texto_longo");
  });

  it("envio ok: handler chamado uma vez, com origem_automacao, conversa e texto", async () => {
    const { admin } = criarBanco(tabelasBase());
    const r = await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(r.desfecho).toEqual({ ok: true });
    expect(r.detalhes?.[0]).toMatchObject({
      ok: true,
      message_id: "msg-1",
      tipo: "message",
      envio: "mensagem",
    });
    expect(enviarMock).toHaveBeenCalledTimes(1);
    const [, ctx, input] = enviarMock.mock.calls[0]!;
    expect(input).toMatchObject({
      conversation_id: "conv-1",
      type: "text",
      body: "Olá, tudo bem?",
      metadata: { origem_automacao: { enrollment_id: "enr-1", pointer_id: "ptr-1" } },
    });
    expect(input).not.toHaveProperty("interactive");
    expect(ctx).toMatchObject({
      organization_id: ORG,
      actor: { type: "webhook_source", id: "ptr-1" },
      requestId: "automacao:ptr-1:req:mensagem",
    });
  });

  it("com opções, o envio leva interactive; o aviso de tempo esgotado não leva", async () => {
    const { admin } = criarBanco(tabelasBase());
    await executarConversa(contexto(admin), NO_COM_OPCOES, ENVIAR, "message-1", noop);
    const input = enviarMock.mock.calls[0]![2];
    expect(input.interactive).toEqual({
      kind: "buttons",
      items: [
        { id: "moradia", label: "Moradia" },
        { id: "invest", label: "Investimento" },
      ],
    });

    const comTimeout = {
      ...NO_COM_OPCOES,
      config: { ...NO_COM_OPCOES.config, reply_timeout_ms: 1000 },
    } as unknown as Extract<FlowNode, { type: "message" }>;
    // Bloco de mensagem não tem texto de tempo esgotado: nada a enviar, e sem interactive.
    enviarMock.mockClear();
    const r = await executarConversa(
      contexto(admin),
      comTimeout,
      { tipo: "enviar", envio: "tempo_esgotado" },
      "message-1",
      noop,
    );
    expect(r.desfecho.ok).toBe(false);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it("id da linha é determinístico por execução e passo: repetir o passo reusa o mesmo id", async () => {
    const { admin } = criarBanco(tabelasBase());
    await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    const [a, b] = enviarMock.mock.calls.map((c) => c[1].internalMessageId);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(a).toBe(idDaMensagemDoPasso("enr-1", "message-1", "mensagem"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Outro passo, outra execução ou outro tipo de envio geram outro id.
    expect(idDaMensagemDoPasso("enr-1", "message-2", "mensagem")).not.toBe(a);
    expect(idDaMensagemDoPasso("enr-2", "message-1", "mensagem")).not.toBe(a);
    expect(idDaMensagemDoPasso("enr-1", "message-1", "nova_tentativa")).not.toBe(a);
  });

  it("isolamento: conversa, bloqueio e mensagens de OUTRA organização não valem, e as consultas filtram organization_id", async () => {
    const { admin, consultas } = criarBanco({
      conversations: [conversa({ organization_id: OUTRA_ORG })],
      contacts: [{ id: CONTATO, organization_id: OUTRA_ORG, is_blocked: true, phone_number: null }],
      messages: [],
    });
    const r = await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(erroDe(r)).toBe("sem_conversa_whatsapp");

    // Com a conversa na org certa, o bloqueio de OUTRA org não pode barrar o envio.
    const { admin: admin2, consultas: consultas2 } = criarBanco({
      conversations: [conversa(), conversa({ id: "conv-outra", organization_id: OUTRA_ORG })],
      contacts: [
        { id: CONTATO, organization_id: ORG, is_blocked: false, phone_number: null },
        { id: CONTATO, organization_id: OUTRA_ORG, is_blocked: true, phone_number: null },
      ],
      messages: [],
    });
    const r2 = await executarConversa(contexto(admin2), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(r2.desfecho.ok).toBe(true);
    expect(enviarMock.mock.calls[0]![2].conversation_id).toBe("conv-1");

    for (const lista of [consultas, consultas2]) {
      for (const tabela of ["conversations", "contacts"]) {
        const q = lista.filter((c) => c.tabela === tabela);
        expect(q.length).toBeGreaterThan(0);
        for (const c of q) expect(c.eq).toContainEqual(["organization_id", ORG]);
      }
    }
    const msgs = consultas2.filter((c) => c.tabela === "messages");
    expect(msgs.length).toBeGreaterThan(0);
    for (const c of msgs) expect(c.eq).toContainEqual(["organization_id", ORG]);
  });
});

/**
 * LGPD: a resposta do contato vive só em `followup_enrollments.vars` (que a
 * anonimização zera) e no campo do CRM — NUNCA num evento da execução. Pelo
 * motor inteiro, com o efeito real (`executarConversa`); a borda simulada é o
 * canal (`sendMessageHandler`) e a escrita do campo (`gravarCampo`).
 */
describe("resposta da pergunta: nenhum evento guarda o texto do contato", () => {
  const EMAIL = "Maria.Silva@exemplo.com.br";
  const GRAFO_PERGUNTA = flowGraphSchema.parse({
    nodes: [
      {
        id: "t",
        type: "trigger",
        label: "Início",
        position: pos,
        config: {
          triggers: [{ kind: "manual" }],
          reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
        },
      },
      {
        id: "question-1",
        type: "question",
        label: "E-mail",
        position: pos,
        config: {
          question: "Qual o seu e-mail?",
          save_to: { scope: "contact", key: "email" },
          validation: "email",
          timeout_ms: 3_600_000,
          retries: 0,
        },
      },
      { id: "fim", type: "end", label: "Fim", position: pos, config: { outcome: "converted" } },
    ],
    edges: [
      { id: "e0", source: "t", target: "question-1", condition: { type: "always" } },
      { id: "e1", source: "question-1", target: "fim", condition: { type: "always" } },
    ],
  });

  function montarMotor(opts: { falharGravacaoDoPasso?: number } = {}) {
    let agora = new Date(AGORA);
    const eventos: EnrollmentEventRef[] = [];
    const recebidas: Array<{ texto: string; replyId: string | null; em: string }> = [];
    const camposGravados: unknown[] = [];
    let falhasRestantes = opts.falharGravacaoDoPasso === undefined ? 0 : 1;
    let row: EnrollmentRow = {
      id: "enr-1",
      organization_id: ORG,
      pointer_id: "ptr-1",
      version_id: "ver-1",
      contact_id: CONTATO,
      conversation_id: null,
      current_node_id: "t",
      status: "active",
      next_eval_at: agora.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 0,
      outcome: null,
      cancel_reason: null,
      started_at: agora.toISOString(),
      completed_at: null,
      updated_at: agora.toISOString(),
      lane: "automacao",
      vars: {},
    };
    const { admin } = criarBanco(tabelasBase());
    const db: AdminClient = {
      claimDueEnrollments: async () => [],
      loadFlowGraph: async () => GRAFO_PERGUNTA,
      loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
      loadEnrollmentEvents: async () => eventos.map((e) => ({ ...e })),
      loadLastInboundBody: async () => null,
      insertEnrollmentEvent: async (e) => {
        if (eventos.some((x) => x.idempotency_key === e.idempotency_key))
          return { inserted: false };
        eventos.push({
          node_id: e.node_id,
          idempotency_key: e.idempotency_key,
          event_type: e.event_type,
          payload: e.payload,
        });
        return { inserted: true };
      },
      updateEnrollment: async (_id, _org, patch) => {
        // Simula a queda do tick DEPOIS do efeito e ANTES de gravar o passo.
        if (
          falhasRestantes > 0 &&
          row.steps_taken === opts.falharGravacaoDoPasso &&
          patch.steps_taken !== undefined
        ) {
          falhasRestantes--;
          throw new Error("queda simulada");
        }
        row = { ...row, ...patch } as EnrollmentRow;
      },
      loadFlowPointerName: async () => "Automação",
      insertDeadInboxItem: async () => {},
      persistirRespostaFollowup: async () => {},
      loadFatosDaAutomacao: async (_o, _c, vars) => ({
        contato: null,
        negocio: null,
        negocios: [],
        vars,
      }),
      loadRespostasDaEspera: async (_o, _c, desde) => recebidas.filter((r) => r.em >= desde),
    };
    const efeitos: ExecutorDeEfeitos = {
      async executar(p) {
        const c = contexto(admin, { agora, fatos: p.fatos, enrollmentId: p.enrollment.id });
        return executarConversa(
          c,
          p.node as Extract<FlowNode, { type: "question" }>,
          p.acao!,
          p.chave,
          async (ops) => {
            camposGravados.push(ops);
            return { ok: true, detalhe: { tipo: "field_op" } };
          },
        );
      },
    };
    const deps: TickDeps = { db, clock: () => agora, enqueueJob: async () => {}, efeitos };
    return {
      get row() {
        return row;
      },
      eventos,
      camposGravados,
      avancar(ms: number) {
        agora = new Date(agora.getTime() + ms);
      },
      contatoEscreve(texto: string) {
        recebidas.push({ texto, replyId: null, em: agora.toISOString() });
      },
      tick: () => avancarEnrollmentAtivo(deps, row).catch(() => null),
    };
  }

  beforeEach(() => {
    enviarMock.mockReset();
    enviarMock.mockResolvedValue({ id: "msg-1", status: "sent" });
  });

  it("responde o e-mail: campo e vars recebem o valor; nenhum evento contém o e-mail", async () => {
    const m = montarMotor();
    await m.tick();
    expect(m.row.status).toBe("waiting_reply");
    m.avancar(60_000);
    m.contatoEscreve(EMAIL);
    await m.tick();
    expect(m.row.status).toBe("completed");
    expect(m.camposGravados).toEqual([
      [{ target: { scope: "contact", key: "email" }, op: "set", value: EMAIL.toLowerCase() }],
    ]);
    expect(m.row.vars).toMatchObject({ resposta: { question_1: EMAIL.toLowerCase() } });
    const tudo = JSON.stringify(m.eventos).toLowerCase();
    expect(tudo).not.toContain("maria.silva");
    expect(tudo).not.toContain("exemplo.com.br");
  });

  it("replay depois da queda: as vars da resposta voltam da decisão, o campo não é gravado de novo, e o evento segue sem o e-mail", async () => {
    // Passo 1 = o registro da resposta (passo 0 foi o gatilho, depois a espera).
    const m = montarMotor({ falharGravacaoDoPasso: 2 });
    await m.tick();
    expect(m.row.status).toBe("waiting_reply");
    m.avancar(60_000);
    m.contatoEscreve(EMAIL);
    await m.tick(); // efeito feito e evento gravado; a gravação do passo caiu
    expect(m.row.status).toBe("waiting_reply");
    expect(m.camposGravados).toHaveLength(1);
    await m.tick(); // replay: avança pelo ramo da resposta, sem refazer o efeito
    expect(m.row.current_node_id).toBe("fim");
    await m.tick();
    expect(m.row.status).toBe("completed");
    expect(m.camposGravados).toHaveLength(1);
    expect(m.row.vars).toMatchObject({ resposta: { question_1: EMAIL.toLowerCase() } });
    expect(JSON.stringify(m.eventos).toLowerCase()).not.toContain("exemplo.com.br");
  });
});

// ─── Direct (execução que começou por comentário do Instagram) ─────────────
// O canal do Direct vem da CAPACIDADE (cerca lint:channels), nunca do nome.
const CANAL_DO_DIRECT = PROVIDERS_DE_MENSAGEM.find((p) => ehCanalDoDirect(p))!;
const SESSAO_IG = "sessao-ig";
const IGSID = "6543210987654321";
const VARS_DO_COMENTARIO = {
  gatilho: {
    tipo: "instagram_comment",
    comment_id: "17958276893123456",
    channel_session_id: SESSAO_IG,
    autor_id: IGSID,
  },
};

function conversaDoDirect(over: Linha = {}): Linha {
  return conversa({
    id: "conv-ig",
    channel_session_id: SESSAO_IG,
    provider_conversation_id: IGSID,
    channel_sessions: { provider: CANAL_DO_DIRECT },
    ...over,
  });
}

describe("executarConversa: envio pelo Direct", () => {
  beforeEach(() => {
    enviarMock.mockReset();
    enviarMock.mockResolvedValue({ id: "msg-ig", status: "sent" });
  });

  it("envia pela conversa do Direct de quem comentou (mesma conexão e IGSID), não pela de WhatsApp", async () => {
    const { admin } = criarBanco(
      tabelasBase({
        conversations: [
          conversa({ id: "conv-wa" }),
          conversaDoDirect({ id: "outra-conta", channel_session_id: "outra-sessao" }),
          conversaDoDirect({ id: "outra-pessoa", provider_conversation_id: "999" }),
          conversaDoDirect(),
        ],
      }),
    );
    const r = await executarConversa(
      contexto(admin, { vars: VARS_DO_COMENTARIO }),
      NO_COM_OPCOES,
      ENVIAR,
      "message-1",
      noop,
    );
    expect(r.desfecho.ok).toBe(true);
    expect(enviarMock).toHaveBeenCalledTimes(1);
    const corpo = enviarMock.mock.calls[0]![2] as { conversation_id: string; interactive?: unknown };
    expect(corpo.conversation_id).toBe("conv-ig");
    // As opções seguem para o handler, que as numera no canal sem opções nativas.
    expect(corpo.interactive).toBeDefined();
    expect(capabilitiesOf(CANAL_DO_DIRECT).interactive).toBe("none");
    expect(r.detalhes?.[0]).toMatchObject({ canal: "direct", ok: true });
  });

  it("a pessoa ainda não respondeu (sem conversa do Direct): sem_conversa_direct, nada enviado — mesmo com WhatsApp", async () => {
    const { admin } = criarBanco(tabelasBase({ conversations: [conversa({ id: "conv-wa" })] }));
    const r = await executarConversa(
      contexto(admin, { vars: VARS_DO_COMENTARIO }),
      NO_MENSAGEM,
      ENVIAR,
      "message-1",
      noop,
    );
    expect(erroDe(r)).toBe("sem_conversa_direct");
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it("janela de 24h do Direct fechada: janela_fechada antes de tentar enviar", async () => {
    const { admin } = criarBanco(
      tabelasBase({ conversations: [conversaDoDirect({ last_inbound_at: HA_2_DIAS })] }),
    );
    const r = await executarConversa(
      contexto(admin, { vars: VARS_DO_COMENTARIO }),
      NO_MENSAGEM,
      ENVIAR,
      "message-1",
      noop,
    );
    expect(erroDe(r)).toBe("janela_fechada");
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it("conversa do Direct de outra organização não serve", async () => {
    const { admin } = criarBanco(
      tabelasBase({ conversations: [conversaDoDirect({ organization_id: OUTRA_ORG })] }),
    );
    const r = await executarConversa(
      contexto(admin, { vars: VARS_DO_COMENTARIO }),
      NO_MENSAGEM,
      ENVIAR,
      "message-1",
      noop,
    );
    expect(erroDe(r)).toBe("sem_conversa_direct");
  });

  it("conversa do Direct (mesma conexão e IGSID) de OUTRO contato não serve: sem_conversa_direct", async () => {
    const { admin } = criarBanco(
      tabelasBase({ conversations: [conversaDoDirect({ contact_id: "contato-de-outra-pessoa" })] }),
    );
    const r = await executarConversa(
      contexto(admin, { vars: VARS_DO_COMENTARIO }),
      NO_MENSAGEM,
      ENVIAR,
      "message-1",
      noop,
    );
    expect(erroDe(r)).toBe("sem_conversa_direct");
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it("contato bloqueado e teto de 30/h continuam valendo no Direct", async () => {
    const bloqueado = criarBanco(
      tabelasBase({
        conversations: [conversaDoDirect()],
        contacts: [{ id: CONTATO, organization_id: ORG, is_blocked: true, phone_number: null }],
      }),
    );
    expect(
      erroDe(
        await executarConversa(
          contexto(bloqueado.admin, { vars: VARS_DO_COMENTARIO }),
          NO_MENSAGEM,
          ENVIAR,
          "message-1",
          noop,
        ),
      ),
    ).toBe("contato_bloqueado");

    const recentes = Array.from({ length: TETO_DE_MENSAGENS_POR_HORA }, (_, i) => ({
      id: `m${i}`,
      organization_id: ORG,
      contact_id: CONTATO,
      direction: "outbound",
      created_at: new Date(AGORA.getTime() - 60_000).toISOString(),
      metadata: { origem_automacao: { enrollment_id: "enr-x", pointer_id: "ptr-x" } },
    }));
    const cheio = criarBanco(tabelasBase({ conversations: [conversaDoDirect()], messages: recentes }));
    expect(
      erroDe(
        await executarConversa(
          contexto(cheio.admin, { vars: VARS_DO_COMENTARIO }),
          NO_MENSAGEM,
          ENVIAR,
          "message-1",
          noop,
        ),
      ),
    ).toBe("teto_por_hora");
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it("execução que não começou por comentário segue sem o canal do Direct (WhatsApp, sem `canal`)", async () => {
    const { admin } = criarBanco(tabelasBase({ conversations: [conversaDoDirect(), conversa()] }));
    const r = await executarConversa(contexto(admin), NO_MENSAGEM, ENVIAR, "message-1", noop);
    expect(r.desfecho.ok).toBe(true);
    expect((enviarMock.mock.calls[0]![2] as { conversation_id: string }).conversation_id).toBe("conv-1");
    expect(r.detalhes?.[0]).not.toHaveProperty("canal");
  });
});
