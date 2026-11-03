/**
 * Gatilhos do lote 3 no MOTOR: fatos de cada emissor (payloads reais, campo a
 * campo como os emissores gravam), casamento por tipo, palavra-chave, anti-laço
 * e as recusas da mensagem recebida (grupo, saída, resposta a automação).
 */
import { describe, expect, it } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";

import { aplicarGatilhosDeAutomacao, IDADE_MAXIMA_DA_MENSAGEM_MS, type GatilhosDb } from "./gatilhos.handler";
import { esperavaRespostaEm } from "./uma-voz";
import {
  casaGatilho,
  fatosDoEvento,
  mesmaTag,
  palavraChaveCasa,
  varsDoGatilho,
  type FatoDeGatilho,
} from "./gatilhos";
import {
  automacaoTriggerConfigSchema,
  type AutomacaoTrigger,
  type AutomacaoTriggerConfig,
} from "./schemas";

const ORG = "00000000-0000-4000-8000-000000000001";
const MSG = "10000000-0000-4000-8000-000000000001";
const CONV = "20000000-0000-4000-8000-000000000001";
const CONTATO = "30000000-0000-4000-8000-000000000001";
const SESSAO = "40000000-0000-4000-8000-000000000001";
const LEAD = "50000000-0000-4000-8000-000000000001";
const AGENDA = "60000000-0000-4000-8000-000000000001";
const CASO = "70000000-0000-4000-8000-000000000001";

function row(over: Partial<EventRow>): EventRow {
  return {
    id: "ev-1",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: MSG,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...over,
  };
}

/** `fn_emit_message_event` → `fn_log_event`: entity_kind `message`, metadata vazio. */
function mensagem(payload: Record<string, unknown> = {}): EventRow {
  return row({
    payload: {
      message_id: MSG,
      conversation_id: CONV,
      contact_id: CONTATO,
      direction: "inbound",
      type: "text",
      status: "received",
      external_id: "wamid.1",
      channel_session_id: SESSAO,
      body_preview: "Olá, qual o PREÇO?",
      ...payload,
    },
  });
}

const msgGatilho = (
  over: Partial<Extract<AutomacaoTrigger, { kind: "message_received" }>> = {},
): AutomacaoTrigger => ({
  kind: "message_received",
  match: "contains",
  keywords: ["preço"],
  ...over,
});

describe("schemas dos gatilhos novos", () => {
  const cfg = (g: unknown) =>
    automacaoTriggerConfigSchema.safeParse({
      triggers: [g],
      reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
    });
  it("aceita cada kind novo e mantém os do lote 1", () => {
    for (const g of [
      { kind: "manual" },
      { kind: "stage_entered", stage_ids: [LEAD], via: "any" },
      { kind: "message_received", match: "any", keywords: [] },
      {
        kind: "message_received",
        match: "contains",
        keywords: ["oi"],
        channel_session_ids: [SESSAO],
        only_first_message: true,
      },
      { kind: "tag_added", target: "contact", tags: ["VIP"] },
      { kind: "appointment", events: ["created", "no_show"] },
      { kind: "birthday" },
      {
        kind: "date_field",
        field: { scope: "lead_custom", key: "casamento" },
        offset_days: -3,
        time: "09:30",
      },
      { kind: "no_reply", after_minutes: 60, only_if_last_was_outbound: true },
      { kind: "case_opened" },
    ]) {
      expect(cfg(g).success, JSON.stringify(g)).toBe(true);
    }
  });
  it("recusa palavra-chave vazia fora de 'qualquer', tempo fora do limite e hora inválida", () => {
    expect(cfg({ kind: "message_received", match: "contains", keywords: [] }).success).toBe(false);
    expect(
      cfg({ kind: "no_reply", after_minutes: 4, only_if_last_was_outbound: true }).success,
    ).toBe(false);
    expect(
      cfg({
        kind: "date_field",
        field: { scope: "lead", key: "expected_close_date" },
        offset_days: 0,
        time: "24:00",
      }).success,
    ).toBe(false);
    expect(
      cfg({
        kind: "date_field",
        field: { scope: "lead", key: "title" },
        offset_days: 0,
        time: "09:00",
      }).success,
    ).toBe(false);
    expect(cfg({ kind: "appointment", events: [] }).success).toBe(false);
  });
});

