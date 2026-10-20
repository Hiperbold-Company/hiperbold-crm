import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";

/** `crm_lead_activities.source_module` das linhas que nascem dos itens do negócio. */
export const ORIGEM_DOS_ITENS = "crm";

/** "2 × Consulta" / "1,5 × Hora técnica" — o que a linha do tempo diz, sem valor em dinheiro. */
export function descricaoDaQuantidade(quantidade: number, nome: string): string {
  const q = Number.isInteger(quantidade) ? String(quantidade) : String(quantidade).replace(".", ",");
  return `${q} × ${nome}`;
}

/**
 * Registra "Produto adicionado/removido" na linha do tempo do negócio.
 *
 * ⚠️ O `reason` nomeia o produto e a quantidade, NUNCA o valor: ele é renderizado
 * na tela e vai junto em captura e exportação; o valor mora no `api_audit_log`,
 * sob controle de acesso (mesma régua de `lead_edited`). Falha de escrita é
 * contada (`registraFalhaDeAtividade`) e não derruba a operação que ela descreve.
 */
export async function registrarAtividadeDeItem(
  supabase: SupabaseClient,
  input: {
    tipo: "lead_product_added" | "lead_product_removed";
    organizationId: string;
    leadId: string;
    contactId: string | null;
    actor: Actor;
    produtoId: string | null;
    nome: string;
    quantidade: number;
    requestId: string;
  },
): Promise<void> {
  const resultado = await emitLeadActivity(supabase, {
    organizationId: input.organizationId,
    leadId: input.leadId,
    contactId: input.contactId,
    type: input.tipo,
    sourceModule: ORIGEM_DOS_ITENS,
    sourceId: input.produtoId,
    actor: input.actor,
    reason:
      (input.tipo === "lead_product_added" ? "Adicionou " : "Removeu ") +
      descricaoDaQuantidade(input.quantidade, input.nome),
    payload: { product_id: input.produtoId, nome: input.nome, quantidade: input.quantidade },
  });
  if (!resultado.ok) {
    await registraFalhaDeAtividade(supabase, {
      organizationId: input.organizationId,
      leadId: input.leadId,
      tipo: input.tipo,
      origem: "leads/[id]/itens",
      erro: resultado.error,
      requestId: input.requestId,
    });
  }
}
