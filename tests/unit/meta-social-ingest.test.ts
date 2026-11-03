/**
 * Ingestão do canal social oficial contra um banco em memória com as
 * restrições únicas reais (23505). A ingestão social COMPARTILHADA roda de
 * verdade; só os efeitos de negócio pós-entrada (lead, agente, pausa da IA,
 * marcação da conversa), que pertencem a outros módulos, são dublados.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: vi.fn(async () => undefined) }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: vi.fn(async () => undefined) }));
vi.mock("@/lib/plataformas-de-anuncio/google/atribuicao", () => ({
  extrairEEstamparAtribuicaoGoogle: vi.fn(async () => undefined),
}));

import { ingerirEventoMetaSocial, sessaoPelaConta } from "@/lib/channels/meta-social/ingest";
import type { EventoMetaSocial } from "@/lib/channels/meta-social/webhook";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";
import { bancoFalso } from "./helpers/meta-social-banco-falso";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sessaoA = {
  id: "sessao-a",
  organization_id: ORG_A,
  provider: "meta_social",
  meta_social_platform: "instagram",
  meta_social_account_id: "IG-A",
  meta_social_token_encrypted: "cifrado:token-a",
  archived_at: null,
};

const msg = (over: Partial<Extract<EventoMetaSocial, { tipo: "mensagem" }>> = {}): EventoMetaSocial => ({
  tipo: "mensagem",
  plataforma: "instagram",
  contaId: "IG-A",
  clienteId: "IGSID-1",
  mid: "mid.1",
  direcao: "inbound",
  texto: "quero saber o preço",
  anexos: [],
  enviadaEm: "2026-11-02T12:00:00.000Z",
  appId: null,
  ...over,
});

const perfil = vi.fn(async () => ({ nome: "Maria", usuario: "maria" }));

beforeEach(() => {
  perfil.mockClear();
  vi.mocked(pausarIaPorAtendimentoManual).mockClear();
});

describe("resolução da sessão pelo entry.id", () => {
  it("a organização vem da linha do banco da conta, e só da conta viva", async () => {
    const { db } = bancoFalso({
      channel_sessions: [
        sessaoA,
        { ...sessaoA, id: "sessao-b-arquivada", organization_id: ORG_B, archived_at: "2026-10-01T00:00:00Z" },
      ],
    });
    const s = await sessaoPelaConta(db, "instagram", "IG-A");
    expect(s?.organizationId).toBe(ORG_A);
    expect(await sessaoPelaConta(db, "messenger", "IG-A")).toBeNull();
    expect(await sessaoPelaConta(db, "instagram", "DESCONHECIDA")).toBeNull();
  });

  it("duas linhas vivas para a mesma conta: não escolhe nenhuma", async () => {
    const { db } = bancoFalso({ channel_sessions: [sessaoA, { ...sessaoA, id: "x", organization_id: ORG_B }] });
    expect(await sessaoPelaConta(db, "instagram", "IG-A")).toBeNull();
  });
});

describe("ingestão", () => {
  it("cria contato social, conversa endereçável e mensagem; a reentrega é duplicate (23505)", async () => {
    const { db, t } = bancoFalso({ channel_sessions: [sessaoA] });
    const sessao = (await sessaoPelaConta(db, "instagram", "IG-A"))!;
    const deps = { perfil };

    const r1 = await ingerirEventoMetaSocial(db, sessao, msg(), { appIdsProprios: [] }, deps);
    const r2 = await ingerirEventoMetaSocial(db, sessao, msg(), { appIdsProprios: [] }, deps);

    expect(r1.status).toBe("ingested");
    expect(r2.status).toBe("duplicate");
    expect(t("messages")).toHaveLength(1);
    expect(t("messages")[0]).toMatchObject({ organization_id: ORG_A, external_id: "mid.1", direction: "inbound" });
    expect(t("contacts")).toHaveLength(1);
    expect(t("contacts")[0]).toMatchObject({
      organization_id: ORG_A,
      social_identity: "instagram:IG-A:IGSID-1",
      name: "Maria",
    });
    expect(t("conversations")[0]).toMatchObject({
      organization_id: ORG_A,
      provider_conversation_id: "IGSID-1",
      channel: "instagram",
    });
    // Perfil só para contato novo.
    expect(perfil).toHaveBeenCalledTimes(1);
  });

  it("eco de envio feito por este app é ignorado e não pausa a IA", async () => {
    const { db, t } = bancoFalso({ channel_sessions: [sessaoA] });
    const sessao = (await sessaoPelaConta(db, "instagram", "IG-A"))!;
    const r = await ingerirEventoMetaSocial(
      db,
      sessao,
      msg({ direcao: "outbound", appId: "APP-NOSSO", mid: "mid.eco" }),
      { appIdsProprios: ["APP-NOSSO"] },
      { perfil },
    );
    expect(r).toEqual({ status: "ignored", reason: "eco_do_proprio_envio" });
    expect(t("messages")).toHaveLength(0);
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
  });

  it("resposta dada pelo app da rede (eco sem app nosso) entra como saída e pausa a IA", async () => {
    const { db, t } = bancoFalso({ channel_sessions: [sessaoA] });
    const sessao = (await sessaoPelaConta(db, "instagram", "IG-A"))!;
    const r = await ingerirEventoMetaSocial(
      db,
      sessao,
      msg({ direcao: "outbound", mid: "mid.celular" }),
      { appIdsProprios: ["APP-NOSSO"] },
      { perfil },
    );
    expect(r.status).toBe("ingested");
    expect(t("messages")[0]).toMatchObject({ direction: "outbound", sent_via: "external_device" });
    expect(pausarIaPorAtendimentoManual).toHaveBeenCalled();
  });

  it("apagada marca revoked_at só na mensagem desta sessão", async () => {
    const { db, t } = bancoFalso({
      channel_sessions: [sessaoA],
      messages: [
        { id: "m1", organization_id: ORG_A, channel_session_id: "sessao-a", external_id: "mid.1" },
        { id: "m2", organization_id: ORG_B, channel_session_id: "outra", external_id: "mid.1" },
      ],
    });
    const sessao = (await sessaoPelaConta(db, "instagram", "IG-A"))!;
    const r = await ingerirEventoMetaSocial(
      db,
      sessao,
      { tipo: "apagada", plataforma: "instagram", contaId: "IG-A", mid: "mid.1" },
      { appIdsProprios: [] },
    );
    expect(r.status).toBe("ingested");
    expect(t("messages").find((m) => m.id === "m1")?.revoked_at).toBeTruthy();
    expect(t("messages").find((m) => m.id === "m2")?.revoked_at).toBeUndefined();
  });
});
