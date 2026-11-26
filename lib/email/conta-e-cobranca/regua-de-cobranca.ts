/**
 * A RÉGUA DE COBRANÇA do pedido de assinatura não pago (migration 1026): o COB-05 com o link da fatura, enquanto ela
 * existe no Asaas.
 *
 * ─── Por quê ────────────────────────────────────────────────────────────────
 *
 * Caso real: pedido no cartão em 10/11, vencimento 13/11, o cliente abriu o checkout e não pagou. No
 * PAYMENT_OVERDUE a fatura era apagada no Asaas e saía um e-mail só, sem link; a conta foi suspensa em 20/11 sem o
 * cliente ter por onde pagar. Agora a fatura fica no Asaas até o prazo, e esta régua avisa com o botão "Pagar agora".
 *
 * ─── Quem entra e quando ────────────────────────────────────────────────────
 *
 * O banco decide (`fn_billing_regua_de_cobranca_pendentes`, sobre `fn_billing_pedidos_de_assinatura_em_aberto`):
 * pedido de assinatura `aguardando_pagamento` ou `vencido`, organização ativa, com o marco de hoje ainda não
 * enfileirado. Marcos, em datas de São Paulo: 2 dias antes do vencimento, no dia, 2 dias depois e 1 dia antes do
 * limite (a suspensão da assinatura, quando o pedido é o que a mantém; senão o último dia da fatura no Asaas, em
 * vencimento + carência do plano do pedido). Sai só o marco mais recente (carência curta junta marcos), nunca no
 * dia em que o pedido nasceu. Chave `pedido:<id>:<marco>`: cada marco sai uma vez.
 *
 * ─── O GET antes de enfileirar ──────────────────────────────────────────────
 *
 * Um GET no Asaas por pedido, só quando há marco a enfileirar (ou vencimento a gravar): a cobrança paga (o evento
 * ainda não chegou) não recebe aviso, a removida também não, e o link que vai no e-mail é o que o Asaas devolve
 * agora, conferido por `FATURA_DO_ASAAS`. O `dueDate` lido vence o gravado (`fn_billing_pedido_gravar_vencimento`)
 * e o marco é recalculado com ele. Pedido anterior à 1026 (sem `vence_em`) ganha a data aqui.
 *
 * ─── Só enfileira ───────────────────────────────────────────────────────────
 *
 * Como o COB-04 (`renovacao-no-cartao.ts`): a rodada enfileira (`fila.ts`) e o cron `enviar-emails-de-conta` envia.
 * Destino: os admins da organização, com cópia ao operador. Orçamento de tempo próprio; o que não couber fica para
 * a rodada seguinte (o marco continua valendo até o próximo). Nunca lança por um pedido: só o erro de LISTAR sobe.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClienteAsaasHttp } from "@/lib/billing/asaas/cliente";
import type { AmbienteAsaas } from "@/lib/billing/asaas/config";
import type { CobrancaAsaas } from "@/lib/billing/asaas/contratos";
import { logger } from "@/lib/logger";
import { ehOperante } from "@/lib/organizacao/operante";

import { enfileirarEmailDeConta, type Enfileirador } from "./fila";
import { FATURA_DO_ASAAS } from "./montar";

/** Quantos pedidos uma rodada examina. */
const TAMANHO_DO_LOTE = 300;
/** Quanto a rodada trabalha antes de parar (teto do curl no scheduler: 120 s). */
export const ORCAMENTO_DA_RODADA_MS = 90_000;

const STATUS_PAGO = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);
const STATUS_EM_ABERTO = new Set(["PENDING", "OVERDUE"]);

export type MarcoDaRegua = "antes" | "no_dia" | "depois" | "ultimo_dia";

/** Uma linha de `fn_billing_regua_de_cobranca_pendentes` (e de `fn_billing_pedidos_de_assinatura_em_aberto`). */
export interface PedidoDaRegua {
  pedido_id: string;
  organization_id: string;
  ambiente: string;
  status: string;
  plan_id: string;
  asaas_payment_id: string | null;
  asaas_subscription_id: string | null;
  asaas_installment_id: string | null;
  invoice_url: string | null;
  vence_em: string;
  vence_em_gravado: boolean;
  limite: "suspensao" | "remocao";
  limite_em: string;
  marco: MarcoDaRegua | null;
  marco_em: string | null;
}

export interface DepsDaRegua {
  asaas: ClienteAsaasHttp;
  /** O ambiente do cliente Asaas desta instalação: pedido de outro ambiente é pulado. */
  ambiente: AmbienteAsaas;
  /** Injetável nos testes. O padrão é o enfileiramento real. */
  enfileirar?: Enfileirador;
  agora?: () => Date;
  /** Orçamento de tempo da rodada, em ms. */
  orcamentoMs?: number;
}

