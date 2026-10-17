/**
 * As regras do pedido de reembolso do cliente (migration 0957), puras e sem banco: quando a tela mostra o botão
 * "Solicitar reembolso", quando mostra o aviso de prazo vencido e quando o pedido já está em análise.
 *
 * O banco é quem decide DE VERDADE (`fn_billing_reembolso_solicitar` recusa assinatura não cancelada, pagamento
 * que não é o mais recente e prazo vencido, no relógio dele); estas funções só dizem à tela o que mostrar, com a
 * mesma regra, para ninguém clicar num botão que o servidor vai recusar.
 *
 * Decisão do dono do produto (15/10/2026): só há reembolso nos 7 dias de garantia (direito de arrependimento do
 * CDC), só do pagamento mais recente e só depois de cancelar a assinatura. Fora dos 7 dias não existe botão.
 */
export const PRAZO_DA_GARANTIA_EM_DIAS = 7;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Um pagamento que pode ser reembolsado (o que `fn_billing_reembolso_elegiveis` devolve). */
export interface PagamentoReembolsavel {
  paymentId: string;
  asaasPaymentId: string;
  amountCents: number;
  /** ISO. */
  paidAt: string;
  /** O nome do plano, ou `null` quando o pagamento é de um pacote de tokens. */
  plano: string | null;
  pacote: boolean;
  /** Já há pedido aberto para este pagamento. */
  pendente: boolean;
  invoiceUrl: string | null;
  ambiente: "sandbox" | "producao" | null;
}

const FUSO = "America/Sao_Paulo";

/** O dia civil de São Paulo daquele instante, como número de dias (só a diferença entre dois importa). */
function diaCivilDeSaoPaulo(instante: Date): number {
  const [a, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(instante)
    .split("-")
    .map(Number) as [number, number, number];
  return Math.round(Date.UTC(a, m - 1, d) / MS_POR_DIA);
}

/**
 * O pagamento está dentro da garantia? A janela é de 7 DIAS CIVIS de São Paulo, não de 168 horas: pago às 23h do
 * dia 1, vale até o fim do dia 8. Mesma conta do banco (migration 0963):
 * `(hoje em SP)::date - (paid_at em SP)::date <= 7`.
 */
export function dentroDaGarantia(paidAt: string, agora: Date): boolean {
  const pago = Date.parse(paidAt);
  if (Number.isNaN(pago)) return false;
  return diaCivilDeSaoPaulo(agora) - diaCivilDeSaoPaulo(new Date(pago)) <= PRAZO_DA_GARANTIA_EM_DIAS;
}

/** A assinatura foi cancelada (o cancelamento foi confirmado): `cancel_at_period_end` ligado ou contrato cancelado. */
export function assinaturaCancelada(contrato: { cancelAtPeriodEnd: boolean; status: string } | null | undefined): boolean {
  if (!contrato) return false;
  return contrato.cancelAtPeriodEnd || contrato.status === "cancelada";
}

export type EstadoDoReembolso =
  /** Sem cancelamento confirmado ou sem pagamento elegível: a tela não fala de reembolso. */
  | { tipo: "oculto" }
  /** Pode pedir: o pagamento mais recente está dentro dos 7 dias e não há pedido aberto. */
  | { tipo: "pode_pedir"; pagamento: PagamentoReembolsavel }
  /** Já pediu: o pedido está em análise. */
  | { tipo: "em_analise"; pagamento: PagamentoReembolsavel }
  /** Os 7 dias de garantia do pagamento mais recente já passaram. */
  | { tipo: "fora_do_prazo"; pagamento: PagamentoReembolsavel };

/**
 * O que a tela mostra. `elegiveis` vem do mais recente ao mais antigo; só o PRIMEIRO conta: a garantia vale
 * para o pagamento mais recente e nenhum outro.
 */
export function estadoDoReembolso(args: {
  contrato: { cancelAtPeriodEnd: boolean; status: string } | null | undefined;
  elegiveis: readonly PagamentoReembolsavel[];
  agora: Date;
}): EstadoDoReembolso {
  if (!assinaturaCancelada(args.contrato)) return { tipo: "oculto" };
  const maisRecente = args.elegiveis[0];
  if (!maisRecente) return { tipo: "oculto" };
  if (!dentroDaGarantia(maisRecente.paidAt, args.agora)) return { tipo: "fora_do_prazo", pagamento: maisRecente };
  if (maisRecente.pendente) return { tipo: "em_analise", pagamento: maisRecente };
  return { tipo: "pode_pedir", pagamento: maisRecente };
}