describe("palavra-chave", () => {
  it("sem acento e sem maiúsculas, por palavra ou frase inteira", () => {
    expect(palavraChaveCasa("contains", ["preço"], "Olá, qual o PRECO?")).toBe(true);
    expect(palavraChaveCasa("contains", ["oi"], "faltam oito dias")).toBe(false);
    expect(palavraChaveCasa("contains", ["quero comprar"], "Oi! Quero comprar, por favor")).toBe(
      true,
    );
    expect(palavraChaveCasa("equals", ["sim"], "  Sim! ")).toBe(true);
    expect(palavraChaveCasa("equals", ["sim"], "sim, quero")).toBe(false);
    expect(palavraChaveCasa("starts_with", ["oi"], "Oi, tudo bem?")).toBe(true);
    expect(palavraChaveCasa("starts_with", ["oi"], "oitava série")).toBe(false);
    expect(palavraChaveCasa("any", [], "")).toBe(true);
    expect(palavraChaveCasa("contains", ["preço", "valor"], "qual o valor")).toBe(true);
  });
});

describe("fatos de cada emissor", () => {
  it("mensagem recebida: texto até 280, canal e conversa", () => {
    const [f] = fatosDoEvento(mensagem({ body_preview: "x".repeat(300) }));
    expect(f).toMatchObject({
      tipo: "message_received",
      message_id: MSG,
      conversation_id: CONV,
      contact_id: CONTATO,
      channel_session_id: SESSAO,
    });
    expect(f!.tipo === "message_received" && f!.texto.length).toBe(280);
  });
  it("saída, eco do envio, reação e tipo não suportado não são mensagem recebida", () => {
    expect(fatosDoEvento(mensagem({ direction: "outbound" }))).toEqual([]);
    expect(fatosDoEvento(mensagem({ type: "reaction" }))).toEqual([]);
    expect(
      fatosDoEvento(mensagem({ body_preview: "[tipo de mensagem não suportado: sticker]" })),
    ).toEqual([]);
  });
  it("tag do negócio (leads/_handler) e do contato (contacts/_handler e o gatilho do banco)", () => {
    const [l] = fatosDoEvento(
      row({
        event_type: "lead.tag_added",
        entity_kind: "crm_lead",
        entity_id: LEAD,
        payload: { added_tags: ["Quente"], tags: ["A", "Quente"], service_origin: null },
        metadata: { request_id: "req-1" },
      }),
    );
    expect(l).toMatchObject({ tipo: "tag_added", alvo: "lead", lead_id: LEAD, tags: ["Quente"] });
    const [c] = fatosDoEvento(
      row({
        event_type: "contact.tag_added",
        entity_kind: "contact",
        entity_id: CONTATO,
        payload: { added_tags: ["cliente"], tags: ["cliente"] },
        metadata: { actor_type: "system", actor_id: "trg_agendamento_marca_cliente" },
      }),
    );
    expect(c).toMatchObject({ tipo: "tag_added", alvo: "contact", contact_id: CONTATO });
  });
  it("agendamento (payloadDoAviso), aniversário (cron) e caso aberto (trigger 0148)", () => {
    const [a] = fatosDoEvento(
      row({
        event_type: "appointment.no_show",
        entity_kind: "calendar_appointment",
        entity_id: AGENDA,
        payload: {
          appointment_id: AGENDA,
          contact_id: CONTATO,
          event_type_name: "Consulta",
          time_zone: "America/Sao_Paulo",
          transicao: "no_show",
          inicio: "2026-11-04T13:00:00.000Z",
          fim: "2026-11-04T14:00:00.000Z",
          situacao: "no_show",
          tipo: { slug: "consulta", nome: "Consulta" },
          local: { tipo: null },
          lead_ids: [LEAD],
        },
      }),
    );
    expect(a).toMatchObject({
      tipo: "appointment",
      evento: "no_show",
      appointment_id: AGENDA,
      lead_id: LEAD,
      nome_do_tipo: "Consulta",
    });
    const [b] = fatosDoEvento(
      row({
        event_type: "contact.birthday",
        entity_kind: "contact",
        entity_id: CONTATO,
        payload: { local_date: "2026-11-03" },
        metadata: { actor_kind: "system" },
      }),
    );
    expect(b).toMatchObject({ tipo: "birthday", contact_id: CONTATO, data: "2026-11-03" });
    const [k] = fatosDoEvento(
      row({
        event_type: "ai.case_opened",
        entity_kind: "agent_case",
        entity_id: CASO,
        payload: {
          case_id: CASO,
          conversation_id: CONV,
          contact_id: CONTATO,
          lead_id: null,
          agent_id: null,
          source: "agent",
          status: "open",
        },
      }),
    );
    expect(k).toMatchObject({ tipo: "case_opened", case_id: CASO, conversation_id: CONV });
  });
  it("evento causado por REGRA antiga não inicia automação (caused_by_rule e request_id rule:)", () => {
    expect(
      fatosDoEvento(
        row({
          event_type: "lead.tag_added",
          entity_kind: "crm_lead",
          entity_id: LEAD,
          payload: { added_tags: ["x"] },
          metadata: { caused_by_rule: "r1" },
        }),
      ),
    ).toEqual([]);
    expect(
      fatosDoEvento(
        row({
          event_type: "lead.created",
          entity_kind: "crm_lead",
          entity_id: LEAD,
          payload: {},
          metadata: { request_id: "rule:r1:abc" },
        }),
      ),
    ).toEqual([]);
  });
});

