/**
 * COB-10, solicitação de reembolso recebida: o pedido do cliente chegou, a equipe responde em até 3 dias úteis e
 * o estorno, quando concluído, é avisado por e-mail (COB-08). Só vale dentro dos 7 dias de garantia; o pedido já
 * foi validado antes de este e-mail ser enfileirado.
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

export const ID_DO_EMAIL = "COB-10";

export interface SolicitacaoDeReembolsoRecebidaEmailOptions extends OpcoesBaseDoEmail {
  /** Centavos. */
  valor: number;
  /** O nome do plano, ou `null` quando o pagamento é de um pacote de tokens. */
  plano: string | null;
  /** ISO. Quando o pagamento foi feito. */
  pagoEm: string;
}

export function buildSolicitacaoDeReembolsoRecebidaEmail(opts: SolicitacaoDeReembolsoRecebidaEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const valor = formatarReais(opts.valor);
  const plano = opts.plano ?? traduzir("Pacote de tokens", idioma);

  const titulo = traduzir("Recebemos sua solicitação de reembolso", idioma);
  const texto = preencher(
    traduzir("Recebemos o pedido de reembolso de {valor}, referente a {plano}. Nossa equipe responde em até 3 dias úteis.", idioma),
    { valor, plano },
  );
  const aviso = traduzir("Assim que o estorno for concluído, avisamos por e-mail.", idioma);

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Reembolso", idioma), tom: "info" },
    titulo,
    paragrafos: [texto, aviso],
    resumo: [
      { rotulo: traduzir("Valor", idioma), valor },
      { rotulo: traduzir("Plano", idioma), valor: plano },
      { rotulo: traduzir("Data do pagamento", idioma), valor: formatarData(opts.pagoEm) },
    ],
    botao: { texto: traduzir("Ver meu plano", idioma), url: opts.url },
  });

  return { subject: paraAssunto(titulo), html, text };
}
