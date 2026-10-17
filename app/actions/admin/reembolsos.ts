"use server";

/**
 * As ações do admin da PLATAFORMA sobre os pedidos de reembolso e os motivos de cancelamento (migration 0957,
 * fork Hiperbold): listar os dois e resolver um pedido (recusar, ou marcar como concluído quando o reembolso foi
 * feito fora do fluxo). O mesmo gate de `cupons.ts` e `cobrancaAsaas.ts`: `requirePlatformAdmin`, escopo `full` e
 * MFA em dia. Os pedidos mostram dado de cliente e valor, então o suporte só leitura nem vê a lista.
 *
 * `concluido` normalmente vem sozinho do webhook do Asaas (`PAYMENT_REFUNDED`); aqui o admin só o marca à mão
 * quando o reembolso foi feito por outro caminho. A regra mora no banco (`fn_billing_reembolso_resolver`); a
 * auditoria leva o pedido, a organização, o pagamento e o valor, nunca o texto livre do cliente.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { linkDaCobrancaNoAsaas } from "@/lib/billing/reembolso/link-asaas";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const MENSAGEM_MFA = "Confirme a verificação em duas etapas.";
const MENSAGEM_DADOS_INVALIDOS = "Dados inválidos.";
const MENSAGEM_GENERICA = "Não foi possível salvar. Tente de novo.";
const MENSAGEM_LEITURA = "Não foi possível carregar os pedidos.";
const MENSAGEM_SEM_ESCOPO = "Seu acesso de suporte não permite mexer nos pedidos de reembolso.";

const CAMINHO_DA_TELA = "/admin/sistema/reembolsos";
const LIMITE_DA_LISTA = 200;

const entradaResolver = z.object({
  pedidoId: z.string().uuid(),
  status: z.enum(["recusado", "concluido"]),
});

export interface PedidoDeReembolsoListado {
  id: string;
  organizationId: string;
  empresa: string;
  amountCents: number;
  paidAt: string;
  dentro7Dias: boolean;
  motivo: string;
  detalhe: string | null;
  status: "pendente" | "concluido" | "recusado";
  createdAt: string;
  resolvedAt: string | null;
  asaasPaymentId: string;
  /** O link da cobrança no Asaas, quando se sabe. */
  linkDoAsaas: string | null;
  /**
   * Só quando o pagamento é de um PACOTE de tokens: quanto o pacote deu e quanto da carteira avulsa da organização
   * já foi consumido. Quem decide reembolsar precisa saber se os tokens foram usados. A carteira avulsa é uma só por
   * organização (soma todos os pacotes), então `consumido` é o da carteira, não do pacote isolado.
   */
  pacote: { tokensDoPacote: number | null; creditadoAvulso: number | null; consumidoAvulso: number | null } | null;
}

export interface MotivoDeCancelamentoListado {
  id: string;
  organizationId: string;
  empresa: string;
  motivo: string;
  detalhe: string | null;
  createdAt: string;
}

async function contextoDaRequisicao() {
  const hdrs = await headers();
  return {
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  };
}

/** Gate do admin da plataforma: escopo `full` e MFA em dia. */
async function autorizarAdminDaPlataforma(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const { user, platformAdmin } = await requirePlatformAdmin();
  if (platformAdmin.scope !== "full") return { ok: false, error: MENSAGEM_SEM_ESCOPO };
  if (await mfaEmDivida()) return { ok: false, error: MENSAGEM_MFA };
  return { ok: true, userId: user.id };
}

async function nomesDasOrganizacoes(
  admin: ReturnType<typeof createAdminClient>,
  ids: string[],
): Promise<Map<string, string>> {
  const nomes = new Map<string, string>();
  if (ids.length === 0) return nomes;
  const { data, error } = await admin.from("organizations").select("id, display_name").in("id", ids);
  if (error) throw new Error(`organizations: ${error.message}`);
  for (const o of (data as { id: string; display_name: string | null }[] | null) ?? []) {
    // Nome da EMPRESA (organização), não de contato: o texto padrão é só para a lista do admin.
    const nome = typeof o.display_name === "string" ? o.display_name.trim() : "";
    nomes.set(o.id, nome.length > 0 ? nome : "Sem nome");
  }
  return nomes;
}

