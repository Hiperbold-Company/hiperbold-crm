/**
 * A resposta privada a comentário (Direct enviado pela fila) aparece no Chat.
 *
 * Defeito de produção (18/11): o Direct chegava ao cliente e a conversa do
 * contato no CRM ficava vazia — a fila não gravava `messages`, e o eco do
 * webhook era descartado como envio nosso. Contra o banco em memória do canal
 * (as restrições únicas reais, 23505 inclusive); a Meta é um `fetch` falso.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso } from "./helpers/meta-social-banco-falso";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => undefined) }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: vi.fn(async () => undefined) }));
vi.mock("@/lib/plataformas-de-anuncio/google/atribuicao", () => ({
  extrairEEstamparAtribuicaoGoogle: vi.fn(async () => undefined),
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { processarFilaMetaSocial } from "@/lib/channels/meta-social/fila";
import { gravarRespostaPrivadaNoChat, ingerirEventoMetaSocial, sessaoPelaConta } from "@/lib/channels/meta-social/ingest";
import { logger } from "@/lib/logger";
import type { EventoMetaSocial } from "@/lib/channels/meta-social/webhook";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IG_A = "17841400000000001";
const IG_B = "17841400000000002";
const AGORA = new Date("2026-11-18T12:00:00.000Z");

const sessaoA = {
  id: "sessao-a",
  organization_id: ORG_A,
  provider: "meta_social",
  meta_social_platform: "instagram",
  meta_social_account_id: IG_A,
  meta_social_page_id: "PAG-1",
  meta_social_token_encrypted: "cifrado:TOKEN-A",
  archived_at: null,
  status: "WORKING",
  status_reason: null,
};
const sessaoB = {
  ...sessaoA,
  id: "sessao-b",
  organization_id: ORG_B,
  meta_social_account_id: IG_B,
  meta_social_page_id: "PAG-2",
  meta_social_token_encrypted: "cifrado:TOKEN-B",
};

const comentario = (extra: Record<string, unknown> = {}) => ({
  id: "linha-C-1",
  organization_id: ORG_A,
  channel_session_id: "sessao-a",
  comment_id: "C-1",
  autor_id: "IGSID-1",
  autor_usuario: "maria",
  criado_na_meta_em: new Date(AGORA.getTime() - 60_000).toISOString(),
  recebido_em: new Date(AGORA.getTime() - 60_000).toISOString(),
  resposta_privada_status: "na_fila",
  ...extra,
});

const privadaNaFila = (extra: Record<string, unknown> = {}) => ({
  id: "fila-privada-C-1",
  organization_id: ORG_A,
  channel_session_id: "sessao-a",
  tipo: "resposta_privada",
  comment_id: "C-1",
  texto: "Te mandei o link aqui no Direct!",
  pedido_por: "automacao:p1:e1:passo-1",
  status: "na_fila",
  tentativas: 0,
  proxima_tentativa_em: new Date(AGORA.getTime() - 1000).toISOString(),
  criado_em: new Date(AGORA.getTime() - 5000).toISOString(),
  atualizado_em: new Date(AGORA.getTime() - 5000).toISOString(),
  ...extra,
});

/** A Meta falsa: o envio da privada devolve o IGSID e o mid. */
function metaQueEnvia(recipientId = "IGSID-1", mid = "mid.priv") {
  const urls: string[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ recipient_id: recipientId, message_id: mid }), { status: 200 });
  });
  return { fetcher: fetcher as unknown as typeof fetch, urls };
}

const eco = (over: Partial<Extract<EventoMetaSocial, { tipo: "mensagem" }>> = {}): EventoMetaSocial => ({
  tipo: "mensagem",
  plataforma: "instagram",
  contaId: IG_A,
  clienteId: "IGSID-1",
  mid: "mid.priv",
  direcao: "outbound",
  texto: "Te mandei o link aqui no Direct!",
  anexos: [],
  enviadaEm: AGORA.toISOString(),
  appId: null,
  ...over,
});

