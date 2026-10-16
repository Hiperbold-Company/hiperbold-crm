import "server-only";

/**
 * Lê os pagamentos reembolsáveis da organização (`fn_billing_reembolso_elegiveis`, migration 0957), a fonte única
 * da tela e da função que cria o pedido. Nunca lança: falha de leitura devolve `leituraFalhou` e lista vazia, e
 * a tela então não fala de reembolso (melhor calar que mostrar botão sem saber).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Logger } from "@/lib/agent-engine/obs/logger";

import type { PagamentoReembolsavel } from "./regras";

const LINHA = z.object({
  payment_id: z.string().uuid(),
  asaas_payment_id: z.string().min(1),
  amount_cents: z.number().int().positive(),
  paid_at: z.string().min(1),
  plano: z.string().nullable(),
  pacote: z.boolean(),
  pendente: z.boolean(),
  invoice_url: z.string().nullable().optional(),
  ambiente: z.enum(["sandbox", "producao"]).nullable().optional(),
});

export async function pagamentosReembolsaveis(
  admin: SupabaseClient,
  organizationId: string,
  log?: Logger,
): Promise<{ pagamentos: PagamentoReembolsavel[]; leituraFalhou: boolean }> {
  try {
    const { data, error } = await admin.rpc("fn_billing_reembolso_elegiveis" as never, {
      p_org: organizationId,
    } as never);
    if (error) throw new Error((error as { message: string }).message);
    const linhas = z.array(LINHA).parse(data ?? []);
    return {
      pagamentos: linhas.map((l) => ({
        paymentId: l.payment_id,
        asaasPaymentId: l.asaas_payment_id,
        amountCents: l.amount_cents,
        paidAt: l.paid_at,
        plano: l.plano,
        pacote: l.pacote,
        pendente: l.pendente,
        invoiceUrl: l.invoice_url ?? null,
        ambiente: l.ambiente ?? null,
      })),
      leituraFalhou: false,
    };
  } catch (err) {
    log?.error("reembolso_leitura_falhou", {
      organization_id: organizationId,
      erro: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return { pagamentos: [], leituraFalhou: true };
  }
}