// ─── listarPedidosDeReembolso ───────────────────────────────────────────────

interface LinhaDoPedido {
  id: string;
  organization_id: string;
  order_id: string | null;
  asaas_payment_id: string;
  amount_cents: number;
  paid_at: string;
  dentro_7_dias: boolean;
  motivo: string;
  detalhe: string | null;
  status: "pendente" | "concluido" | "recusado";
  created_at: string;
  resolved_at: string | null;
}

/** Só leitura; sem auditoria. Os pendentes primeiro (do mais antigo, que espera há mais tempo), depois o resto. */
export async function listarPedidosDeReembolso(): Promise<
  { ok: true; pedidos: PedidoDeReembolsoListado[] } | { ok: false; error: string }
> {
  const gate = await autorizarAdminDaPlataforma();
  if (!gate.ok) return gate;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("billing_refund_requests" as never)
      .select("id, organization_id, order_id, asaas_payment_id, amount_cents, paid_at, dentro_7_dias, motivo, detalhe, status, created_at, resolved_at")
      .order("created_at", { ascending: false })
      .limit(LIMITE_DA_LISTA);
    if (error) throw new Error((error as { message: string }).message);
    const linhas = (data as unknown as LinhaDoPedido[] | null) ?? [];

    const nomes = await nomesDasOrganizacoes(admin, [...new Set(linhas.map((l) => l.organization_id))]);

    const idsDePedido = [...new Set(linhas.map((l) => l.order_id).filter((i): i is string => !!i))];
    const faturas = new Map<
      string,
      { invoice_url: string | null; ambiente: "sandbox" | "producao"; tipo: string | null; tokens: number | null }
    >();
    if (idsDePedido.length > 0) {
      const { data: pedidos, error: erroDosPedidos } = await admin
        .from("billing_orders")
        .select("id, invoice_url, ambiente, tipo, tokens")
        .in("id", idsDePedido);
      if (erroDosPedidos) throw new Error(`billing_orders: ${erroDosPedidos.message}`);
      for (const o of (pedidos as
        | { id: string; invoice_url: string | null; ambiente: "sandbox" | "producao"; tipo?: string | null; tokens?: number | null }[]
        | null) ?? []) {
        faturas.set(o.id, { invoice_url: o.invoice_url, ambiente: o.ambiente, tipo: o.tipo ?? null, tokens: o.tokens ?? null });
      }
    }

    // A carteira avulsa das organizações com pagamento de pacote: o consumo que o admin precisa ver antes de reembolsar.
    const orgsComPacote = [
      ...new Set(
        linhas.filter((l) => (l.order_id ? faturas.get(l.order_id)?.tipo === "pacote_tokens" : false)).map((l) => l.organization_id),
      ),
    ];
    const avulsas = new Map<string, { creditado: number; consumido: number }>();
    if (orgsComPacote.length > 0) {
      const { data: carteiras, error: erroDasCarteiras } = await admin
        .from("billing_token_wallets")
        .select("organization_id, creditado, consumido")
        .eq("fonte", "avulso")
        .in("organization_id", orgsComPacote);
      if (erroDasCarteiras) throw new Error(`billing_token_wallets: ${erroDasCarteiras.message}`);
      for (const c of (carteiras as { organization_id: string; creditado: number | string; consumido: number | string }[] | null) ?? []) {
        avulsas.set(c.organization_id, { creditado: Number(c.creditado), consumido: Number(c.consumido) });
      }
    }

    const lista: PedidoDeReembolsoListado[] = linhas.map((l) => {
      const fatura = l.order_id ? faturas.get(l.order_id) : undefined;
      return {
        id: l.id,
        organizationId: l.organization_id,
        empresa: nomes.get(l.organization_id) ?? "Sem nome",
        amountCents: l.amount_cents,
        paidAt: l.paid_at,
        dentro7Dias: l.dentro_7_dias,
        motivo: l.motivo,
        detalhe: l.detalhe,
        status: l.status,
        createdAt: l.created_at,
        resolvedAt: l.resolved_at,
        asaasPaymentId: l.asaas_payment_id,
        linkDoAsaas: linkDaCobrancaNoAsaas({
          asaasPaymentId: l.asaas_payment_id,
          invoiceUrl: fatura?.invoice_url ?? null,
          ambiente: fatura?.ambiente ?? null,
        }),
        pacote:
          fatura?.tipo === "pacote_tokens"
            ? {
                tokensDoPacote: fatura.tokens,
                creditadoAvulso: avulsas.get(l.organization_id)?.creditado ?? null,
                consumidoAvulso: avulsas.get(l.organization_id)?.consumido ?? null,
              }
            : null,
      };
    });
    // Pendentes primeiro, do que espera há mais tempo; o resto, do mais novo (a ordem do banco).
    const pendentes = lista.filter((p) => p.status === "pendente").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const resolvidos = lista.filter((p) => p.status !== "pendente");
    return { ok: true, pedidos: [...pendentes, ...resolvidos] };
  } catch (err) {
    logger.error("[reembolso] listar pedidos falhou", { erro: err instanceof Error ? err.message.slice(0, 200) : "erro" });
    return { ok: false, error: MENSAGEM_LEITURA };
  }
}

