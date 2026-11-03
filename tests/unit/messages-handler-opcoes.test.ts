/**
 * Mensagem com opções (botões ou lista) pelo `sendMessageHandler`.
 *
 * Os desfechos que a camada de canal promete ao motor das automações:
 *
 *   1. canal com opções nativas, janela aberta → o envelope leva `interactive`,
 *      a linha guarda o corpo cru e `metadata.interactive.entrega = "nativa"`;
 *   2. canal sem opções nativas → o corpo vira texto numerado ANTES do envio,
 *      e a linha guarda esse texto (o que o contato leu), com `texto_numerado`;
 *   3. janela de 24h fechada → 422 `janela_fechada`, para QUALQUER ator, sem
 *      linha gravada;
 *   4. opções inválidas ou com anexo → 422 `validation_error`, sem linha;
 *   5. `metadata.interactive` do chamador é descartado — só o handler grava.
 *
 * Dublê compartilhado (`tests/helpers/duble-do-handler`), como cobra o gate
 * `send-message-handler-nao-ganha-novo-duble`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler, type SendMessageHandlerInput } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({
          data: { signedUrl: "https://signed.example/a.jpg" },
          error: null,
        }),
      }),
    },
  }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const ENROLLMENT = "66666666-6666-4666-8666-666666666666";

const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** O motor das automações envia como regra (`webhook_source`). */
const ctxAutomacao: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "webhook_source", id: ENROLLMENT },
  requestId: "req-opcoes",
};

function conversa(opts: { provider?: string; lastInboundAt?: string | null } = {}) {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    provider_conversation_id: null,
    last_inbound_at: opts.lastInboundAt === undefined ? null : opts.lastInboundAt,
    contacts: {
      phone_number: "+5531999998888",
      wa_identity: null,
      wa_lid: null,
      is_blocked: false,
    },
    channel_sessions: {
      id: SESSION,
      organization_id: ORG,
      provider: opts.provider ?? "meta_cloud",
      waha_session_name: opts.provider === "waha" ? "default" : null,
      status: "WORKING",
      archived_at: null,
    },
  };
}

const BOTOES = {
  kind: "buttons" as const,
  items: [
    { id: "moradia", label: "Moradia" },
    { id: "investimento", label: "Investimento" },
  ],
};

function comOpcoes(over: Partial<SendMessageHandlerInput> = {}): SendMessageHandlerInput {
  return {
    conversation_id: CONV,
    type: "text",
    body: "Qual o objetivo?",
    interactive: BOTOES,
    ...over,
  };
}

function metaAceita() {
  vi.stubEnv("META_PHONE_NUMBER_ID", "1103328999528818");
  vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok");
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ messages: [{ id: "wamid.OK" }] }),
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("mensagem com opções", () => {
  it("canal nativo, janela aberta: sai type:interactive e a linha guarda as opções como nativas", async () => {
    const spy = metaAceita();
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ lastInboundAt: horasAtras(1) }),
    });

    const msg = await sendMessageHandler(supabase, ctxAutomacao, comOpcoes());

    expect((msg as { status: string }).status).toBe("sent");
    const linha = capturas.inserts.messages![0]!;
    expect(linha.type).toBe("text");
    expect(linha.body).toBe("Qual o objetivo?");
    expect((linha.metadata as Record<string, unknown>).interactive).toEqual({
      ...BOTOES,
      entrega: "nativa",
    });
    expect(linha.sent_via).toBe("automation");

    const enviado = JSON.parse(spy.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(enviado.type).toBe("interactive");
    expect(enviado.interactive).toMatchObject({
      type: "button",
      body: { text: "Qual o objetivo?" },
    });
  });

  it("canal sem opções nativas: o corpo vira texto numerado e é isso que a linha grava", async () => {
    // Sem servidor do canal por QR configurado a mensagem nasce em fila; o que
    // se afirma é a forma do corpo, decidida antes de qualquer transporte.
    vi.stubEnv("WAHA_API_BASE_URL", undefined);
    vi.stubEnv("WAHA_API_KEY", undefined);
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ provider: "waha", lastInboundAt: null }),
    });

    await sendMessageHandler(supabase, ctxAutomacao, comOpcoes());

    const linha = capturas.inserts.messages![0]!;
    expect(linha.body).toBe("Qual o objetivo?\n\n1) Moradia\n2) Investimento");
    expect((linha.metadata as Record<string, unknown>).interactive).toEqual({
      ...BOTOES,
      entrega: "texto_numerado",
    });
  });

  it("janela de 24h fechada: 422 janela_fechada mesmo para automação, e nada é gravado", async () => {
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ lastInboundAt: horasAtras(30) }),
    });

    const erro = await sendMessageHandler(supabase, ctxAutomacao, comOpcoes()).catch((e) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(422);
    expect((erro as ApiError).code).toBe("janela_fechada");
    expect((erro as ApiError).details).toMatchObject({ codigo: "janela_fechada" });
    expect(capturas.inserts.messages).toHaveLength(0);
  });

  it("o mesmo texto SEM opções, pela automação e com a janela fechada, segue o contrato de antes", async () => {
    metaAceita();
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ lastInboundAt: horasAtras(30) }),
    });

    await sendMessageHandler(supabase, ctxAutomacao, comOpcoes({ interactive: undefined }));

    expect(capturas.inserts.messages).toHaveLength(1);
  });

  it.each([
    [
      "4 botões",
      comOpcoes({
        interactive: {
          kind: "buttons",
          items: [1, 2, 3, 4].map((i) => ({ id: `${i}`, label: `${i}` })),
        },
      }),
    ],
    [
      "rótulo longo",
      comOpcoes({ interactive: { kind: "buttons", items: [{ id: "a", label: "x".repeat(21) }] } }),
    ],
    ["sem corpo", comOpcoes({ body: undefined })],
    ["com mídia", comOpcoes({ media_storage_path: `${ORG}/${CONV}/a.jpg`, type: "image" })],
  ])("opções inválidas (%s): 422 validation_error, sem linha", async (_nome, input) => {
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ lastInboundAt: horasAtras(1) }),
    });

    const erro = await sendMessageHandler(supabase, ctxAutomacao, input).catch((e) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).code).toBe("validation_error");
    expect(capturas.inserts.messages).toHaveLength(0);
  });

  it("corpo acima de 1024 caracteres no canal nativo: recusa (a plataforma recusaria)", async () => {
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ lastInboundAt: horasAtras(1) }),
    });

    const erro = await sendMessageHandler(
      supabase,
      ctxAutomacao,
      comOpcoes({ body: "x".repeat(1025) }),
    ).catch((e) => e);

    expect((erro as ApiError).code).toBe("validation_error");
    expect(capturas.inserts.messages).toHaveLength(0);
  });

  it("metadata.interactive vindo do chamador é descartado: só o handler grava opções", async () => {
    metaAceita();
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa({ lastInboundAt: horasAtras(1) }),
    });

    await sendMessageHandler(supabase, ctxAutomacao, {
      conversation_id: CONV,
      type: "text",
      body: "oi",
      metadata: { interactive: { ...BOTOES, entrega: "nativa" }, outra: 1 },
    });

    const meta = capturas.inserts.messages![0]!.metadata as Record<string, unknown>;
    expect(meta).not.toHaveProperty("interactive");
    expect(meta.outra).toBe(1);
  });
});
