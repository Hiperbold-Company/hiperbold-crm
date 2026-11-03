/**
 * TETO de mensagens automáticas por contato: no máximo 30 por hora, somando
 * todas as automações. Passou disso, o bloco de mensagem sai pelo ramo de erro
 * com o motivo legível — os freios do lote 1 (passos, orçamento por rodada)
 * continuam valendo por cima.
 *
 * ─── De onde sai a conta ───────────────────────────────────────────────────
 *
 * De `messages`, e não de uma tabela do motor: a mensagem é o que o contato
 * recebe, e é ela que o teto protege. A linha conta quando foi enviada por uma
 * automação, marcada por `metadata.origem_automacao` (ver
 * `metadataDeOrigemAutomacao`). Quem envia pelo bloco de mensagem PRECISA
 * mesclar essa marca no `metadata` do envio — sem ela, a linha não conta.
 *
 * `sent_via = 'automation'` não serve de régua: o mesmo valor sai das regras
 * antigas e do follow-up com texto fixo, e o caminho do worker carimba `'ai'`.
 *
 * Conta TODA linha outbound marcada, inclusive `failed`: a tentativa já foi
 * feita, e o teto protege o contato de rajada, não só de entrega.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const TETO_DE_MENSAGENS_POR_HORA = 30;
export const JANELA_DO_TETO_MS = 60 * 60 * 1000;
export const CHAVE_DE_ORIGEM_AUTOMACAO = "origem_automacao";
export const MOTIVO_TETO_EXCEDIDO = "limite de 30 mensagens por hora";
export const MOTIVO_TETO_INDISPONIVEL = "não foi possível conferir o limite de mensagens por hora";

export interface OrigemAutomacao {
  enrollment_id: string;
  pointer_id: string | null;
}

/** O pedaço de `metadata` que marca a mensagem como enviada por automação. */
export function metadataDeOrigemAutomacao(args: {
  enrollmentId: string;
  pointerId?: string | null;
}): { [CHAVE_DE_ORIGEM_AUTOMACAO]: OrigemAutomacao } {
  return {
    [CHAVE_DE_ORIGEM_AUTOMACAO]: { enrollment_id: args.enrollmentId, pointer_id: args.pointerId ?? null },
  };
}

export type DecisaoDoTeto =
  | { pode: true; enviadasNaUltimaHora: number }
  | { pode: false; enviadasNaUltimaHora: number | null; motivo: string };

/** A decisão pura: com `enviadas` já na última hora, mais uma cabe? */
export function decidirTeto(enviadas: number, teto = TETO_DE_MENSAGENS_POR_HORA): DecisaoDoTeto {
  return enviadas < teto
    ? { pode: true, enviadasNaUltimaHora: enviadas }
    : { pode: false, enviadasNaUltimaHora: enviadas, motivo: MOTIVO_TETO_EXCEDIDO };
}

/**
 * Pode sair mais uma mensagem automática para este contato agora?
 *
 * Filtra `organization_id` explicitamente: quem chama usa o client de service
 * role, que ignora RLS. Falha de leitura FECHA (não envia): sem saber a conta,
 * mandar seria apostar contra o próprio teto.
 */
export async function podeEnviarMensagemAutomatica(
  admin: SupabaseClient,
  args: { organizationId: string; contactId: string; agora?: Date },
): Promise<DecisaoDoTeto> {
  const agora = args.agora ?? new Date();
  const desde = new Date(agora.getTime() - JANELA_DO_TETO_MS).toISOString();
  const { count, error } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", args.organizationId)
    .eq("contact_id", args.contactId)
    .eq("direction", "outbound")
    .gte("created_at", desde)
    .not(`metadata->${CHAVE_DE_ORIGEM_AUTOMACAO}`, "is", null);
  if (error || count === null) {
    return { pode: false, enviadasNaUltimaHora: null, motivo: MOTIVO_TETO_INDISPONIVEL };
  }
  return decidirTeto(count);
}
