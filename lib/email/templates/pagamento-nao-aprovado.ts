/**
 * COB-05, pagamento não aprovado / em atraso: a cobrança da renovação falhou. O acesso continua até a data e
 * depois a conta entra em modo só leitura.
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

export interface PagamentoNaoAprovadoEmailOptions extends OpcoesBaseDoEmail {
  plano: string;
  /** Centavos. */
  valor: number;
  /** ISO. Até quando o acesso continua. Ausente em quem nunca pagou: não há período pago a prometer. */
  acessoAte?: string;
  /** A cobrança foi cancelada pelo CRM: o botão leva aos Planos para assinar de novo (quem já pagava: "precisa ser renovada"). */
  cobrancaCancelada?: boolean;
  /** Nenhum pagamento anterior confirmado: a assinatura não chegou a ser concluída. Leva aos Planos, como a cancelada. */
  nuncaPagou?: boolean;
}

export function buildPagamentoNaoAprovadoEmail(opts: PagamentoNaoAprovadoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const valor = formatarReais(opts.valor);
  const data = opts.acessoAte ? formatarData(opts.acessoAte) : null;

  const nuncaPagou = opts.nuncaPagou === true;
  // Sem fatura a pagar: o botão leva aos Planos. Quem nunca pagou sempre cai aqui, mesmo sem o marcador de cancelada.
  const planos = nuncaPagou || opts.cobrancaCancelada === true;
  const titulo = traduzir(
    !planos
      ? "Não conseguimos cobrar a renovação do seu plano"
      : nuncaPagou
        ? "Sua assinatura não foi concluída"
        : "Sua assinatura precisa ser renovada",
    idioma,
  );
  const texto = preencher(
    traduzir(
      planos
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
