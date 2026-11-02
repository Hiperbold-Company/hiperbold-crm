import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Resposta de botão e de lista pelo canal oficial (WhatsApp Cloud API).
 *
 * Quando o cliente toca num botão de template, a Meta manda `type: "button"`;
 * quando responde a uma mensagem interativa, `type: "interactive"`. O parser
 * passava o tipo cru, o texto ficava nulo, e o CHECK `messages_type_check`
 * recusava o insert: a resposta do cliente se perdia. Formatos tirados da
 * referência de webhooks da Meta (messages: button, interactive).
 *
 * A régua é o PRÓPRIO banco: o vocabulário do CHECK é lido da última definição
 * dele no `baseline.sql`, não de uma lista copiada neste teste.
 */

const estado = vi.hoisted(() => ({
  insert: null as Record<string, unknown> | null,
  marcacoes: [] as Array<Record<string, unknown>>,
  posEntrada: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => false,
  registrarMensagemIgnorada: async () => undefined,
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: async (_a: unknown, args: Record<string, unknown>) => {
    estado.marcacoes.push(args);
  },
}));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: async (_a: unknown, args: Record<string, unknown>) => {
    estado.posEntrada.push(args);
  },
}));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({
  pausarIaPorAtendimentoManual: async () => true,
}));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

import { ingestMetaEcho, ingestMetaInbound } from "@/lib/channels/meta/ingest";
import {
  parseMetaWebhook,
  type InboundMessageEvent,
  type OutboundEchoEvent,
} from "@/lib/channels/meta/webhook";

/** Vocabulário que o banco aceita em `messages.type` — última definição do CHECK. */
function vocabularioDoCheck(): Set<string> {
  const sql = readFileSync("supabase/baseline.sql", "utf8");
  const i = sql.lastIndexOf("add constraint messages_type_check");
  expect(i).toBeGreaterThan(0);
  const bloco = sql.slice(i, sql.indexOf("]))", i));
  const semComentario = bloco.replace(/--.*$/gm, "");
  return new Set([...semComentario.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));
}
const ACEITOS = vocabularioDoCheck();

function envelope(field: "messages" | "smb_message_echoes", msg: Record<string, unknown>) {
  const base = { id: "wamid.X", timestamp: "1793620800", ...msg };
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field,
            value:
              field === "messages"
                ? {
                    messaging_product: "whatsapp",
                    metadata: { display_phone_number: "553591485627", phone_number_id: "phone-1" },
                    contacts: [{ profile: { name: "Cliente" }, wa_id: "5531991110001" }],
                    messages: [{ from: "5531991110001", ...base }],
                  }
                : {
                    messaging_product: "whatsapp",
                    metadata: { display_phone_number: "553591485627", phone_number_id: "phone-1" },
                    message_echoes: [{ from: "553591485627", to: "5531991110001", ...base }],
                  },
          },
        ],
      },
    ],
  } as Parameters<typeof parseMetaWebhook>[0];
}

const recebida = (msg: Record<string, unknown>) =>
  parseMetaWebhook(envelope("messages", msg)).find(
    (e): e is InboundMessageEvent => e.kind === "inbound_message",
  )!;
const eco = (msg: Record<string, unknown>) =>
  parseMetaWebhook(envelope("smb_message_echoes", msg)).find(
    (e): e is OutboundEchoEvent => e.kind === "outbound_echo",
  )!;

const BOTAO_DE_TEMPLATE = {
  type: "button",
  context: { from: "553591485627", id: "wamid.TEMPLATE" },
  button: { payload: "CONFIRMAR_CONSULTA", text: "Confirmar" },
};
const BOTAO_INTERATIVO = {
  type: "interactive",
  interactive: { type: "button_reply", button_reply: { id: "sim-1", title: "Sim, quero" } },
};
const ITEM_DE_LISTA = {
  type: "interactive",
  interactive: {
    type: "list_reply",
    list_reply: { id: "plano-anual", title: "Plano anual", description: "12 meses" },
  },
};
const PEDIDO = { type: "order", order: { catalog_id: "cat-1", product_items: [] } };
const NAO_SUPORTADO = {
  type: "unsupported",
  errors: [{ code: 131051, title: "Message type unknown" }],
};

