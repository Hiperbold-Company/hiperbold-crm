/**
 * Os gatilhos dos e-mails de cobrança do Asaas: COB-02 (plano confirmado), COB-03 (recibo), COB-05 (pagamento
 * não aprovado), COB-08 (estorno) e COB-09 (pacote liberado). Quem chama é o processador de eventos
 * (`lib/billing/asaas/processar-eventos.ts`), DENTRO do fluxo do evento e logo DEPOIS de
 * `fn_billing_asaas_aplicar_evento` ter gravado o efeito no banco: evento que falhou, ficou aguardando ou já
 * estava aplicado (`ja_aplicado`) nunca chega aqui com `resultado: "aplicado"`, e o que escapar ainda bate na
 * unicidade de `billing_emails_enviados`.
 *
 * O gatilho só ENFILEIRA (`fila.ts`): lê o estado do banco naquele instante (o do evento, não o de quando o
 * cron de envio rodar), guarda os números e as datas em `dados` e volta. Nenhum SMTP aqui. Quem envia, e tenta
 * de novo quando o servidor falha, é o cron `enviar-emails-de-conta` (`enviar.ts`).
 *
 * ─── O que cada evento dispara ──────────────────────────────────────────────
 *
 * PAYMENT_CONFIRMED / PAYMENT_RECEIVED / PAYMENT_RECEIVED_IN_CASH aplicado:
 *   - pedido de ASSINATURA que concedeu o período (a linha de `billing_payments` tem período): COB-02 (chave
 *     `pedido:<id>`) e COB-03. Cartão à vista e Pix: um recibo por pagamento (`pagamento:<id do Asaas>`).
 *     PARCELADO: UM recibo por pedido (`pedido:<id>`), com o total do parcelamento e "Cartão em Nx", sem a linha
 *     Parcela. A parcela seguinte de um pedido pago entra sem período e não dispara nada.
 *     O COB-02 leva `primeiraCompra` (nenhum OUTRO pedido da organização está `pago`): na primeira compra o
 *     e-mail é o de "sua conta está pronta" e o botão leva ao Início; nas seguintes, o de "plano ativo".
 *   - renovação do cartão (cobrança da assinatura, sem pedido): só o recibo (COB-02 já saiu na primeira vez).
 *   - pacote de tokens (B2): COB-09, pacote liberado (chave `pacote:<pedido>`, com cópia ao operador), com os
 *     tokens do pedido e o valor do pagamento. NÃO manda COB-03 junto: o COB-09 já mostra o valor pago. O
 *     pacote não tem validade no banco (cai no saldo avulso, sem ciclo), então o e-mail não promete data.
 *     Sobe só com o evento `aplicado`, que é o que gravou o crédito dos tokens na mesma transação.
 *
 * PAYMENT_OVERDUE: COB-05 só para a cobrança da ASSINATURA VIVA (renovação no cartão que venceu: o banco a fecha
 * como `ignorado`, `cobranca_de_renovacao`, com a organização e sem pedido), e só para quem JÁ PAGOU (existe pedido
 * de assinatura `pago` ou `estornado`; `current_period_end` NÃO serve, o período de avaliação também o grava):
 *   · o contrato tem período pago (`current_period_end`) e está `ativa` ou `atrasada`;
 *   · esse período já acabou ou acaba em até 1 dia (a cobrança de renovação vence no último dia de acesso e o
 *     Asaas só a marca vencida depois dele): cobrança vencida com o período vigente longe do fim é pagamento
 *     ADIANTADO e não manda nada;
 *   · se a cobrança traz a referência de um pedido, ele é de assinatura, do MESMO plano (mesmo `code`, pois o
 *     contrato aponta para a versão) e do mesmo ciclo do contrato.
 * PEDIDO que venceu sem pagar (`aplicado`) NÃO manda nada aqui (migration 1026): quem avisa é a régua de cobrança
 * (`regua-de-cobranca.ts`, cron `avisar-fatura-em-aberto`), com o link da fatura, que fica no Asaas até o prazo.
 * O COB-05 da assinatura viva leva o link da fatura (a da cobrança que venceu; a guardada no pedido só entra se ela
 * faltar).
 * "Acesso até" é o último dia da carência: `current_period_end + grace_days` (a mesma conta de
 * `fn_billing_conferir_vencimento`) menos um dia, porque o instante da suspensão já é o primeiro dia de leitura.
 * Carência que já passou não envia (a conta já está em modo só leitura; o aviso é o de conta suspensa, B2).
 * A recusa do cartão (`PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`) chega ao banco de eventos, mas o processador a
 * trata como evento sem GET (ignorado): não há objeto confirmado para o aviso, então ela NÃO dispara e a
 * cobrança que o Asaas desiste de cobrar chega como PAYMENT_OVERDUE.
 *
 * PAYMENT_REFUNDED aplicado com `estorno_confirmado`: COB-08 (chave `pagamento:<id>:estorno`), com o valor da
 * linha REFUNDED que o banco gravou. Estorno parcial (`PAYMENT_PARTIALLY_REFUNDED`) não dispara: o objeto
 * confirmado não traz o valor devolvido, e dizer um valor errado ao cliente é pior que não dizer.
 *
 * Esse mesmo estorno confirmado fecha como `concluido` o pedido de reembolso aberto do pagamento (migration 0957,
 * `gatilhos-de-reembolso.ts`), antes do e-mail.
 *
 * Quem recebe e a cópia do operador estão em `enviar.ts`. O botão leva ao app da instalação.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ultimoDiaDoPeriodo } from "@/lib/billing/assinatura/estado-da-assinatura";
import type { AvisosDeCobranca, EntradaDeAvisoDeCobranca } from "@/lib/billing/asaas/processar-eventos";
import type { CicloDoPlano, FormaDePagamento } from "@/lib/email/templates/_layout-transacional";
import { logger } from "@/lib/logger";

import { enfileirarEmailDeConta, type Enfileirador } from "./fila";
import { concluirPedidoDeReembolsoDoPagamento } from "./gatilhos-de-reembolso";
import { FATURA_DO_ASAAS } from "./montar";

const EVENTOS_DE_DINHEIRO = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_RECEIVED_IN_CASH"]);
const MS_POR_DIA = 24 * 60 * 60 * 1000;
/** Até quanto antes do fim do período uma cobrança vencida ainda é a renovação dele (e não pagamento adiantado). */
const MARGEM_DO_FIM_DO_PERIODO_MS = MS_POR_DIA;
const REFERENCIA_DE_PEDIDO = /^HC:ord:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface DepsDosGatilhos {
  /** Injetável nos testes. O padrão é o enfileiramento real. */
  enfileirar?: Enfileirador;
  agora?: () => Date;
}