beforeEach(() => {
  vi.mocked(pausarIaPorAtendimentoManual).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** O mesmo banco, com o registro de cada `from`/`rpc` na ordem em que o código os chama. */
function comRegistro(banco: ReturnType<typeof bancoFalso>) {
  const ordem: string[] = [];
  const db = {
    from: (nome: string) => {
      ordem.push(`from:${nome}`);
      return banco.db.from(nome);
    },
    rpc: (nome: string, args: Record<string, unknown>) => {
      ordem.push(`rpc:${nome}:${String(args.p_event_type ?? "")}`);
      return banco.db.rpc(nome, args);
    },
  } as unknown as SupabaseClient;
  return { db, ordem };
}

describe("resposta privada enviada entra no Chat", () => {
  it("comentarista sem contato nem conversa ganha os dois, e a saída fica na conversa dele", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario()],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    h.db = banco.db;
    const meta = metaQueEnvia();

    const r = await processarFilaMetaSocial(banco.db, AGORA, meta.fetcher);

    expect(r).toMatchObject({ enviadas: 1, falharam: 0 });
    // Uma chamada só à Meta: o envio. Sem ida extra pelo perfil.
    expect(meta.urls).toEqual(["https://graph.facebook.com/v26.0/PAG-1/messages"]);

    const contatos = banco.t("contacts");
    expect(contatos).toHaveLength(1);
    expect(contatos[0]).toMatchObject({
      organization_id: ORG_A,
      social_identity: `instagram:${IG_A}:IGSID-1`,
      name: "@maria",
    });

    const conversas = banco.t("conversations");
    expect(conversas).toHaveLength(1);
    expect(conversas[0]).toMatchObject({
      organization_id: ORG_A,
      contact_id: contatos[0]!.id,
      channel_session_id: "sessao-a",
      provider_conversation_id: "IGSID-1",
      channel: "instagram",
      // Fora da Fila até o cliente escrever (decisão do produto, 18/11).
      status: "closed",
      assigned_to_user_id: null,
      last_message_at: AGORA.toISOString(),
    });
    expect(banco.rodizio).toEqual([]);

    const mensagens = banco.t("messages");
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).toMatchObject({
      organization_id: ORG_A,
      conversation_id: conversas[0]!.id,
      contact_id: contatos[0]!.id,
      channel_session_id: "sessao-a",
      external_id: "mid.priv",
      direction: "outbound",
      status: "sent",
      type: "text",
      body: "Te mandei o link aqui no Direct!",
      sent_via: "automation",
    });
    // Enviada pelo CRM: não é "respondido pelo celular", a IA segue.
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  });

  it("comentarista que já tem conversa: a saída entra nela, sem conversa nova", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      contacts: [{ id: "contato-1", organization_id: ORG_A, social_identity: `instagram:${IG_A}:IGSID-1`, name: "Maria Silva" }],
      conversations: [
        {
          id: "conversa-1",
          organization_id: ORG_A,
          contact_id: "contato-1",
          channel_session_id: "sessao-a",
          provider_conversation_id: "IGSID-1",
          channel: "instagram",
        },
      ],
      meta_social_comentarios: [comentario()],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    h.db = banco.db;

    await processarFilaMetaSocial(banco.db, AGORA, metaQueEnvia().fetcher);

    expect(banco.t("conversations")).toHaveLength(1);
    expect(banco.t("contacts")).toHaveLength(1);
    expect(banco.t("contacts")[0]!.name).toBe("Maria Silva");
    expect(banco.t("messages")).toEqual([
      expect.objectContaining({
        conversation_id: "conversa-1",
        contact_id: "contato-1",
        external_id: "mid.priv",
        direction: "outbound",
        sent_via: "automation",
      }),
    ]);
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  });

  it("a conversa é a do recipient_id que a Meta devolveu, não um id inventado", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario({ autor_id: "IGSID-DO-COMENTARIO" })],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    h.db = banco.db;

    await processarFilaMetaSocial(banco.db, AGORA, metaQueEnvia("IGSID-DO-DIRECT").fetcher);

    expect(banco.t("conversations")[0]).toMatchObject({ provider_conversation_id: "IGSID-DO-DIRECT" });
    expect(banco.t("contacts")[0]).toMatchObject({ social_identity: `instagram:${IG_A}:IGSID-DO-DIRECT` });
  });
});