function adminFalso(): SupabaseClient {
  const from = (table: string) => {
    if (table === "channel_sessions") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: { id: "session-1", organization_id: "org-1" }, error: null }),
      };
      return chain;
    }
    if (table === "messages") {
      return {
        insert: (payload: Record<string, unknown>) => {
          estado.insert = payload;
          // O CHECK do banco, de verdade: tipo fora do vocabulário é recusado.
          const erro = ACEITOS.has(String(payload.type))
            ? null
            : { code: "23514", message: 'violates check constraint "messages_type_check"' };
          return {
            select: () => ({
              maybeSingle: async () => ({ data: erro ? null : { id: "message-1" }, error: erro }),
            }),
          };
        },
      };
    }
    throw new Error(`tabela inesperada: ${table}`);
  };
  const rpc = async (name: string) => {
    if (name === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
    if (name === "fn_upsert_wa_conversation") return { data: "conversation-1", error: null };
    return { data: null, error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

beforeEach(() => {
  estado.insert = null;
  estado.marcacoes = [];
  estado.posEntrada = [];
});

describe("parser: resposta de botão e de lista vira texto com a opção escolhida", () => {
  it("botão de template: texto = rótulo do botão, payload guardado em `reply`", () => {
    const e = recebida(BOTAO_DE_TEMPLATE);
    expect(e.type).toBe("text");
    expect(e.text).toBe("Confirmar");
    expect(e.reply).toEqual({ id: "CONFIRMAR_CONSULTA", title: "Confirmar", kind: "template_button" });
    expect(e.tipoOriginal).toBe("button");
  });

  it("botão interativo (`button_reply`): texto = título", () => {
    const e = recebida(BOTAO_INTERATIVO);
    expect(e.type).toBe("text");
    expect(e.text).toBe("Sim, quero");
    expect(e.reply).toEqual({ id: "sim-1", title: "Sim, quero", kind: "button_reply" });
  });

  it("item de lista (`list_reply`): texto = título, descrição guardada", () => {
    const e = recebida(ITEM_DE_LISTA);
    expect(e.type).toBe("text");
    expect(e.text).toBe("Plano anual");
    expect(e.reply).toEqual({
      id: "plano-anual",
      title: "Plano anual",
      kind: "list_reply",
      description: "12 meses",
    });
  });

  it("tipo que o banco não conhece vira texto marcado, nunca o tipo cru", () => {
    for (const msg of [PEDIDO, NAO_SUPORTADO, { type: "system", system: { body: "trocou de número" } }]) {
      const e = recebida(msg);
      expect(e.type).toBe("text");
      expect(e.text).toBe(`[tipo de mensagem não suportado: ${msg.type}]`);
      expect(e.tipoOriginal).toBe(msg.type);
      expect(e.naoSuportado).toBe(true);
    }
  });

  it("os tipos que já funcionavam continuam com o mesmo tipo", () => {
    expect(recebida({ type: "text", text: { body: "oi" } })).toMatchObject({ type: "text", text: "oi" });
    expect(recebida({ type: "image", image: { id: "m1", mime_type: "image/jpeg" } }).type).toBe("image");
    expect(recebida({ type: "location", location: { latitude: 1, longitude: 2 } }).type).toBe("location");
    expect(recebida({ type: "reaction", reaction: { message_id: "wamid.A", emoji: "👍" } }).type).toBe(
      "reaction",
    );
  });

  it("todo tipo que o parser produz está no vocabulário do CHECK", () => {
    for (const msg of [BOTAO_DE_TEMPLATE, BOTAO_INTERATIVO, ITEM_DE_LISTA, PEDIDO, NAO_SUPORTADO]) {
      expect(ACEITOS.has(recebida(msg).type)).toBe(true);
      expect(ACEITOS.has(eco(msg).type)).toBe(true);
    }
  });
});

describe("ingestão: a resposta do cliente é gravada e aparece na lista", () => {
  const dono = { organizationId: "org-1" };

  it.each([
    ["botão de template", BOTAO_DE_TEMPLATE, "Confirmar", "template_button"],
    ["botão interativo", BOTAO_INTERATIVO, "Sim, quero", "button_reply"],
    ["item de lista", ITEM_DE_LISTA, "Plano anual", "list_reply"],
  ])("%s: grava como texto, prévia e agente recebem a opção", async (_n, msg, titulo, kind) => {
    const r = await ingestMetaInbound(adminFalso(), recebida(msg), dono);
    expect(r.status).toBe("ingested");
    expect(estado.insert).toMatchObject({
      type: "text",
      body: titulo,
      metadata: { reply: { title: titulo, kind } },
    });
    expect(estado.marcacoes[0]).toMatchObject({ preview: titulo });
    expect(estado.posEntrada[0]).toMatchObject({ texto: titulo });
  });

  it("tipo não suportado: grava a marca, guarda o tipo original e não alimenta o agente", async () => {
    const r = await ingestMetaInbound(adminFalso(), recebida(PEDIDO), dono);
    expect(r.status).toBe("ingested");
    expect(estado.insert).toMatchObject({
      type: "text",
      body: "[tipo de mensagem não suportado: order]",
      metadata: { tipo_original: "order" },
    });
    expect(estado.marcacoes[0]).toMatchObject({ preview: "[tipo de mensagem não suportado: order]" });
    // A marca é para quem atende ler; ela não é o que o cliente escreveu.
    expect(estado.posEntrada[0]).toMatchObject({ texto: null });
  });

  it("eco do app com tipo desconhecido também é gravado, não recusado", async () => {
    const r = await ingestMetaEcho(adminFalso(), eco(PEDIDO), dono);
    expect(r.status).toBe("ingested");
    expect(estado.insert).toMatchObject({
      type: "text",
      body: "[tipo de mensagem não suportado: order]",
      metadata: { tipo_original: "order", from_business_app: true },
    });
    expect(estado.marcacoes[0]).toMatchObject({ preview: "[tipo de mensagem não suportado: order]" });
  });
});
