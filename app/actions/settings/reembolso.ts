"use server";

/**
 * O pedido de reembolso feito pelo PRÓPRIO CLIENTE (migration 0957, decisões do dono do produto de 15/10/2026).
 *
 * ─── O que a ação faz, e o que não faz ─────────────────────────────────────
 *
 * Não devolve dinheiro: grava o pedido (`fn_billing_reembolso_solicitar`) e avisa. O reembolso em si é feito por
 * uma pessoa, no Asaas, e quando o Asaas confirma o estorno (webhook `PAYMENT_REFUNDED`) o pedido fecha sozinho.
 *
 * ─── As regras moram no banco ──────────────────────────────────────────────
 *
 * Só com a assinatura CANCELADA, só o pagamento MAIS RECENTE e só até 7 dias dele (garantia / direito de
 * arrependimento do CDC), no relógio do banco. Esta ação confere sessão, papel e forma da entrada, aplica o teto
 * de tentativas, traduz o código de erro para uma frase fixa (o texto cru do Postgres nunca sai daqui) e
 * depois de gravar audita e enfileira os dois e-mails (COB-10 ao cliente, COB-11 ao financeiro).
 *
 * ─── Organização SEMPRE da sessão, só o papel `admin` ──────────────────────
 *
 * O `input` não tem organizationId: `resolveActiveOrg` é a única fonte. O papel é o mesmo de cancelar a
 * assinatura (`admin`); aqui não há atalho de admin da plataforma (ele resolve pedido pela tela do admin).
 * `supportWriteError` barra sessão de suporte em modo só leitura.
 *
 * ─── Auditoria sem dado sensível ───────────────────────────────────────────
 *
 * `billing.refund_requested` leva o id do pagamento no Asaas, o valor, a data, o motivo e se tem observação.
 * O texto livre nunca vai para a auditoria nem para o log.
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { authRateLimited } from "@/lib/auth/rate-limit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { MOTIVOS_DE_CANCELAMENTO, TAMANHO_MAXIMO_DO_DETALHE } from "@/lib/billing/reembolso/motivos";
import { criarAvisoDePedidoDeReembolsoSobre } from "@/lib/email/conta-e-cobranca/gatilhos-de-reembolso";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const MENSAGEM_SEM_PERMISSAO = "Você não tem permissão para pedir reembolso nesta organização.";
const MENSAGEM_SEM_ORGANIZACAO = "Nenhuma organização ativa nesta sessão.";
const MENSAGEM_DADOS_INVALIDOS = "Dados inválidos. Confira o formulário e tente de novo.";
const MENSAGEM_TENTATIVAS = "Muitas tentativas. Tente de novo mais tarde.";
const MENSAGEM_GENERICA = "Não foi possível registrar o pedido agora. Tente novamente em instantes ou fale com o suporte.";

/** O teto de pedidos por organização por dia (o banco repete o mesmo teto em `fn_billing_reembolso_solicitar`). */
const LIMITE_POR_ORGANIZACAO = { ip: 20, id: 5, windowSec: 24 * 60 * 60 };
const LIMITE_POR_USUARIO = { ip: 20, id: 10, windowSec: 60 * 60 };

const entradaSolicitarReembolso = z.object({
  paymentId: z.string().uuid("pagamento inválido"),
  detalhe: z.string().trim().max(TAMANHO_MAXIMO_DO_DETALHE).optional(),
});

const RESULTADO_DO_BANCO = z.object({
  id: z.string().uuid(),
  asaas_payment_id: z.string(),
  amount_cents: z.number().int().positive(),
  paid_at: z.string(),
  dentro_7_dias: z.boolean(),
  motivo: z.enum(MOTIVOS_DE_CANCELAMENTO),
  motivo_detalhe: z.string().nullable().optional(),
  plano: z.string().nullable().optional(),
  invoice_url: z.string().nullable().optional(),
  ambiente: z.enum(["sandbox", "producao"]).nullable().optional(),
});

export type ResultadoSolicitarReembolso = { tipo: "ok" } | { tipo: "erro"; mensagem: string };

