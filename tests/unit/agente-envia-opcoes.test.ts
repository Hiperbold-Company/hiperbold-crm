/**
 * BOTÕES E LISTA NA MENSAGEM DO AGENTE (`send_message` com `opcoes`).
 *
 * As quatro pontas da cadeia, cada uma medida no seu código real:
 *
 *  1. o argumento do modelo vira `OutboundInteractive`, e limite estourado é
 *     recusado (`interactiveDasOpcoesDoAgente`);
 *  2. a mensagem do turno chega ao handler de envio com as opções
 *     (`corpoDoEnvio`), e o handler as DESENHA no canal oficial e as NUMERA no
 *     canal sem botões — `sendMessageHandler` de verdade, sobre o dublê
 *     compartilhado do handler;
 *  3. a cadeia de guardrails lê os títulos (o texto avaliado é o corpo com as
 *     opções numeradas) e o envio continua DENTRO do `runBeforeSend`;
 *  4. a resposta — toque no botão ou número digitado — chega ao modelo como o
 *     título escolhido (`fitToBudget` + abertura do turno).
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 * - `body: corpoParaACadeia` → `body` no `beforeSendArgs`: o caso estrutural da
 *   cadeia cai (os títulos deixariam de passar pelos gates).
 * - Tirar o repasse de `interactive` em `corpoDoEnvio`: os casos do handler caem.
 * - Tirar `opcao_escolhida` do `fitToBudget`: os casos da resposta caem.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { buildOpeningMessage } from "@/lib/agent-engine/agent/inbound-turn";
import { interactiveDasOpcoesDoAgente } from "@/lib/agent-engine/agent/opcoes-da-mensagem";
import { corpoDoEnvio } from "@/lib/agent-engine/edge/crm/send-message";
import { __test_fitToBudget, type LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { internalVocabularyGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { textoComOpcoesNumeradas } from "@/lib/channels/opcoes-numeradas";
import type { OutboundInteractive } from "@/lib/channels/types";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";

const BOTOES = { formato: "botoes", itens: [{ titulo: "Moradia" }, { titulo: "Investimento" }] };

function converter(bruto: unknown): OutboundInteractive {
  const r = interactiveDasOpcoesDoAgente(bruto);
  if (!r.ok) throw new Error(r.mensagem);
  return r.interactive;
}

describe("1. o argumento do modelo", () => {
  it("botões viram `buttons` com ids gerados pelo servidor", () => {
    expect(converter(BOTOES)).toEqual({
      kind: "buttons",
      items: [
        { id: "opcao_1", label: "Moradia" },
        { id: "opcao_2", label: "Investimento" },
      ],
    });
  });

  it("lista vira `list` com o texto do botão e as descrições", () => {
    expect(
      converter({ formato: "lista", texto_do_botao: "Ver bairros", itens: [{ titulo: "Centro", descricao: "até 2 quartos" }] }),
    ).toEqual({ kind: "list", button_label: "Ver bairros", items: [{ id: "opcao_1", label: "Centro", description: "até 2 quartos" }] });
  });

  it.each([
    ["4 botões", { formato: "botoes", itens: [1, 2, 3, 4].map((n) => ({ titulo: `Op ${n}` })) }],
    ["botão com 21 caracteres", { formato: "botoes", itens: [{ titulo: "x".repeat(21) }] }],
    ["botão com descrição", { formato: "botoes", itens: [{ titulo: "A", descricao: "d" }] }],
    ["lista com 11 itens", { formato: "lista", texto_do_botao: "Ver", itens: Array.from({ length: 11 }, (_, n) => ({ titulo: `Item ${n}` })) }],
    ["lista sem texto do botão", { formato: "lista", itens: [{ titulo: "A" }] }],
    ["título de lista com 25 caracteres", { formato: "lista", texto_do_botao: "Ver", itens: [{ titulo: "x".repeat(25) }] }],
    ["títulos repetidos (sem acento/caixa)", { formato: "botoes", itens: [{ titulo: "Sim" }, { titulo: "SIM" }] }],
    ["formato desconhecido", { formato: "carrossel", itens: [{ titulo: "A" }] }],
    ["sem itens", { formato: "botoes", itens: [] }],
  ])("recusa %s com erro de ensino", (_nome, bruto) => {
    const r = interactiveDasOpcoesDoAgente(bruto);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensagem).toMatch(/^opcoes inválidas/);
  });
});

describe("2. do turno ao canal", () => {
  const base = { tenantId: ORG, leadId: CONTACT, jobId: "job", seq: 1, conversationId: CONV };
  const ctxDoAgente: HandlerCtx = {
    organization_id: ORG,
    actor: { type: "ai_agent", id: "agent-engine", role: "manager" },
    requestId: "req-agente",
  };
  const conversa = (provider: string) => ({
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    provider_conversation_id: null,
    last_inbound_at: new Date(Date.now() - 3_600_000).toISOString(),
    contacts: { phone_number: "+5531999998888", wa_identity: null, wa_lid: null, is_blocked: false },
    channel_sessions: {
      id: SESSION,
      organization_id: ORG,
      provider,
      waha_session_name: provider === "waha" ? "default" : null,
      status: "WORKING",
      archived_at: null,
    },
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("corpoDoEnvio leva as opções no texto e não na mídia", () => {
    const interactive = converter(BOTOES);
    expect(corpoDoEnvio({ ...base, body: "Qual o objetivo?", interactive }, "k")).toMatchObject({
      type: "text",
      body: "Qual o objetivo?",
      interactive,
    });
    expect(
      corpoDoEnvio({ ...base, body: "legenda", media: { storagePath: "p.jpg", mime: "image/jpeg" }, interactive }, "k"),
    ).not.toHaveProperty("interactive");
  });

  it("canal oficial: sai `interactive` com os botões", async () => {
    vi.stubEnv("META_PHONE_NUMBER_ID", "1103328999528818");
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok");
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.OK" }] }) });
    vi.stubGlobal("fetch", spy);
    const { supabase, capturas } = criarDubleDoHandler({ conversation: conversa("meta_cloud") });

    await sendMessageHandler(supabase, ctxDoAgente, corpoDoEnvio({ ...base, body: "Qual o objetivo?", interactive: converter(BOTOES) }, "k"));

    const enviado = JSON.parse(spy.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(enviado.type).toBe("interactive");
    expect(JSON.stringify(enviado.interactive)).toContain("Investimento");
    expect((capturas.inserts.messages![0]!.metadata as Record<string, unknown>).interactive).toMatchObject({ entrega: "nativa" });
  });

  it("canal sem botões: a linha grava o texto numerado", async () => {
    // O canal por QR passou a desenhar opções (enquete); o canal intermediado
    // segue sem elas (`interactive: "none"`). O que se afirma é a forma do
    // corpo, decidida antes do transporte — o envio em si pode falhar aqui.
    const { supabase, capturas } = criarDubleDoHandler({ conversation: conversa("zernio") });

    await sendMessageHandler(supabase, ctxDoAgente, corpoDoEnvio({ ...base, body: "Qual o objetivo?", interactive: converter(BOTOES) }, "k")).catch(() => undefined);

    const linha = capturas.inserts.messages![0]!;
    expect(linha.body).toBe("Qual o objetivo?\n\n1) Moradia\n2) Investimento");
    expect((linha.metadata as Record<string, unknown>).interactive).toMatchObject({ entrega: "texto_numerado" });
  });
});

describe("3. a cadeia de guardrails continua no caminho", () => {
  const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("o texto avaliado pela cadeia é o corpo COM as opções, e o envio com opções mora dentro do `send` da cadeia", () => {
    expect(turno).toMatch(/channelSessionId: input\.channelSessionId,\n\s+body: corpoParaACadeia,/);
    // O `send` com opções SUBSTITUI o `send` dos args que a cadeia recebe: quem
    // o chama é o `runBeforeSend`, depois dos gates — nunca um envio por fora.
    const argsDaCadeia = turno.indexOf("const beforeSendArgs = {");
    const envioComOpcoes = turno.indexOf("beforeSendArgs.send = (finalBody: string) => {");
    const cadeia = turno.indexOf("let chain = await runBeforeSend(beforeSendArgs);");
    expect(argsDaCadeia).toBeGreaterThan(0);
    expect(envioComOpcoes).toBeGreaterThan(argsDaCadeia);
    expect(envioComOpcoes).toBeLessThan(cadeia);
    expect(turno.slice(envioComOpcoes, cadeia)).toContain("interactive: opcoesDaMensagem");
  });

  it("um título com vocabulário interno é vetado pelo gate, como o corpo", () => {
    const ctx: GateContext = {
      now: new Date("2026-08-04T12:00:00Z"),
      body: textoComOpcoesNumeradas("Qual prefere?", converter({ formato: "botoes", itens: [{ titulo: "Sim" }, { titulo: "crm_list_leads" }] })),
      optedOut: false,
      provider: "waha",
      pacing: { knobs: PACING_DEFAULTS, state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null }, crmDailyLimit: null },
      spinning: { knobs: SPINNING_DEFAULTS, window: [] },
      promise: { table: null },
      semanticPromise: null,
      disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
      lgpd: null,
      casesEnabled: false,
      hasOpenCase: false,
      openedCaseThisTurn: false,
      internalVocabularyEnforced: true,
    };
    expect(internalVocabularyGate.evaluate(ctx).pass).toBe(false);
  });
});

describe("4. a resposta chega ao modelo como a opção escolhida", () => {
  const base = { lead_id: "l1", contact: { name: "x", phone: null, email: null, tags: [], is_blocked: false }, conversation_id: "c1", last_human_decision: null };
  const linha = (direction: "inbound" | "outbound", body: string, metadata: Record<string, unknown> | null, minuto: number) => ({
    direction, type: "text", body, media_url: null, media_storage_path: null, media_mime: null,
    media_derived_text: null, sent_at: new Date(`2026-11-24T10:${String(minuto).padStart(2, "0")}:00Z`), metadata,
  });
  const interactive = converter(BOTOES);

  it("toque no botão (canal oficial): título + id da resposta", () => {
    const ctx = __test_fitToBudget(base, [
      linha("outbound", "Qual o objetivo?", { interactive: { ...interactive, entrega: "nativa" } }, 1),
      linha("inbound", "Investimento", { reply: { id: "opcao_2", title: "Investimento", kind: "button_reply" } }, 2),
    ] as never, 100000, "UTC");
    expect(ctx.messages[0]!.opcoes_oferecidas).toEqual(["Moradia", "Investimento"]);
    expect(ctx.messages[1]!.opcao_escolhida).toBe("Investimento");
    expect(ctx.messages[1]!.body).toBe("Investimento");
  });

  it("número digitado (canal sem botões): '1' vira o título, e o corpo cru fica", () => {
    const ctx = __test_fitToBudget(base, [
      linha("outbound", "Qual o objetivo?\n\n1) Moradia\n2) Investimento", { interactive: { ...interactive, entrega: "texto_numerado" } }, 1),
      linha("inbound", "1", null, 2),
    ] as never, 100000, "UTC");
    expect(ctx.messages[0]!.opcoes_oferecidas).toBeUndefined();
    expect(ctx.messages[1]!.opcao_escolhida).toBe("Moradia");
    expect(ctx.messages[1]!.body).toBe("1");
  });

  it("texto livre não casa, e depois de outra mensagem nossa as opções não valem mais", () => {
    const ctx = __test_fitToBudget(base, [
      linha("outbound", "Qual o objetivo?", { interactive: { ...interactive, entrega: "nativa" } }, 1),
      linha("inbound", "não sei ainda", null, 2),
      linha("outbound", "Tudo bem!", null, 3),
      linha("inbound", "2", null, 4),
    ] as never, 100000, "UTC");
    expect(ctx.messages[1]!.opcao_escolhida).toBeUndefined();
    expect(ctx.messages[3]!.opcao_escolhida).toBeUndefined();
  });

  it("a abertura do turno entrega a opção escolhida junto da mensagem atual", () => {
    const contexto: LeadContext = {
      ...base,
      messages: [
        { direction: "outbound", body: "Qual o objetivo?", opcoes_oferecidas: ["Moradia", "Investimento"], sent_at: "2026-11-24T10:01:00Z" },
        { direction: "inbound", body: "2", opcao_escolhida: "Investimento", sent_at: "2026-11-24T10:02:00Z" },
      ],
    } as LeadContext;
    const abertura = buildOpeningMessage({ commitments: [], objections: [], next_action: null, rolling_summary: "" } as never, null, contexto, "sem notas");
    expect(abertura).toContain('"opcao_escolhida":"Investimento"');
  });
});