export interface ResumoDaRegua {
  /** Pedidos que o banco listou. */
  avaliados: number;
  /** Avisos que entraram na fila agora. */
  enfileirados: number;
  /** A chave já estava na fila: nada novo. */
  jaAvisados: number;
  /** A cobrança já foi paga no Asaas (o evento ainda vai chegar): sem aviso. */
  pagos: number;
  /** A cobrança não existe mais, não está em aberto ou não tem link válido: sem aviso. */
  semFatura: number;
  /** Depois de gravar o vencimento lido no Asaas, nenhum marco vale hoje. */
  foraDoMarco: number;
  /** Vencimentos gravados ou corrigidos com a data do Asaas. */
  vencimentosGravados: number;
  /** Organização parada (régua única de `@/lib/organizacao/operante`; o banco já filtra, isto confere de novo). */
  orgParada: number;
  /** Pedido de outro ambiente do Asaas (sandbox x produção): o cliente desta instalação não o alcança. */
  outroAmbiente: number;
  /** Plano sem nome ou falha de banco, de GET ou da fila. */
  falhas: number;
  /** Pedidos que o orçamento de tempo deixou para a próxima rodada. */
  restantes: number;
}

function rpcLista<T>(resposta: { data: unknown; error: { message: string } | null }, onde: string): T[] {
  if (resposta.error) throw new Error(`${onde}: ${resposta.error.message}`);
  return (resposta.data as T[] | null) ?? [];
}

/** A primeira cobrança em aberto (menor vencimento) de uma lista, ou a paga, se houver. */
function escolherDaLista(cobrancas: CobrancaAsaas[]): CobrancaAsaas | null {
  const pagas = cobrancas.filter((c) => STATUS_PAGO.has(c.status));
  if (pagas.length > 0) return pagas[0]!;
  const abertas = cobrancas
    .filter((c) => STATUS_EM_ABERTO.has(c.status))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return abertas[0] ?? null;
}

/** O que o Asaas tem agora da cobrança do pedido, ou `null` quando ela não existe mais. */
async function lerCobrancaDoPedido(asaas: ClienteAsaasHttp, p: PedidoDaRegua): Promise<CobrancaAsaas | null> {
  if (p.asaas_payment_id) {
    const c = await asaas.buscarCobranca(p.asaas_payment_id);
    return "removido" in c ? null : c;
  }
  if (p.asaas_subscription_id) return escolherDaLista(await asaas.listarCobrancasDaAssinatura(p.asaas_subscription_id));
  if (p.asaas_installment_id) return escolherDaLista(await asaas.listarCobrancasDoParcelamento(p.asaas_installment_id));
  return null;
}