/** O código de erro das funções SQL → a frase da tela. Código fora do vocabulário: log e frase genérica. */
function mensagemDoErro(error: { code?: string; message?: string } | null): string {
  const msg = error?.message ?? "";
  if (msg.includes("billing_reembolso_assinatura_nao_cancelada")) {
    return "Cancele a assinatura antes de pedir o reembolso.";
  }
  if (msg.includes("billing_reembolso_fora_do_prazo") || msg.includes("billing_reembolso_so_o_ultimo_pagamento")) {
    return "O prazo de 7 dias de garantia já passou, então não é possível pedir reembolso desta cobrança.";
  }
  if (msg.includes("billing_reembolso_ja_solicitado")) return "Já existe um pedido de reembolso em análise para este pagamento.";
  if (msg.includes("billing_reembolso_limite_diario")) return "Você chegou ao limite de pedidos de hoje. Tente amanhã.";
  if (msg.includes("billing_reembolso_pagamento_nao_elegivel")) return "Este pagamento não pode ser reembolsado.";
  if (msg.includes("billing_reembolso_detalhe_longo")) return MENSAGEM_DADOS_INVALIDOS;
  logger.error("[reembolso] erro ao registrar o pedido", { code: error?.code ?? null, message: error?.message ?? null });
  return MENSAGEM_GENERICA;
}

export async function solicitarReembolso(input: {
  paymentId: string;
  detalhe?: string;
}): Promise<ResultadoSolicitarReembolso> {
  const authUser = await loadAuthUser();
  if (!authUser) return { tipo: "erro", mensagem: MENSAGEM_SEM_PERMISSAO };
  if (supportWriteError(authUser.support)) return { tipo: "erro", mensagem: MENSAGEM_SEM_PERMISSAO };

  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { tipo: "erro", mensagem: MENSAGEM_SEM_ORGANIZACAO };
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) return { tipo: "erro", mensagem: MENSAGEM_SEM_PERMISSAO };

  const parsed = entradaSolicitarReembolso.safeParse(input);
  if (!parsed.success) return { tipo: "erro", mensagem: MENSAGEM_DADOS_INVALIDOS };

  if (
    (await authRateLimited("reembolso", authUser.id, LIMITE_POR_USUARIO)) ||
    (await authRateLimited("reembolso_org", activeOrg.orgId, LIMITE_POR_ORGANIZACAO))
  ) {
    return { tipo: "erro", mensagem: MENSAGEM_TENTATIVAS };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_reembolso_solicitar" as never, {
    p_org: activeOrg.orgId,
    p_actor: authUser.id,
    p_payment: parsed.data.paymentId,
    p_detalhe: parsed.data.detalhe ?? null,
  } as never);
  if (error) return { tipo: "erro", mensagem: mensagemDoErro(error as { code?: string; message?: string }) };

  const pedido = RESULTADO_DO_BANCO.safeParse(data);
  if (!pedido.success) {
    logger.error("[reembolso] resposta inesperada do banco ao registrar o pedido");
    return { tipo: "erro", mensagem: MENSAGEM_GENERICA };
  }
  const p = pedido.data;

  const hdrs = await headers();
  await audit({
    action: "billing.refund_requested",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    metadata: {
      pedido_id: p.id,
      pagamento_asaas: p.asaas_payment_id,
      amount_cents: p.amount_cents,
      paid_at: p.paid_at,
      dentro_7_dias: p.dentro_7_dias,
      motivo: p.motivo,
      com_observacao: Boolean(parsed.data.detalhe),
    },
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  });

  // Os avisos só enfileiram e nunca lançam: o pedido já está gravado.
  await criarAvisoDePedidoDeReembolsoSobre(admin)({
    organizationId: activeOrg.orgId,
    id: p.id,
    asaasPaymentId: p.asaas_payment_id,
    amountCents: p.amount_cents,
    paidAt: p.paid_at,
    dentro7Dias: p.dentro_7_dias,
    motivo: p.motivo,
    motivoDetalhe: p.motivo_detalhe ?? null,
    observacao: parsed.data.detalhe || null,
    plano: p.plano ?? null,
    invoiceUrl: p.invoice_url ?? null,
    ambiente: p.ambiente ?? null,
  });

  revalidatePath("/app/settings/plano");
  return { tipo: "ok" };
}
