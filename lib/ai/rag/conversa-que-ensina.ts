/**
 * Quais conversas podem "ensinar o agente" (fonte `conversas` do Conhecimento).
 *
 * Uma regra só para os três lados que a usam: o botão do Chat
 * (`components/inbox/EnsinarAgenteButton.tsx`), a rota que marca
 * (`app/api/v1/conversations/[id]/usable-for-rag`) e o lote noturno que indexa
 * (`lib/ai/rag/ingest/conversations.ts`).
 *
 * O lote filtrava só `status = 'resolved'`, e nenhum código de produção grava
 * esse status em conversa: o Chat ENCERRA com `closed` (rota `/close`) e arquiva
 * com `archived`. Uma conversa marcada pelo Chat nunca entrava na base. Os três
 * status terminais valem igual aqui — é o mesmo conjunto que
 * `lib/inbox/comando-da-conversa.ts` chama de encerrado.
 */
export const STATUS_QUE_ENSINAM = ["closed", "resolved", "archived"] as const;

export function conversaPodeEnsinar(status: string | null | undefined): boolean {
  return (STATUS_QUE_ENSINAM as readonly string[]).includes(status ?? "");
}

/** Estado da marcação, como a rota devolve e o botão lê. */
export interface EstadoDoEnsino {
  conversation_id: string;
  usable_for_rag: boolean;
  usable_for_rag_marked_at: string | null;
  /** `ingested` = já está na base; `pending_review` = o lote parou para revisão; `skipped` = ficou de fora. */
  rag_review_status: "pending_review" | "ingested" | "skipped" | null;
  pode_marcar: boolean;
}