describe("o eco da privada não duplica", () => {
  it("eco sem app_id com o mesmo mid é ignorado: uma linha só, autoria intacta, IA não pausada", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario()],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    h.db = banco.db;
    await processarFilaMetaSocial(banco.db, AGORA, metaQueEnvia().fetcher);

    const s = (await sessaoPelaConta(banco.db, "instagram", IG_A))!;
    const d = await ingerirEventoMetaSocial(banco.db, s, eco(), { appIdsProprios: [] });

    expect(d).toEqual({ status: "ignored", reason: "eco_do_proprio_envio" });
    expect(banco.t("messages")).toHaveLength(1);
    expect(banco.t("messages")[0]).toMatchObject({ external_id: "mid.priv", sent_via: "automation" });
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  });

  it("sem o registro em meta_social_envios (poda, falha), o eco é reconhecido pela própria linha", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario()],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    h.db = banco.db;
    await processarFilaMetaSocial(banco.db, AGORA, metaQueEnvia().fetcher);
    banco.tabelas.meta_social_envios = [];

    const s = (await sessaoPelaConta(banco.db, "instagram", IG_A))!;
    const d = await ingerirEventoMetaSocial(banco.db, s, eco(), { appIdsProprios: [] });

    expect(d).toEqual({ status: "ignored", reason: "eco_do_proprio_envio" });
    expect(banco.t("messages")).toHaveLength(1);
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  });

  it("gravar a mesma privada duas vezes: 23505 vira duplicate, uma linha só", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    const entrada = {
      organizationId: ORG_A,
      channelSessionId: "sessao-a",
      contaId: IG_A,
      clienteId: "IGSID-1",
      mid: "mid.priv",
      texto: "oi",
      enviadaEm: AGORA.toISOString(),
      autorUsuario: "maria",
    };
    expect((await gravarRespostaPrivadaNoChat(banco.db, entrada)).status).toBe("ingested");
    expect((await gravarRespostaPrivadaNoChat(banco.db, entrada)).status).toBe("duplicate");
    expect(banco.t("messages")).toHaveLength(1);
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  });
});