// ─── listarMotivosDeCancelamento ────────────────────────────────────────────

/** Só leitura. Os motivos mais recentes (até 200), com a empresa. */
export async function listarMotivosDeCancelamento(): Promise<
  { ok: true; motivos: MotivoDeCancelamentoListado[] } | { ok: false; error: string }
> {
  const gate = await autorizarAdminDaPlataforma();
  if (!gate.ok) return gate;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("billing_cancel_feedback" as never)
      .select("id, organization_id, motivo, detalhe, created_at")
      .order("created_at", { ascending: false })
      .limit(LIMITE_DA_LISTA);
    if (error) throw new Error((error as { message: string }).message);
    const linhas =
      (data as unknown as { id: string; organization_id: string; motivo: string; detalhe: string | null; created_at: string }[] | null) ?? [];
    const nomes = await nomesDasOrganizacoes(admin, [...new Set(linhas.map((l) => l.organization_id))]);
    return {
      ok: true,
      motivos: linhas.map((l) => ({
        id: l.id,
        organizationId: l.organization_id,
        empresa: nomes.get(l.organization_id) ?? "Sem nome",
        motivo: l.motivo,
        detalhe: l.detalhe,
        createdAt: l.created_at,
      })),
    };
  } catch (err) {
    logger.error("[reembolso] listar motivos falhou", { erro: err instanceof Error ? err.message.slice(0, 200) : "erro" });
    return { ok: false, error: MENSAGEM_LEITURA };
  }
}

// ─── resolverPedidoDeReembolso ──────────────────────────────────────────────

export async function resolverPedidoDeReembolso(input: {
  pedidoId: string;
  status: "recusado" | "concluido";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await autorizarAdminDaPlataforma();
  if (!gate.ok) return gate;

  const parsed = entradaResolver.safeParse(input);
  if (!parsed.success) return { ok: false, error: MENSAGEM_DADOS_INVALIDOS };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_billing_reembolso_resolver" as never, {
    p_request: parsed.data.pedidoId,
    p_status: parsed.data.status,
    p_actor: gate.userId,
  } as never);
  if (error) {
    const msg = (error as { message?: string }).message ?? "";
    if (msg.includes("billing_reembolso_ja_resolvido")) return { ok: false, error: "Este pedido já foi resolvido." };
    if (msg.includes("billing_reembolso_nao_encontrado")) return { ok: false, error: "Pedido não encontrado." };
    logger.error("[reembolso] resolver pedido falhou", { code: (error as { code?: string }).code ?? null });
    return { ok: false, error: MENSAGEM_GENERICA };
  }

  const r = data as { id: string; organization_id: string; asaas_payment_id: string; amount_cents: number; status_novo: string };
  const { requestId, ip, userAgent } = await contextoDaRequisicao();
  await audit({
    action: r.status_novo === "recusado" ? "billing.refund_rejected" : "billing.refund_marked_done",
    actorUserId: gate.userId,
    actingAsPlatformAdmin: true,
    organizationId: r.organization_id,
    resourceType: "billing_refund_request",
    resourceId: r.id,
    metadata: { pagamento_asaas: r.asaas_payment_id, amount_cents: r.amount_cents },
    requestId,
    ip,
    userAgent,
  });

  revalidatePath(CAMINHO_DA_TELA);
  return { ok: true };
}
