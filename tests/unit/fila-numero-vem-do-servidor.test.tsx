import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationsFilters,
  ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";

/**
 * NA FILA, O "1º, 2º…" É A POSIÇÃO NA ESPERA — NÃO O ÍNDICE DA LINHA.
 *
 * A lista da Fila sai da mais recente para a mais antiga (lote 2026-10-22). Se a
 * lista continuasse numerando pelo índice, a conversa que ACABOU de chegar seria
 * a "1º" — o atendente atenderia primeiro quem menos esperou. O número vem do
 * servidor (`queue_position`, ver `comPosicaoNaFila`): o mais antigo esperando é
 * o 1º, mesmo aparecendo embaixo.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
}));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({
  useAutomaticoAtivo: () => ({ data: true }),
}));
const recebidas: Array<{ id: string; queuePosition?: number; naFila?: boolean }> = [];
vi.mock("@/components/inbox/ConversationListItem", () => ({
  ConversationListItem: (p: {
    conversation: ConversationWithContact;
    queuePosition?: number;
    naFila?: boolean;
  }) => {
    recebidas.push({ id: p.conversation.id, queuePosition: p.queuePosition, naFila: p.naFila });
    return null;
  },
}));

const { ConversationList } = await import("@/components/inbox/ConversationList");

/** Na ordem da lista: a mais recente primeiro, logo a que espera há menos tempo. */
const itens = [
  { id: "nova", queue_position: 3 },
  { id: "meio", queue_position: 2 },
  { id: "antiga", queue_position: 1 },
  { id: "sem-conta", queue_position: null },
] as unknown as ConversationWithContact[];

function montar(filters: ConversationsFilters) {
  recebidas.length = 0;
  render(
    <ConversationList
      listQuery={
        {
          data: { pages: [{ data: itens, meta: { has_more: false } }] },
          isLoading: false,
          isError: false,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          refetch: vi.fn(),
        } as never
      }
      filters={filters}
      selectedId={null}
      onSelect={() => undefined}
    />,
  );
  return recebidas.map((r) => [r.id, r.queuePosition, r.naFila]);
}

afterEach(() => cleanup());

describe("a lista repassa a posição que o servidor contou", () => {
  it("⭐ na Fila: a de cima (mais recente) é a 3º, a de baixo (mais antiga) é a 1º", () => {
    expect(montar({ comando: ["aguardando"] } as ConversationsFilters)).toEqual([
      ["nova", 3, true],
      ["meio", 2, true],
      ["antiga", 1, true],
      ["sem-conta", undefined, true],
    ]);
  });

  it("CONTROLE: fora da Fila não há número nem espera, mesmo que a linha traga posição", () => {
    expect(montar({ assigned_to: "me" } as ConversationsFilters)).toEqual([
      ["nova", undefined, false],
      ["meio", undefined, false],
      ["antiga", undefined, false],
      ["sem-conta", undefined, false],
    ]);
  });
});