describe("isolamento por organização", () => {
  it("org B com o mesmo IGSID e o mesmo comment_id: nada é escrito nela", async () => {
    const contatoB = { id: "contato-b", organization_id: ORG_B, social_identity: `instagram:${IG_A}:IGSID-1`, name: "Outra" };
    const conversaB = {
      id: "conversa-b",
      organization_id: ORG_B,
      contact_id: "contato-b",
      channel_session_id: "sessao-b",
      provider_conversation_id: "IGSID-1",
      channel: "instagram",
    };
    const banco = bancoFalso({
      channel_sessions: [sessaoA, sessaoB],
      contacts: [contatoB],
      conversations: [conversaB],
      meta_social_comentarios: [
        comentario(),
        comentario({ id: "linha-B", organization_id: ORG_B, channel_session_id: "sessao-b", autor_usuario: "fulano" }),
      ],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    h.db = banco.db;

    await processarFilaMetaSocial(banco.db, AGORA, metaQueEnvia().fetcher);

    const mensagens = banco.t("messages");
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).toMatchObject({ organization_id: ORG_A, channel_session_id: "sessao-a" });
    expect(mensagens[0]!.conversation_id).not.toBe("conversa-b");
    expect(mensagens[0]!.contact_id).not.toBe("contato-b");
    // A org B ficou exatamente como estava.
    expect(banco.t("contacts").filter((c) => c.organization_id === ORG_B)).toEqual([contatoB]);
    expect(banco.t("conversations").filter((c) => c.organization_id === ORG_B)).toEqual([conversaB]);
    expect(banco.t("meta_social_envios").every((e) => e.organization_id === ORG_A)).toBe(true);
    // O contato novo da A nasceu com o nome do comentário DA A.
    expect(banco.t("contacts").find((c) => c.organization_id === ORG_A)).toMatchObject({ name: "@maria" });
  });
});

describe("falha ao gravar no Chat não desfaz o envio", () => {
  it("messages fora do ar: a linha da fila fica enviada, o desfecho sai e nada é reenviado", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario()],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    const de = banco.db.from.bind(banco.db);
    const db = {
      ...banco.db,
      rpc: banco.db.rpc,
      from: (nome: string) => {
        if (nome === "messages") throw new Error("messages_fora_do_ar");
        return de(nome);
      },
    } as unknown as SupabaseClient;
    h.db = db;
    const meta = metaQueEnvia();

    const r = await processarFilaMetaSocial(db, AGORA, meta.fetcher);

    expect(r).toMatchObject({ enviadas: 1, falharam: 0 });
    expect(banco.t("meta_social_fila_de_envio")[0]).toMatchObject({ status: "enviada", resultado_id: "mid.priv" });
    expect(banco.t("meta_social_comentarios")[0]).toMatchObject({ resposta_privada_status: "enviada" });
    expect(banco.t("event_log").map((e) => e.event_type)).toContain("instagram.resposta_enviada");
    expect(meta.urls).toHaveLength(1);
  });
});

describe("a privada não mexe na Fila", () => {
  it("conversa existente na Fila: não lidas, espera, prévia, status e dono intactos, e o carimbo não é chamado", async () => {
    const conversa = {
      id: "conversa-1",
      organization_id: ORG_A,
      contact_id: "contato-1",
      channel_session_id: "sessao-a",
      provider_conversation_id: "IGSID-1",
      channel: "instagram",
      status: "open",
      assigned_to_user_id: null,
      unread_count_for_assignee: 3,
      awaiting_since: "2026-11-18T11:00:00.000Z",
      last_inbound_at: "2026-11-18T11:30:00.000Z",
      last_message_at: "2026-11-18T11:30:00.000Z",
      last_message_preview: "quero o link",
    };
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      contacts: [{ id: "contato-1", organization_id: ORG_A, social_identity: `instagram:${IG_A}:IGSID-1`, name: "Maria" }],
      conversations: [conversa],
      meta_social_comentarios: [comentario()],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    h.db = banco.db;

    await processarFilaMetaSocial(banco.db, AGORA, metaQueEnvia().fetcher);

    expect(banco.t("messages")).toHaveLength(1);
    expect(banco.t("conversations")).toEqual([expect.objectContaining({ ...conversa, channel: "instagram" })]);
    expect(banco.rpcs).not.toContain("fn_mark_conversation_message");
    expect(banco.rodizio).toEqual([]);
  });

  it("controle: a mensagem do cliente pelo Direct passa pelo carimbo, e conversa nova pela ingestão pede rodízio", async () => {
    const banco = bancoFalso({ channel_sessions: [sessaoA] });
    const s = (await sessaoPelaConta(banco.db, "instagram", IG_A))!;
    await ingerirEventoMetaSocial(banco.db, s, eco({ direcao: "inbound", mid: "mid.cliente", texto: "oi" }), {
      appIdsProprios: [],
    });
    expect(banco.rpcs).toContain("fn_mark_conversation_message");
    expect(banco.rodizio).toEqual([banco.t("conversations")[0]!.id]);
  });

  it("o cliente que responde depois cai na MESMA conversa da privada (é ela que o banco reabre)", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario()],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    h.db = banco.db;
    await processarFilaMetaSocial(banco.db, AGORA, metaQueEnvia().fetcher);
    const daPrivada = banco.t("conversations")[0]!.id;

    const s = (await sessaoPelaConta(banco.db, "instagram", IG_A))!;
    const d = await ingerirEventoMetaSocial(banco.db, s, eco({ direcao: "inbound", mid: "mid.cliente", texto: "obrigada!" }), {
      appIdsProprios: [],
    });

    expect(d.status).toBe("ingested");
    expect(banco.t("conversations")).toHaveLength(1);
    expect(banco.t("messages").map((m) => [m.conversation_id, m.direction])).toEqual([
      [daPrivada, "outbound"],
      [daPrivada, "inbound"],
    ]);
    // A entrada carimba a conversa (não lidas, espera) como sempre.
    expect(banco.t("conversations")[0]).toMatchObject({ unread_count_for_assignee: 1 });
  });
});