export async function avisarFaturasEmAberto(admin: SupabaseClient, deps: DepsDaRegua): Promise<ResumoDaRegua> {
  const enfileirar = deps.enfileirar ?? ((entrada) => enfileirarEmailDeConta(entrada, admin));
  const relogio = deps.agora ?? (() => new Date());
  const agora = relogio();
  const orcamentoMs = deps.orcamentoMs ?? ORCAMENTO_DA_RODADA_MS;
  const resumo: ResumoDaRegua = {
    avaliados: 0,
    enfileirados: 0,
    jaAvisados: 0,
    pagos: 0,
    semFatura: 0,
    foraDoMarco: 0,
    vencimentosGravados: 0,
    orgParada: 0,
    outroAmbiente: 0,
    falhas: 0,
    restantes: 0,
  };

  const pedidos = rpcLista<PedidoDaRegua>(
    await admin.rpc("fn_billing_regua_de_cobranca_pendentes" as never, {
      p_agora: agora.toISOString(),
      p_limite: TAMANHO_DO_LOTE,
    } as never),
    "fn_billing_regua_de_cobranca_pendentes",
  );
  resumo.avaliados = pedidos.length;
  if (pedidos.length >= TAMANHO_DO_LOTE) {
    logger.warn("[regua-de-cobranca] lote cheio, o resto fica para a próxima rodada", { limite: TAMANHO_DO_LOTE });
  }

  // "Já pagou" por organização, lido uma vez por rodada: muda só o texto (concluir a assinatura x manter o plano).
  const jaPagouPorOrg = new Map<string, boolean>();
  const nomeDoPlano = new Map<string, string | null>();
  const operantePorOrg = new Map<string, boolean>();

  for (const [i, inicial] of pedidos.entries()) {
    if (relogio().getTime() - agora.getTime() > orcamentoMs) {
      resumo.restantes = pedidos.length - i;
      logger.warn("[regua-de-cobranca] orçamento de tempo esgotado, o resto fica para a próxima rodada", {
        restantes: resumo.restantes,
      });
      break;
    }
    try {
      if (inicial.ambiente !== deps.ambiente) {
        resumo.outroAmbiente++;
        continue;
      }

      if (!operantePorOrg.has(inicial.organization_id)) {
        const { data, error } = await admin
          .from("organizations")
          .select("status")
          .eq("id", inicial.organization_id)
          .maybeSingle();
        if (error) throw new Error(`organizations: ${error.message}`);
        operantePorOrg.set(inicial.organization_id, ehOperante((data as { status: string } | null)?.status));
      }
      if (!operantePorOrg.get(inicial.organization_id)) {
        resumo.orgParada++;
        continue;
      }

      const cobranca = await lerCobrancaDoPedido(deps.asaas, inicial);
      if (cobranca && STATUS_PAGO.has(cobranca.status)) {
        resumo.pagos++;
        continue;
      }
      if (!cobranca || !STATUS_EM_ABERTO.has(cobranca.status)) {
        resumo.semFatura++;
        continue;
      }

      // O vencimento lido no Asaas vale mais que o gravado: grava e recalcula o marco com ele.
      let pedido = inicial;
      if (!inicial.vence_em_gravado || cobranca.dueDate !== inicial.vence_em) {
        const gravado = await admin.rpc("fn_billing_pedido_gravar_vencimento" as never, {
          p_org: inicial.organization_id,
          p_pedido: inicial.pedido_id,
          p_vence_em: cobranca.dueDate,
        } as never);
        if (gravado.error) throw new Error(`fn_billing_pedido_gravar_vencimento: ${gravado.error.message}`);
        if (gravado.data === true) resumo.vencimentosGravados++;
        const relido = rpcLista<PedidoDaRegua>(
          await admin.rpc("fn_billing_pedidos_de_assinatura_em_aberto" as never, {
            p_agora: agora.toISOString(),
            p_org: inicial.organization_id,
            p_pedido: inicial.pedido_id,
          } as never),
          "fn_billing_pedidos_de_assinatura_em_aberto",
        )[0];
        if (!relido) {
          resumo.semFatura++;
          continue;
        }
        pedido = relido;
      }
      if (!pedido.marco) {
        resumo.foraDoMarco++;
        continue;
      }

      const fatura = [cobranca.invoiceUrl, pedido.invoice_url].find((u): u is string => !!u && FATURA_DO_ASAAS.test(u));
      if (!fatura) {
        resumo.semFatura++;
        continue;
      }

      if (!nomeDoPlano.has(pedido.plan_id)) {
        const { data, error } = await admin.from("billing_plans").select("name").eq("id", pedido.plan_id).maybeSingle();
        if (error) throw new Error(`billing_plans: ${error.message}`);
        nomeDoPlano.set(pedido.plan_id, (data as { name: string } | null)?.name ?? null);
      }
      const plano = nomeDoPlano.get(pedido.plan_id);
      if (!plano) {
        resumo.falhas++;
        continue;
      }

      if (!jaPagouPorOrg.has(pedido.organization_id)) {
        const { data, error } = await admin
          .from("billing_orders")
          .select("id")
          .eq("organization_id", pedido.organization_id)
          .eq("tipo", "assinatura")
          .in("status", ["pago", "estornado"])
          .limit(1);
        if (error) throw new Error(`billing_orders: ${error.message}`);
        jaPagouPorOrg.set(pedido.organization_id, ((data as unknown[] | null) ?? []).length > 0);
      }

      const r = await enfileirar({
        organizationId: pedido.organization_id,
        emailId: "COB-05",
        chave: `pedido:${pedido.pedido_id}:${pedido.marco}`,
        destino: "admins",
        copiaParaOperador: true,
        dados: {
          plano,
          valor: Math.round(cobranca.valorConfirmado * 100),
          faturaUrl: fatura,
          nuncaPagou: !jaPagouPorOrg.get(pedido.organization_id),
          marco: pedido.marco,
          venceEm: pedido.vence_em,
          limite: pedido.limite,
          limiteEm: pedido.limite_em,
        },
      });
      if (r === "enfileirado") resumo.enfileirados++;
      else if (r === "ja_existia") resumo.jaAvisados++;
      else resumo.falhas++;
    } catch (erro) {
      resumo.falhas++;
      logger.warn("[regua-de-cobranca] pedido falhou, rodada segue", {
        organization_id: inicial.organization_id,
        motivo: erro instanceof Error ? erro.message.slice(0, 120) : "erro",
      });
    }
  }

  return resumo;
}
