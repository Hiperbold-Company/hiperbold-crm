/**
 * COB-02, plano confirmado: o pagamento foi aprovado e o plano está liberado até a data. Sai para quem
 * administra a organização, uma vez por compra.
 *
 * Na PRIMEIRA compra da organização (`primeiraCompra`) o mesmo e-mail vira "sua conta está pronta": apresenta o
 * CRM e o botão leva ao Início (`/app/inicio`). As compras seguintes mantêm o texto de "plano ativo".
 *
 * Valores: o ciclo e a forma de pagamento chegam como código (`CicloDoPlano`, `FormaDePagamento`) e saem no
 * idioma de quem lê; a data chega ISO e sai `dd/mm/aaaa`.
 */
import { traduzir } from "@/lib/i18n/dicionario";

import {
  formatarData,
  montarEmailTransacional,
  paraAssunto,
  preencher,
  rotuloDaForma,
  rotuloDoCiclo,
  type CicloDoPlano,
  type FormaDePagamento,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "COB-02";

export interface PlanoConfirmadoEmailOptions extends OpcoesBaseDoEmail {
  plano: string;
  ciclo: CicloDoPlano;
  formaDePagamento: FormaDePagamento;
  /** ISO. O último dia de acesso pago. */
  acessoAte: string;
  /** Primeira compra paga da organização: o e-mail dá as boas-vindas. Ausente = false. */
  primeiraCompra?: boolean;
}

export function buildPlanoConfirmadoEmail(opts: PlanoConfirmadoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const ciclo = rotuloDoCiclo(opts.ciclo, idioma);
  const data = formatarData(opts.acessoAte);

  const crm = marca.nome;
  const primeira = opts.primeiraCompra === true;
  const titulo = primeira
    ? preencher(traduzir("Sua conta no {crm} está pronta", idioma), { crm })
    : preencher(traduzir("Seu plano {plano} está ativo", idioma), { plano: opts.plano });
  const valores = { plano: opts.plano, ciclo: ciclo.toLocaleLowerCase(idioma), data };
  const paragrafos = primeira
    ? [
        preencher(
          traduzir("Recebemos o pagamento e o plano {plano} ({ciclo}) já está ativo até {data}.", idioma),
          valores,
        ),
        preencher(
          traduzir(
            "O {crm} reúne num só lugar as conversas do WhatsApp, seus contatos e o funil de vendas, com um atendente de IA que responde seus clientes por você.",
            idioma,
          ),
          { crm },
        ),
        traduzir(
          "Para começar, entre no CRM. A tela Início mostra os primeiros passos: conectar o seu WhatsApp e contar o que sua empresa faz leva poucos minutos.",
          idioma,
        ),
      ]
    : [
        preencher(
          traduzir("Recebemos o pagamento e o plano {plano} ({ciclo}) já está liberado até {data}.", idioma),
          valores,
        ),
      ];

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Pagamento aprovado", idioma), tom: "sucesso" },
    titulo,
    paragrafos,
    resumo: [
      { rotulo: traduzir("Plano", idioma), valor: opts.plano },
      { rotulo: traduzir("Ciclo", idioma), valor: ciclo },
      {
        rotulo: traduzir("Forma de pagamento", idioma),
        valor: rotuloDaForma(opts.formaDePagamento, idioma),
      },
      { rotulo: traduzir("Acesso até", idioma), valor: data },
    ],
    botao: {
      texto: traduzir(primeira ? "Acessar CRM" : "Ver meu plano", idioma),
      url: opts.url,
    },
  });

  return { subject: paraAssunto(titulo), html, text };
}
