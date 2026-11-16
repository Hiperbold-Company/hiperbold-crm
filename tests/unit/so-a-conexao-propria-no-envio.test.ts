import { describe, expect, it } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import type { SendMessageInput } from "@/lib/schemas";
import { CODIGO_CONEXAO_PROPRIA_OBRIGATORIA } from "@/lib/inbox/conexao-ao-abrir";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

/**
 * "Só a conexão própria" vale também no ENVIO (decisão do dono do produto,
 * 16/11/2026: "o atendente só usa a conexão própria dele. Ponto.").
 *
 * O atendente (abaixo de gerente) sem número próprio conectado — o caso que a
 * guarda do número (#3642) deixa passar — não envia pela conexão de colega,
 * salvo em conversa ABERTA atribuída a ele (a transferência). Número geral
 * (sem responsável) segue livre. Token e automações não passam pela regra.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSAO_DA_COLEGA = "44444444-4444-4444-8444-444444444444";
const EU = "55555555-5555-4555-8555-555555555555";
const COLEGA = "77777777-7777-4777-8777-777777777777";
const POLITICA = "88888888-8888-4888-8888-888888888888";

const conversa = (extra: Record<string, unknown> = {}) => ({
  id: CONV,
  organization_id: ORG,
  contact_id: CONTACT,
  channel_session_id: SESSAO_DA_COLEGA,
  is_group: false,
  group_chat_id: null,
  bot_silenced_until: null,
  provider_conversation_id: null,
  last_inbound_at: new Date().toISOString(),
  status: "open",
  assigned_to_user_id: COLEGA,
  contacts: { phone_number: "+5511999999999", wa_identity: null, wa_lid: null, is_blocked: false, is_personal: false },
  channel_sessions: { provider: "zernio", status: "WORKING", archived_at: null },
  ...extra,
});

async function enviar(o: {
  modo?: "choose" | "own_only";
  conversa?: Record<string, unknown>;
  semResponsavel?: boolean;
  actor?: HandlerCtx["actor"];
}) {
  const duble = criarDubleDoHandler({
    conversation: conversa(o.conversa),
    organizacao: { settings: { routing: { conversation_connection_mode: o.modo ?? "own_only" } }, status: "active" },
    politicasDeNumero: [{ id: POLITICA, organization_id: ORG, channel_session_id: SESSAO_DA_COLEGA }],
    responsaveisDeNumero: o.semResponsavel ? [] : [{ policy_id: POLITICA, user_id: COLEGA, organization_id: ORG }],
    sessoesDeNumero: [],
  });
  const ctx: HandlerCtx = {
    organization_id: ORG,
    actor: o.actor ?? { type: "user", id: EU, role: "agent" },
    requestId: "req-conexao",
  };
  const resultado = await sendMessageHandler(duble.supabase, ctx, {
    conversation_id: CONV,
    type: "text",
    body: "oi",
  } as SendMessageInput).catch((e: unknown) => e);
  return { resultado, duble };
}

const recusado = (r: unknown) => r instanceof ApiError && r.code === CODIGO_CONEXAO_PROPRIA_OBRIGATORIA;

describe("'só a conexão própria' no envio", () => {
  it("⭐ atendente na conexão da colega → 403 com código próprio, e nada é gravado", async () => {
    const { resultado, duble } = await enviar({});
    expect(recusado(resultado)).toBe(true);
    expect((resultado as ApiError).status).toBe(403);
    expect((resultado as ApiError).message).toMatch(/só responde pela sua conexão/);
    expect(duble.capturas.inserts.messages).toHaveLength(0);
  });

  it("conversa ABERTA atribuída a ele (transferida) → não recusa", async () => {
    const { resultado } = await enviar({ conversa: { assigned_to_user_id: EU } });
    expect(recusado(resultado)).toBe(false);
  });

  it("conversa ENCERRADA atribuída a ele → recusa", async () => {
    const { resultado } = await enviar({ conversa: { assigned_to_user_id: EU, status: "closed" } });
    expect(recusado(resultado)).toBe(true);
  });

  it("número geral (sem responsável) → não recusa", async () => {
    const { resultado } = await enviar({ semResponsavel: true });
    expect(recusado(resultado)).toBe(false);
  });

  it("modo 'deixar escolher' → não recusa (o controle)", async () => {
    const { resultado } = await enviar({ modo: "choose" });
    expect(recusado(resultado)).toBe(false);
  });

  it("gerente → não recusa", async () => {
    const { resultado } = await enviar({ actor: { type: "user", id: EU, role: "manager" } });
    expect(recusado(resultado)).toBe(false);
  });

  it("token de integração → não passa pela regra", async () => {
    const { resultado } = await enviar({ actor: { type: "api_token", id: "tok-1", role: "agent" } });
    expect(recusado(resultado)).toBe(false);
  });
});
