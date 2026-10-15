/**
 * O pedido de assinatura que o passo "Plano" do wizard precisa RETOMAR quando a pessoa volta à tela:
 * o Pix que ainda não foi pago, o cartão que o Asaas ainda não confirmou, ou o pagamento já
 * confirmado cujo contrato ainda não virou ativo (o webhook marca o pedido e o contrato em
 * sequência).
 *
 * Sem isto, recarregar a página perdia o QR e o formulário de compra voltava, convidando a abrir
 * outro pedido. O pedido aberto é único por organização e tipo (índice da migration 0909); a
 * compra, ao ser repetida, retoma o mesmo. Esta leitura só diz O QUE mostrar — quem cria, retoma e
 * confirma pedido continua sendo `lib/billing/asaas/compra.ts` e o webhook.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { situacaoDoPedido } from "./situacao-do-pedido";

export interface PedidoDaAssinatura {
  id: string;
  status: string;
  metodo: "CREDIT_CARD" | "PIX";
  /** A fatura do Asaas (tem o QR do Pix e o formulário do cartão); `null` enquanto não existe cobrança. */
  invoiceUrl: string | null;
  /** `billing_orders.created_at` (ISO 8601): decide se o pedido aberto está parado (`podeEscolherOutraForma`). */
  criadoEm: string | null;
}

/** Estados que o passo mostra: os abertos e o `pago`. Falhou, vencido, cancelado e estornado voltam ao formulário. */
const STATUS_QUE_O_PASSO_MOSTRA = ["criado", "processando", "aguardando_pagamento", "inconclusivo", "pago"];

/** O pedido de assinatura mais recente que o passo mostra, ou `null`. Nunca lança. */
export async function pedidoDaAssinatura(
  admin: SupabaseClient,
  organizationId: string,
  ambiente: "sandbox" | "producao",
): Promise<PedidoDaAssinatura | null> {
  try {
    const { data, error } = await admin
      .from("billing_orders")
      .select("id, status, metodo, invoice_url, created_at")
      .eq("organization_id", organizationId)
      .eq("tipo", "assinatura")
      .eq("ambiente", ambiente)
      .in("status", STATUS_QUE_O_PASSO_MOSTRA)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const linha = data as {
      id: string;
      status: string;
      metodo: string;
      invoice_url: string | null;
      created_at?: string | null;
    } | null;
    if (!linha || situacaoDoPedido(linha.status) === "encerrado") return null;
    return {
      id: linha.id,
      status: linha.status,
      metodo: linha.metodo === "PIX" ? "PIX" : "CREDIT_CARD",
      invoiceUrl: linha.invoice_url,
      criadoEm: linha.created_at ?? null,
    };
  } catch (err) {
    logger.error("alarme_onboarding_pedido_da_assinatura", {
      organization_id: organizationId,
      erro: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return null;
  }
}
