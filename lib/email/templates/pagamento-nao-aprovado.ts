/**
 * COB-05, pagamento pendente. Três caminhos:
 *
 * - A RÉGUA DE COBRANÇA do pedido de assinatura não pago (migration 1026, `marco` preenchido): 2 dias antes do
 *   vencimento, no dia, 2 dias depois e 1 dia antes do limite (a suspensão da assinatura, ou o último dia em que a
 *   fatura fica no Asaas). Sempre com o botão "Pagar agora" para a fatura.
 * - A renovação da assinatura viva que não foi aprovada: o acesso continua até a data e depois a conta entra em modo
 *   só leitura.
 * - Linhas antigas da fila, enfileiradas antes da régua: quem nunca pagou recebe o pedido de pagamento com o link da
 *   fatura; só sem fatura (ela foi removida) o botão leva aos Planos para assinar de novo.
 */
import { traduzir } from "@/lib/i18n/dicionario";

import {
  formatarData,
  formatarReais,
  montarEmailTransacional,
  paraAssunto,
  preencher,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "COB-05";

/** Os marcos da régua de cobrança (`fn_billing_pedidos_de_assinatura_em_aberto`, migration 1026). */
export type MarcoDaRegua = "antes" | "no_dia" | "depois" | "ultimo_dia";
/** O que acontece no fim do prazo: a assinatura é suspensa, ou a fatura sai do Asaas. */
export type LimiteDaRegua = "suspensao" | "remocao";

export interface PagamentoNaoAprovadoEmailOptions extends OpcoesBaseDoEmail {
  plano: string;
  /** Centavos. */
  valor: number;
  /** ISO. Até quando o acesso continua. Ausente em quem nunca pagou: não há período pago a prometer. */
  acessoAte?: string;
  /** A cobrança foi cancelada pelo CRM: o botão leva aos Planos para assinar de novo (quem já pagava: "precisa ser renovada"). */
  cobrancaCancelada?: boolean;
  /** Nenhum pagamento anterior confirmado: a assinatura ainda não foi concluída. */
  nuncaPagou?: boolean;
  /** O botão leva à fatura do Asaas (validada por quem monta). Falso: leva à tela do CRM. */
  comFatura?: boolean;
  /** Régua de cobrança: o marco deste aviso. Ausente nos outros caminhos. */
  marco?: MarcoDaRegua;
  /** Régua: `AAAA-MM-DD`, o vencimento da fatura. */
  venceEm?: string;
  /** Régua: o que acontece no fim do prazo. */
  limite?: LimiteDaRegua;
  /** Régua: `AAAA-MM-DD`, o dia da suspensão ou o primeiro dia sem a fatura no Asaas. */
  limiteEm?: string;
}

/** O dia anterior a uma data civil `AAAA-MM-DD`, no mesmo formato. */
function diaAnterior(dataCivil: string): string {
  const d = new Date(`${dataCivil}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function emailDaRegua(
  opts: PagamentoNaoAprovadoEmailOptions & { marco: MarcoDaRegua; venceEm: string; limite: LimiteDaRegua; limiteEm: string },
): { subject: string; html: string; text: string } {
  const { idioma, marca } = opts;
  const valor = formatarReais(opts.valor);
  const vence = formatarData(opts.venceEm);
  const suspensao = opts.limite === "suspensao";
  const limite = formatarData(opts.limiteEm);
  const ultimoDiaDaFatura = formatarData(diaAnterior(opts.limiteEm));

  const titulo =
    opts.marco === "antes" || opts.marco === "no_dia"
      ? preencher(traduzir("Sua fatura vence em {data}", idioma), { data: vence })
      : opts.marco === "depois"
        ? preencher(traduzir("Sua fatura venceu em {data}", idioma), { data: vence })
        : suspensao
          ? preencher(traduzir("Sua assinatura será suspensa em {data}", idioma), { data: limite })
          : traduzir("Último dia para pagar sua fatura", idioma);

  const pedido = preencher(
    traduzir(
      opts.nuncaPagou === true
        ? "A fatura de {valor} do plano {plano} ainda não foi paga. Pague pelo botão abaixo para concluir sua assinatura."
        : "A fatura de {valor} do plano {plano} ainda não foi paga. Pague pelo botão abaixo para manter seu plano.",
      idioma,
    ),
    { valor, plano: opts.plano },
  );
  const prazo = suspensao
    ? preencher(traduzir("Sem o pagamento, a assinatura é suspensa em {data}.", idioma), { data: limite })
    : preencher(traduzir("A fatura fica disponível até {data}.", idioma), { data: ultimoDiaDaFatura });

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Pagamento pendente", idioma), tom: "alerta" },
    titulo,
    paragrafos: [pedido, prazo],
    resumo: [
      { rotulo: traduzir("Plano", idioma), valor: opts.plano },
      { rotulo: traduzir("Valor", idioma), valor },
      { rotulo: traduzir("Vencimento", idioma), valor: vence },
    ],
    botao: { texto: traduzir(opts.comFatura === true ? "Pagar agora" : "Ver meu plano", idioma), url: opts.url },
  });
  return { subject: paraAssunto(titulo), html, text };
}

export function buildPagamentoNaoAprovadoEmail(opts: PagamentoNaoAprovadoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  if (opts.marco && opts.venceEm && opts.limite && opts.limiteEm) {
    return emailDaRegua({ ...opts, marco: opts.marco, venceEm: opts.venceEm, limite: opts.limite, limiteEm: opts.limiteEm });
  }

  const { idioma, marca } = opts;
  const valor = formatarReais(opts.valor);
  const data = opts.acessoAte ? formatarData(opts.acessoAte) : null;

  const nuncaPagou = opts.nuncaPagou === true;
  // Quem nunca pagou e ainda tem a fatura: o e-mail pede o pagamento, com o link (migration 1026). Sem fatura (ela
  // foi removida, linha antiga da fila), o botão leva aos Planos.
  const pagarAFatura = nuncaPagou && opts.comFatura === true && opts.cobrancaCancelada !== true;
  const planos = !pagarAFatura && (nuncaPagou || opts.cobrancaCancelada === true);
  const titulo = traduzir(
    pagarAFatura || (planos && nuncaPagou)
      ? "Sua assinatura não foi concluída"
      : planos
        ? "Sua assinatura precisa ser renovada"
        : "Não conseguimos cobrar a renovação do seu plano",
    idioma,
  );
  const texto = preencher(
    traduzir(
      pagarAFatura
        ? "A cobrança de {valor} do plano {plano} ainda não foi paga. Pague pela fatura para concluir sua assinatura."
        : planos
          ? "A cobrança de {valor} do plano {plano} não foi paga no prazo. Para continuar usando o CRM, assine novamente pelos Planos."
          : "A cobrança de {valor} do plano {plano} não foi aprovada. Seu acesso continua até {data}; depois disso a conta entra em modo só leitura.",
      idioma,
    ),
    { valor, plano: opts.plano, data: data ?? "" },
  );

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Pagamento pendente", idioma), tom: "alerta" },
    titulo,
    paragrafos: [texto],
    resumo: [
      { rotulo: traduzir("Plano", idioma), valor: opts.plano },
      { rotulo: traduzir("Valor", idioma), valor },
      ...(data ? [{ rotulo: traduzir("Acesso até", idioma), valor: data }] : []),
    ],
    botao: { texto: traduzir(planos ? "Assinar de novo" : "Pagar agora", idioma), url: opts.url },
  });

  return { subject: paraAssunto(titulo), html, text };
}