describe("ordem das gravações depois do envio", () => {
  it("o mid é registrado ANTES de a linha da fila e o comentário serem gravados", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario()],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    const { db, ordem } = comRegistro(banco);
    h.db = db;

    await processarFilaMetaSocial(db, AGORA, metaQueEnvia().fetcher);

    const registro = ordem.indexOf("from:meta_social_envios");
    expect(registro).toBeGreaterThan(-1);
    // Depois do registro, a próxima escrita na fila é o `enviada`.
    expect(ordem.slice(registro + 1)).toContain("from:meta_social_fila_de_envio");
    expect(ordem.slice(0, registro).filter((o) => o === "from:meta_social_comentarios")).toHaveLength(1); // só a leitura
    expect(banco.t("meta_social_fila_de_envio")[0]).toMatchObject({ status: "enviada" });
  });

  it("o desfecho instagram.resposta_enviada sai ANTES da gravação no Chat", async () => {
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario()],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    const { db, ordem } = comRegistro(banco);
    h.db = db;

    await processarFilaMetaSocial(db, AGORA, metaQueEnvia().fetcher);

    const desfecho = ordem.indexOf("rpc:emit_event:instagram.resposta_enviada");
    const chat = ordem.indexOf("from:messages");
    expect(desfecho).toBeGreaterThan(-1);
    expect(chat).toBeGreaterThan(desfecho);
  });

  it("eco que chegou antes do registro: a gravação volta duplicate e deixa rastro com o comment_id", async () => {
    const warn = vi.spyOn(logger, "warn");
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      contacts: [{ id: "contato-1", organization_id: ORG_A, social_identity: `instagram:${IG_A}:IGSID-1` }],
      conversations: [
        { id: "conversa-1", organization_id: ORG_A, contact_id: "contato-1", channel_session_id: "sessao-a", provider_conversation_id: "IGSID-1" },
      ],
      messages: [{ id: "m-eco", organization_id: ORG_A, conversation_id: "conversa-1", external_id: "mid.priv", direction: "outbound" }],
      meta_social_comentarios: [comentario()],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    h.db = banco.db;

    await processarFilaMetaSocial(banco.db, AGORA, metaQueEnvia().fetcher);

    expect(banco.t("messages")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("eco antes do registro"),
      expect.objectContaining({ organization_id: ORG_A, comment_id: "C-1" }),
    );
  });

  it("destinatário diferente do autor do comentário: o aviso leva o comment_id", async () => {
    const warn = vi.spyOn(logger, "warn");
    const banco = bancoFalso({
      channel_sessions: [sessaoA],
      meta_social_comentarios: [comentario({ autor_id: "IGSID-DO-COMENTARIO" })],
      meta_social_fila_de_envio: [privadaNaFila()],
    });
    h.db = banco.db;

    await processarFilaMetaSocial(banco.db, AGORA, metaQueEnvia("IGSID-DO-DIRECT").fetcher);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("difere do autor"),
      { organization_id: ORG_A, comment_id: "C-1" },
    );
  });
});
