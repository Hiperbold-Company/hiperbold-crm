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
  /** ISO. Até quando o acesso continua. */
  acessoAte: string;
  /** A cobrança foi cancelada pelo CRM: a assinatura não foi concluída e o botão leva aos Planos para assinar de novo. */
  cobrancaCancelada?: boolean;
}

export function buildPagamentoNaoAprovadoEmail(opts: PagamentoNaoAprovadoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const valor = formatarReais(opts.valor);
  const data = formatarData(opts.acessoAte);

  const cancelada = opts.cobrancaCancelada === true;
  const titulo = traduzir(
    cancelada ? "Sua assinatura não foi concluída" : "Não conseguimos cobrar a renovação do seu plano",
    idioma,
  );
  const texto = preencher(
    traduzir(
      cancelada
        ? "A cobrança de {valor} do plano {plano} não foi paga e foi cancelada. Seu acesso continua até {data}; para não perder o acesso, assine novamente pelo CRM."
        : "A cobrança de {valor} do plano {plano} não foi aprovada. Seu acesso continua até {data}; depois disso a conta entra em modo só leitura.",
      idioma,
    ),
    { valor, plano: opts.plano, data },
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
      { rotulo: traduzir("Acesso até", idioma), valor: data },
    ],
    botao: { texto: traduzir(cancelada ? "Assinar de novo" : "Pagar agora", idioma), url: opts.url },
  });

  return { subject: paraAssunto(titulo), html, text };
}
