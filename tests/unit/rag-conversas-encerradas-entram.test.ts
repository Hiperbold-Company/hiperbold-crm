/**
 * O lote noturno de "Conversas anteriores" lê as conversas ENCERRADAS pelo Chat.
 *
 * O filtro era `status = 'resolved'`, e nenhum código de produção grava esse
 * status em conversa: o Chat encerra com `closed` e arquiva com `archived`. A
 * conversa marcada pelo botão "Usar para ensinar o agente" nunca entrava.
 *
 * Também mede que não há janela de tempo: a conversa marcada há semanas que
 * nenhuma rodada processou (ex.: rodada que falhou) entra na próxima; a aberta
 * fica fora até ser encerrada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria } from "../helpers/banco-em-memoria";

const ORG = "33333333-3333-4333-8333-333333333333";
const DESDE = new Date("2026-10-21T03:30:00Z");

let banco: BancoEmMemoria;

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/ai/embed", () => ({
  embedText: vi.fn(async () => ({ embedding: [0.1, 0.2] })),
}));
vi.mock("@/lib/ai/embeddings/chave", () => ({
  resolverChaveDeEmbedding: vi.fn(async () => ({ chave: "x" })),
}));
vi.mock("@/lib/legal/perfil-do-pais", () => ({
  perfilDaOrganizacao: vi.fn(async () => ({})),
}));
vi.mock("@/lib/ai/anonymize", () => ({
  padroesDePii: vi.fn(() => []),
  anonymize: vi.fn((t: string) => ({ anonymized: t, hits: ["x"] })),
  detectResidualPii: vi.fn(() => null),
}));
vi.mock("@/lib/ai/rag/version", () => ({
  createKnowledgeVersion: vi.fn(async () => ({ versionId: "v1" })),
  markVersionReady: vi.fn(async () => undefined),
  markVersionFailed: vi.fn(async () => undefined),
  activateVersion: vi.fn(async () => undefined),
}));

import { ingestConversationsBatch } from "@/lib/ai/rag/ingest/conversations";

function conversa(id: string, status: string, marcadaEm: string, statusEm: string) {
  return {
    id,
    organization_id: ORG,
    contact_id: null,
    usable_for_rag: true,
    status,
    usable_for_rag_marked_at: marcadaEm,
    status_changed_at: statusEm,
    rag_review_status: null,
  };
}

const ONTEM = "2026-10-21T15:00:00Z";
const SEMANAS = "2026-09-20T15:00:00Z";

beforeEach(() => {
  const ids = ["fechada", "arquivada", "resolvida", "aberta", "reencerrada", "parada"];
  banco = criarBancoEmMemoria({
    contacts: [],
    conversations: [
      conversa("fechada", "closed", ONTEM, SEMANAS),
      conversa("arquivada", "archived", ONTEM, SEMANAS),
      conversa("resolvida", "resolved", ONTEM, SEMANAS),
      conversa("aberta", "open", ONTEM, ONTEM),
      conversa("reencerrada", "closed", SEMANAS, ONTEM),
      conversa("parada", "closed", SEMANAS, SEMANAS),
      conversa("so-midia", "closed", ONTEM, SEMANAS),
    ],
    messages: ids.map((id) => ({
      organization_id: ORG,
      conversation_id: id,
      body: `pergunta da conversa ${id}`,
      direction: "inbound",
      sent_at: "2026-10-21T10:00:00Z",
    })),
    // `so-midia` não tem mensagem com texto: nada a ensinar.
    ai_knowledge_sources: [
      { id: "src-1", organization_id: ORG, source_type: "conversas", is_active: true, created_at: "2026-09-01" },
    ],
    ai_chunks: [],
  });
});

describe("lote de conversas: quem entra", () => {
  it("encerradas (fechada, arquivada, resolvida), a re-encerrada e a marcada há semanas entram; aberta não", async () => {
    const r = await ingestConversationsBatch({ organizationId: ORG, agentId: "agente-1", sinceTs: DESDE });

    const status = Object.fromEntries(
      banco.tabelas["conversations"]!.map((c) => [c["id"], c["rag_review_status"]]),
    );
    expect(status).toEqual({
      fechada: "ingested",
      arquivada: "ingested",
      resolvida: "ingested",
      reencerrada: "ingested",
      parada: "ingested",
      aberta: null,
      "so-midia": "skipped",
    });
    expect(r.processed).toBe(5);
  });

  it("conversa sem texto sai da fila de vez (skipped), para não ocupar o teto de toda rodada", async () => {
    await ingestConversationsBatch({ organizationId: ORG, agentId: "agente-1", sinceTs: DESDE });
    const soMidia = banco.tabelas["conversations"]!.find((c) => c["id"] === "so-midia");
    expect(soMidia?.["rag_review_status"]).toBe("skipped");
  });
});