describe("casaGatilho por kind", () => {
  const f = (r: EventRow): FatoDeGatilho => fatosDoEvento(r)[0]!;
  it("mensagem: palavra-chave, canal e primeira mensagem", () => {
    const m = f(mensagem());
    expect(casaGatilho(msgGatilho(), m, false)).toBe(true);
    expect(casaGatilho(msgGatilho({ keywords: ["boleto"] }), m, false)).toBe(false);
    expect(casaGatilho(msgGatilho({ channel_session_ids: [LEAD] }), m, false)).toBe(false);
    expect(casaGatilho(msgGatilho({ only_first_message: true }), m, false)).toBe(false);
    expect(
      casaGatilho(
        msgGatilho({ only_first_message: true }),
        { ...m, primeira_da_conversa: true } as FatoDeGatilho,
        false,
      ),
    ).toBe(true);
  });
  it("tag: alvo certo e tag sem distinguir maiúsculas; agendamento pelo evento; os outros só pelo próprio fato", () => {
    const t = f(
      row({
        event_type: "lead.tag_added",
        entity_kind: "crm_lead",
        entity_id: LEAD,
        payload: { added_tags: ["Quente"] },
      }),
    );
    expect(casaGatilho({ kind: "tag_added", target: "lead", tags: ["quente"] }, t, false)).toBe(
      true,
    );
    expect(casaGatilho({ kind: "tag_added", target: "contact", tags: ["quente"] }, t, false)).toBe(
      false,
    );
    expect(casaGatilho({ kind: "tag_added", target: "lead", tags: ["frio"] }, t, false)).toBe(
      false,
    );
    const a = f(
      row({
        event_type: "appointment.created",
        entity_kind: "calendar_appointment",
        entity_id: AGENDA,
        payload: {},
      }),
    );
    expect(casaGatilho({ kind: "appointment", events: ["created"] }, a, false)).toBe(true);
    expect(casaGatilho({ kind: "appointment", events: ["cancelled"] }, a, false)).toBe(false);
    expect(casaGatilho({ kind: "birthday" }, a, false)).toBe(false);
    expect(casaGatilho({ kind: "case_opened" }, t, false)).toBe(false);
    expect(
      casaGatilho(
        { kind: "no_reply", after_minutes: 60, only_if_last_was_outbound: true },
        t,
        false,
      ),
    ).toBe(false);
  });
  it("vars do gatilho de mensagem guardam o texto e a conversa", () => {
    expect(varsDoGatilho(f(mensagem()), "ev-1")).toEqual({
      gatilho: {
        tipo: "message_received",
        message_id: MSG,
        conversation_id: CONV,
        channel_session_id: SESSAO,
        texto: "Olá, qual o PREÇO?",
        event_id: "ev-1",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Handler: as recusas que dependem do banco, com um banco falso
// ---------------------------------------------------------------------------

function config(...triggers: AutomacaoTrigger[]): AutomacaoTriggerConfig {
  return { triggers, reentry: { policy: "skip_if_running", cooldown_minutes: 0 } };
}

function db(cfg: AutomacaoTriggerConfig, over: Partial<GatilhosDb> = {}) {
  const iniciadas: Array<Parameters<GatilhosDb["iniciar"]>[0]> = [];
  const fake: GatilhosDb = {
    automacoesAtivas: async () => [{ id: "ptr-1", active_version_id: "v1" }],
    gatilhosDaVersao: async () => cfg,
    contatoDoNegocio: async () => CONTATO,
    contatoDoAgendamento: async () => CONTATO,
    contatoDaConversa: async () => CONTATO,
    conversaDeGrupo: async () => false,
    mensagemDaConversa: async () => ({ created_at: new Date().toISOString() }),
    respostaAAutomacaoNaConversa: async () => false,
    primeiraMensagemDaConversa: async () => true,
    humanoNaConversa: async () => false,
    fonteDeCaptacaoDaOrg: async () => false,
    iniciar: async (input) => {
      iniciadas.push(input);
      return { resultado: "iniciada", enrollment_id: "enr-1" };
    },
    modoLeitura: async () => false,
    ...over,
  };
  return { fake, iniciadas };
}

describe("handler das automações", () => {
  it("mensagem que casa inicia com o contato do evento e a origem = linha do evento", async () => {
    const d = db(config(msgGatilho()));
    const r = await aplicarGatilhosDeAutomacao(d.fake, mensagem());
    expect(r.iniciadas).toBe(1);
    expect(d.iniciadas[0]).toMatchObject({
      contactId: CONTATO,
      originEventId: "ev-1",
      pointerId: "ptr-1",
    });
  });
  it("grupo, conversa de outra organização e resposta a automação em espera não disparam", async () => {
    for (const over of [
      { conversaDeGrupo: async () => true },
      { conversaDeGrupo: async () => null },
      { respostaAAutomacaoNaConversa: async () => true },
    ] satisfies Array<Partial<GatilhosDb>>) {
      const d = db(config(msgGatilho()), over);
      expect((await aplicarGatilhosDeAutomacao(d.fake, mensagem())).iniciadas).toBe(0);
      expect(d.iniciadas).toEqual([]);
    }
  });
  it("só a primeira mensagem: segunda mensagem da conversa não dispara", async () => {
    const d = db(config(msgGatilho({ only_first_message: true })), {
      primeiraMensagemDaConversa: async () => false,
    });
    expect((await aplicarGatilhosDeAutomacao(d.fake, mensagem())).iniciadas).toBe(0);
  });
  it("tag adicionada pela PRÓPRIA automação não a reinicia; por outra, sim (com a execução-mãe)", async () => {
    const tag = (rid: string) =>
      row({
        event_type: "lead.tag_added",
        entity_kind: "crm_lead",
        entity_id: LEAD,
        payload: { added_tags: ["Quente"] },
        metadata: { request_id: rid },
      });
    const g: AutomacaoTrigger = { kind: "tag_added", target: "lead", tags: ["Quente"] };
    const propria = db(config(g));
    await aplicarGatilhosDeAutomacao(
      propria.fake,
      tag("automacao:ptr-1:80000000-0000-4000-8000-000000000001:n1:1"),
    );
    expect(propria.iniciadas).toEqual([]);
    const outra = db(config(g));
    await aplicarGatilhosDeAutomacao(
      outra.fake,
      tag("automacao:ptr-9:80000000-0000-4000-8000-000000000001:n1:1"),
    );
    expect(outra.iniciadas[0]).toMatchObject({
      parentEnrollmentId: "80000000-0000-4000-8000-000000000001",
    });
  });
  it("agendamento lê o contato da linha do compromisso, não do payload", async () => {
    const d = db(config({ kind: "appointment", events: ["confirmed"] }), {
      contatoDoAgendamento: async () => "da-linha",
    });
    await aplicarGatilhosDeAutomacao(
      d.fake,
      row({
        event_type: "appointment.confirmed",
        entity_kind: "calendar_appointment",
        entity_id: AGENDA,
        payload: { contact_id: "do-payload" },
      }),
    );
    expect(d.iniciadas[0]?.contactId).toBe("da-linha");
  });
});

// ---------------------------------------------------------------------------
// Correções da revisão (itens 2, 3, 6, 7, 8, 10)
// ---------------------------------------------------------------------------

describe("ação em massa não dispara automação (item 3)", () => {
  it("tag em lote (`via: bulk`) não vira fato; a mesma tag por um caminho comum vira", () => {
    const tag = (metadata: Record<string, unknown>) =>
      row({
        event_type: "lead.tag_added",
        entity_kind: "crm_lead",
        entity_id: LEAD,
        payload: { added_tags: ["Quente"] },
        metadata,
      });
    expect(fatosDoEvento(tag({ request_id: "r", actor_user_id: "u", via: "bulk" }))).toEqual([]);
    expect(fatosDoEvento(tag({ request_id: "r", actor_user_id: "u" }))).toHaveLength(1);
  });
  it("o handler não inicia nada para a tag em lote", async () => {
    const d = db(config({ kind: "tag_added", target: "lead", tags: ["Quente"] }));
    await aplicarGatilhosDeAutomacao(
      d.fake,
      row({
        event_type: "lead.tag_added",
        entity_kind: "crm_lead",
        entity_id: LEAD,
        payload: { added_tags: ["Quente"] },
        metadata: { via: "bulk" },
      }),
    );
    expect(d.iniciadas).toEqual([]);
  });
});

describe("só a primeira mensagem considera só as ANTERIORES (item 2)", () => {
  it("o handler pergunta pelas mensagens anteriores ao instante em que esta chegou", async () => {
    const chegou = new Date(Date.now() - 30_000).toISOString();
    const perguntas: string[] = [];
    const d = db(config(msgGatilho({ only_first_message: true })), {
      mensagemDaConversa: async () => ({ created_at: chegou }),
      primeiraMensagemDaConversa: async (_o, _c, _m, antesDe) => {
        perguntas.push(antesDe);
        return true;
      },
    });
    expect((await aplicarGatilhosDeAutomacao(d.fake, mensagem())).iniciadas).toBe(1);
    expect(perguntas).toEqual([chegou]);
  });
});

describe("não dispara com humano no comando (item 6)", () => {
  it("padrão (ausente = sim): conversa com atendente não dispara; sem atendente, dispara", async () => {
    const com = db(config(msgGatilho()), { humanoNaConversa: async () => true });
    expect((await aplicarGatilhosDeAutomacao(com.fake, mensagem())).iniciadas).toBe(0);
    const sem = db(config(msgGatilho()), { humanoNaConversa: async () => false });
    expect((await aplicarGatilhosDeAutomacao(sem.fake, mensagem())).iniciadas).toBe(1);
  });
  it("skip_if_human: false dispara mesmo com humano no comando", async () => {
    const d = db(config(msgGatilho({ skip_if_human: false })), { humanoNaConversa: async () => true });
    expect((await aplicarGatilhosDeAutomacao(d.fake, mensagem())).iniciadas).toBe(1);
  });
  it("o schema aceita a opção", () => {
    expect(
      automacaoTriggerConfigSchema.safeParse({
        triggers: [{ kind: "message_received", match: "any", keywords: [], skip_if_human: false }],
        reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
      }).success,
    ).toBe(true);
  });
});

describe("resposta a automação decidida pela MENSAGEM (item 7)", () => {
  const T = "2026-11-03T12:05:00.000Z";
  const ev = (event_type: string, created_at: string, payload: Record<string, unknown> | null = null) => ({
    event_type,
    created_at,
    payload,
  });
  it("esperava quando a mensagem chegou: wait_started antes, saída da espera depois", () => {
    expect(
      esperavaRespostaEm(
        [
          ev("effect_done", "2026-11-03T12:00:00.000Z"),
          ev("wait_started", "2026-11-03T12:00:01.000Z", { wake_status: "waiting_reply" }),
          ev("inbound_woke", "2026-11-03T12:05:01.000Z"),
          ev("node_advanced", "2026-11-03T12:06:00.000Z"),
        ],
        T,
      ),
    ).toBe(true);
  });
  it("a espera já tinha saído antes da mensagem, ou era espera de tempo: não é resposta", () => {
    expect(
      esperavaRespostaEm(
        [
          ev("wait_started", "2026-11-03T12:00:01.000Z", { wake_status: "waiting_reply" }),
          ev("node_advanced", "2026-11-03T12:03:00.000Z"),
        ],
        T,
      ),
    ).toBe(false);
    expect(esperavaRespostaEm([ev("wait_started", "2026-11-03T12:00:01.000Z", {})], T)).toBe(false);
    expect(
      esperavaRespostaEm([ev("wait_started", "2026-11-03T12:06:00.000Z", { wake_status: "waiting_reply" })], T),
    ).toBe(false);
  });
  it("o handler passa o instante da chegada e descarta a resposta", async () => {
    const chegou = new Date(Date.now() - 5_000).toISOString();
    const vistos: string[] = [];
    const d = db(config(msgGatilho()), {
      mensagemDaConversa: async () => ({ created_at: chegou }),
      respostaAAutomacaoNaConversa: async (_o, _c, em) => {
        vistos.push(em);
        return true;
      },
    });
    expect((await aplicarGatilhosDeAutomacao(d.fake, mensagem())).iniciadas).toBe(0);
    expect(vistos).toEqual([chegou]);
  });
});

describe("mensagem velha não dispara (item 8)", () => {
  it("mais de 10 minutos desde que chegou: descartada; mensagem que não é da conversa também", async () => {
    const agora = new Date("2026-11-03T12:30:00.000Z");
    const velha = db(config(msgGatilho()), {
      mensagemDaConversa: async () => ({
        created_at: new Date(agora.getTime() - IDADE_MAXIMA_DA_MENSAGEM_MS - 1000).toISOString(),
      }),
    });
    expect((await aplicarGatilhosDeAutomacao(velha.fake, mensagem(), agora)).iniciadas).toBe(0);
    const nova = db(config(msgGatilho()), {
      mensagemDaConversa: async () => ({ created_at: new Date(agora.getTime() - 60_000).toISOString() }),
    });
    expect((await aplicarGatilhosDeAutomacao(nova.fake, mensagem(), agora)).iniciadas).toBe(1);
    const alheia = db(config(msgGatilho()), { mensagemDaConversa: async () => null });
    expect((await aplicarGatilhosDeAutomacao(alheia.fake, mensagem(), agora)).iniciadas).toBe(0);
  });
});

describe("palavra-chave vazia e tag (item 10)", () => {
  const cfg = (g: unknown) =>
    automacaoTriggerConfigSchema.safeParse({
      triggers: [g],
      reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
    });
  it("o schema recusa palavra-chave que normaliza para vazio, com mensagem legível", () => {
    const r = cfg({ kind: "message_received", match: "contains", keywords: ["!!!"] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("ao menos uma letra ou número");
    expect(cfg({ kind: "message_received", match: "contains", keywords: ["preço!"] }).success).toBe(true);
  });
  it("tag compara por trim e minúsculas, não pela normalização da palavra-chave", () => {
    expect(mesmaTag("  VIP ", "vip")).toBe(true);
    expect(mesmaTag("pós-venda", "pos venda")).toBe(false);
    expect(mesmaTag("Pós-venda", "pós-venda")).toBe(true);
  });
});