interface LinhaDePagamento {
  id: string;
  order_id: string | null;
  contract_id: string;
  gross_cents: number;
  paid_at: string;
  billing_period_start: string | null;
  billing_period_end: string | null;
}

interface LinhaDePedido {
  id: string;
  tipo: string;
  plan_id: string | null;
  ciclo: string | null;
  metodo: string;
  amount_cents: number;
  parcelas: number;
  invoice_url: string | null;
  /** Tokens do pacote (só `pacote_tokens`). */
  tokens: number | string | null;
}

interface LinhaDeContrato {
  plan_id: string;
  status: string;
  cycle: string | null;
  current_period_end: string | null;
}

interface LinhaDePlano {
  code: string;
  name: string;
  grace_days: number;
}

async function ler<T>(
  consulta: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T | null> {
  const { data, error } = await consulta;
  if (error) throw new Error(error.message);
  return (data as T | null) ?? null;
}

async function lerLista<T>(
  consulta: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const { data, error } = await consulta;
  if (error) throw new Error(error.message);
  return (data as T[] | null) ?? [];
}

function cicloValido(ciclo: string | null | undefined): CicloDoPlano {
  return ciclo === "semiannual" || ciclo === "yearly" ? ciclo : "monthly";
}

function formaDoPedido(pedido: Pick<LinhaDePedido, "metodo" | "parcelas"> | null): FormaDePagamento {
  if (pedido && pedido.parcelas > 1) return { tipo: "cartao_parcelado", parcelas: pedido.parcelas };
  if (pedido?.metodo === "PIX") return { tipo: "pix" };
  return { tipo: "cartao" };
}

/** O último dia de acesso de um período cujo fim é exclusivo, como ISO. */
function ultimoDia(fimExclusivo: string): string {
  return ultimoDiaDoPeriodo(fimExclusivo).toISOString();
}

export function criarAvisosDeCobrancaSobre(admin: SupabaseClient, deps: DepsDosGatilhos = {}): AvisosDeCobranca {
  const enfileirar = deps.enfileirar ?? ((entrada) => enfileirarEmailDeConta(entrada, admin));
  const agora = deps.agora ?? (() => new Date());

  const plano = (id: string) =>
    ler<LinhaDePlano>(
      admin.from("billing_plans").select("code, name, grace_days").eq("id", id).maybeSingle() as never,
    );
  const contrato = (organizationId: string) =>
    ler<LinhaDeContrato>(
      admin
        .from("billing_contracts")
        .select("plan_id, status, cycle, current_period_end")
        .eq("organization_id", organizationId)
        .maybeSingle() as never,
    );
  const pedido = (organizationId: string, id: string) =>
    ler<LinhaDePedido>(
      admin
        .from("billing_orders")
        .select("id, tipo, plan_id, ciclo, metodo, amount_cents, parcelas, invoice_url, tokens")
        .eq("id", id)
        .eq("organization_id", organizationId)
        .maybeSingle() as never,
    );

  /**
   * Pedidos de assinatura que já foram pagos (`pago`, ou `estornado`: pagou um dia). É a pergunta "esta organização
   * já pagou?" do COB-02 (primeira compra) e do COB-05 (renovação ou assinatura nunca concluída). Limite 2 basta
   * para saber se existe algum OUTRO além do pedido do evento.
   */
  const assinaturasPagas = (organizationId: string) =>
    lerLista<{ id: string }>(
      admin
        .from("billing_orders")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("tipo", "assinatura")
        .in("status", ["pago", "estornado"])
        .limit(2) as never,
    );

  /** COB-09: o pagamento do pedido de pacote foi aplicado e os tokens já estão no saldo. Sem recibo (COB-03). */
  async function pacoteLiberado(
    organizationId: string,
    pagamento: LinhaDePagamento,
    doPedido: LinhaDePedido,
  ): Promise<void> {
    const tokens = Number(doPedido.tokens);
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    await enfileirar({
      organizationId,
      emailId: "COB-09",
      chave: `pacote:${doPedido.id}`,
      destino: "admins",
      copiaParaOperador: true,
      dados: { tokens, valorPago: pagamento.gross_cents },
    });
  }

  async function pagamentoAplicado(e: EntradaDeAvisoDeCobranca, organizationId: string): Promise<void> {
    if (!e.idDoPagamento) return;
    const pagamento = await ler<LinhaDePagamento>(
      admin
        .from("billing_payments")
        .select("id, order_id, contract_id, gross_cents, paid_at, billing_period_start, billing_period_end")
        .eq("asaas_payment_id", e.idDoPagamento)
        .eq("organization_id", organizationId)
        .maybeSingle() as never,
    );
    if (!pagamento) return;

    const doPedido = pagamento.order_id ? await pedido(organizationId, pagamento.order_id) : null;
    if (doPedido?.tipo === "pacote_tokens") {
      await pacoteLiberado(organizationId, pagamento, doPedido);
      return;
    }
    // Parcela seguinte de um pedido pago (sem período) não repete nada.
    if (doPedido && doPedido.tipo !== "assinatura") return;
    if (!pagamento.billing_period_start || !pagamento.billing_period_end) return;

    const doContrato = await contrato(organizationId);
    if (!doContrato) return;
    const planoId = doPedido?.plan_id ?? doContrato.plan_id;
    const doPlano = await plano(planoId);
    if (!doPlano) return;

    const ciclo = cicloValido(doPedido?.ciclo ?? doContrato.cycle);
    const forma = doPedido ? formaDoPedido(doPedido) : ({ tipo: "cartao" } as const);
    const parcelado = forma.tipo === "cartao_parcelado";
    const acessoAte = doContrato.current_period_end
      ? ultimoDia(doContrato.current_period_end)
      : ultimoDia(pagamento.billing_period_end);

    // COB-02: só na compra (pedido). A renovação do cartão não tem pedido e não repete o "plano ativo".
    if (doPedido) {
      // Primeira compra: nenhum OUTRO pedido de ASSINATURA da organização foi pago (o deste já foi marcado `pago`
      // pelo banco). Conta `pago` e `estornado` (um estornado foi pago um dia: quem reassina não é cliente novo) e
      // só o tipo `assinatura`: um pacote de tokens comprado antes não faz da primeira assinatura uma "segunda".
      const pagos = await assinaturasPagas(organizationId);
      const primeiraCompra = !pagos.some((p) => p.id !== doPedido.id);
      await enfileirar({
        organizationId,
        emailId: "COB-02",
        chave: `pedido:${doPedido.id}`,
        destino: "admins",
        copiaParaOperador: true,
        dados: { plano: doPlano.name, ciclo, forma, acessoAte, primeiraCompra },
      });
    }

    // COB-03: um por pagamento; no parcelado, um por pedido, com o total e sem a linha Parcela.
    await enfileirar({
      organizationId,
      emailId: "COB-03",
      chave: parcelado && doPedido ? `pedido:${doPedido.id}` : `pagamento:${e.idDoPagamento}`,
      destino: "admins",
      copiaParaOperador: false,
      dados: {
        valor: parcelado && doPedido ? doPedido.amount_cents : pagamento.gross_cents,
        pagoEm: pagamento.paid_at,
        plano: doPlano.name,
        periodoInicio: pagamento.billing_period_start,
        periodoFim: ultimoDia(pagamento.billing_period_end),
        forma,
      },
    });
  }

  async function pagamentoNaoAprovado(e: EntradaDeAvisoDeCobranca, organizationId: string): Promise<void> {
    if (!e.idDoPagamento || !e.cobranca) return;
    // 1026: `aplicado` é PEDIDO que venceu. A fatura fica no Asaas e quem avisa é a régua de cobrança
    // (`regua-de-cobranca.ts`), com o link, nos marcos dela: nada sai daqui. Só a cobrança da assinatura viva
    // (`ignorado` com a organização, sem pedido vencido) segue neste caminho.
    if (e.resultado !== "ignorado") return;

    // A REGRA (o cabeçalho do arquivo explica o porquê de cada corte). "Já pagou" é pedido de assinatura pago, nunca
    // `current_period_end`: o período de avaliação também o grava. Quem nunca pagou não tem renovação a avisar.
    const jaPagou = (await assinaturasPagas(organizationId)).length > 0;
    if (!jaPagou) return;
    const doContrato = await contrato(organizationId);

    const idDoPedido = REFERENCIA_DE_PEDIDO.exec(e.cobranca.externalReference ?? "")?.[1] ?? null;
    const doPedido = idDoPedido ? await pedido(organizationId, idDoPedido) : null;
    // Pacote de tokens (e qualquer pedido que não seja assinatura) não é assinatura nem renovação.
    if (doPedido && (doPedido.tipo !== "assinatura" || !doPedido.plan_id)) return;

    const valor = Math.round(e.cobranca.valorConfirmado * 100);

    if (!doContrato?.current_period_end) return;
    if (doContrato.status !== "ativa" && doContrato.status !== "atrasada") return;
    // Pagamento ADIANTADO: com o período vigente longe do fim, a cobrança vencida não é a renovação dele.
    const fimDoPeriodo = new Date(doContrato.current_period_end).getTime();
    if (fimDoPeriodo > agora().getTime() + MARGEM_DO_FIM_DO_PERIODO_MS) return;

    const doPlano = await plano(doContrato.plan_id);
    if (!doPlano) return;

    if (doPedido) {
      // Só o pedido de assinatura do MESMO plano e do MESMO ciclo é a renovação (o contrato aponta para a
      // versão do plano, então a comparação é pelo `code`). Troca de plano ou de ciclo abandonada não é.
      const planoDoPedido = doPedido.plan_id === doContrato.plan_id ? doPlano : await plano(doPedido.plan_id!);
      if (!planoDoPedido || planoDoPedido.code !== doPlano.code) return;
      if (doContrato.cycle && doPedido.ciclo && doPedido.ciclo !== doContrato.cycle) return;
    }

    const fimDaCarencia = new Date(fimDoPeriodo + doPlano.grace_days * MS_POR_DIA);
    if (fimDaCarencia.getTime() <= agora().getTime()) return;
    const acessoAte = ultimoDiaDoPeriodo(fimDaCarencia).toISOString();

    // A cobrança da assinatura viva continua no Asaas (o CRM não a remove). O link da cobrança que venceu e o do
    // pedido passam pela mesma regra (https no domínio do Asaas); fora dela, sem link. A cobrança que venceu vale
    // mais: é a que o cliente vai pagar.
    const fatura =
      [e.cobranca.invoiceUrl, doPedido?.invoice_url].find((u): u is string => !!u && FATURA_DO_ASAAS.test(u)) ?? null;

    await enfileirar({
      organizationId,
      emailId: "COB-05",
      chave: `pagamento:${e.idDoPagamento}`,
      destino: "admins",
      copiaParaOperador: true,
      dados: {
        plano: doPlano.name,
        valor,
        acessoAte,
        faturaUrl: fatura,
      },
    });
  }

  async function estorno(e: EntradaDeAvisoDeCobranca, organizationId: string): Promise<void> {
    if (!e.idDoPagamento) return;
    const original = await ler<LinhaDePagamento>(
      admin
        .from("billing_payments")
        .select("id, order_id, contract_id, gross_cents, paid_at, billing_period_start, billing_period_end")
        .eq("asaas_payment_id", e.idDoPagamento)
        .eq("organization_id", organizationId)
        .maybeSingle() as never,
    );
    if (!original) return;
    const devolvido = await ler<{ gross_cents: number; created_at: string }>(
      admin
        .from("billing_payments")
        .select("gross_cents, created_at")
        .eq("estorna_pagamento_id", original.id)
        .eq("organization_id", organizationId)
        .eq("status", "REFUNDED")
        .maybeSingle() as never,
    );
    if (!devolvido) return;

    const doPedido = original.order_id ? await pedido(organizationId, original.order_id) : null;
    const doContrato = await contrato(organizationId);
    const planoId = doPedido?.plan_id ?? doContrato?.plan_id ?? null;
    const doPlano = planoId ? await plano(planoId) : null;
    const ehPacote = doPedido?.tipo === "pacote_tokens";
    if (!ehPacote && !doPlano) return;

    await enfileirar({
      organizationId,
      emailId: "COB-08",
      chave: `pagamento:${e.idDoPagamento}:estorno`,
      destino: "admins",
      copiaParaOperador: true,
      dados: {
        valor: devolvido.gross_cents,
        // `null` = estorno de pacote de tokens; o nome sai em texto, no idioma de quem lê, na hora do envio.
        plano: ehPacote ? null : doPlano!.name,
        estornadoEm: devolvido.created_at,
      },
    });
  }

  return {
    async aoAplicar(e) {
      if (!e.organizationId) return;
      try {
        if (EVENTOS_DE_DINHEIRO.has(e.eventType)) {
          if (e.resultado === "aplicado") await pagamentoAplicado(e, e.organizationId);
        } else if (e.eventType === "PAYMENT_OVERDUE") {
          await pagamentoNaoAprovado(e, e.organizationId);
        } else if (
          e.eventType === "PAYMENT_REFUNDED" &&
          e.resultado === "aplicado" &&
          e.alarmes.includes("estorno_confirmado")
        ) {
          // O pedido de reembolso do cliente (0957) fecha como concluído; falha dele não impede o e-mail abaixo.
          if (e.idDoPagamento) await concluirPedidoDeReembolsoDoPagamento(admin, e.organizationId, e.idDoPagamento);
          await estorno(e, e.organizationId);
        }
      } catch (erro) {
        // O efeito no banco já foi gravado: o aviso nunca desfaz nem atrasa o processamento.
        logger.warn("[email-de-cobranca] o gatilho falhou", {
          organization_id: e.organizationId,
          evento: e.eventType,
          motivo: erro instanceof Error ? erro.message.slice(0, 120) : "erro",
        });
      }
    },
  };
}
