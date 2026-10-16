/**
 * COB-11, pedido de reembolso para o financeiro: um cliente cancelou e pediu o reembolso do pagamento mais recente
 * (dentro dos 7 dias de garantia). Vai SÓ a quem cuida do financeiro da instalação (`EMAIL_DO_FINANCEIRO`, ou, vazio,
 * os mesmos da cópia dos avisos), sempre em português e com a marca da instalação; por isso os textos não passam
 * pelo dicionário. O botão leva à cobrança no Asaas (onde o reembolso é feito); o endereço da lista do admin vai
 * no corpo.
 */
import { rotuloDoMotivo } from "@/lib/billing/reembolso/motivos";

import { formatarData, formatarReais, montarEmailTransacional, paraAssunto, type OpcoesBaseDoEmail } from "./_layout-transacional";

export const ID_DO_EMAIL = "COB-11";

export interface ReembolsoSolicitadoEmailOptions extends OpcoesBaseDoEmail {
  /** Centavos. */
  valor: number;
  /** O nome do plano, ou `null` quando o pagamento é de um pacote de tokens. */
  plano: string | null;
  /** ISO. */
  pagoEm: string;
  dentro7Dias: boolean;
  /** Código do motivo do cancelamento. */
  motivo: string;
  /** Texto livre do cancelamento e observação do pedido. */
  detalhe: string | null;
  /** O endereço da lista de pedidos no admin da plataforma. */
  urlDaLista: string;
  /** O endereço da cobrança no Asaas, quando se sabe. */
  urlDoAsaas: string | null;
}

export function buildReembolsoSolicitadoEmail(opts: ReembolsoSolicitadoEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const valor = formatarReais(opts.valor);
  const titulo = `Pedido de reembolso: ${opts.empresa}`;
  const botaoUrl = opts.urlDoAsaas ?? opts.urlDaLista;

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: "Reembolso", tom: "alerta" },
    titulo,
    paragrafos: [
      `${opts.empresa} cancelou a assinatura e pediu o reembolso de ${valor}. O reembolso é feito no Asaas; depois que o Asaas avisar o estorno, o pedido fecha sozinho.`,
      `Todos os pedidos: ${opts.urlDaLista}`,
    ],
    resumo: [
      { rotulo: "Empresa", valor: opts.empresa },
      { rotulo: "Plano", valor: opts.plano ?? "Pacote de tokens" },
      { rotulo: "Valor", valor },
      { rotulo: "Data do pagamento", valor: formatarData(opts.pagoEm) },
      { rotulo: "Dentro dos 7 dias", valor: opts.dentro7Dias ? "Sim" : "Não" },
      { rotulo: "Motivo do cancelamento", valor: rotuloDoMotivo(opts.motivo) },
      ...(opts.detalhe ? [{ rotulo: "Detalhe", valor: opts.detalhe }] : []),
    ],
    botao: { texto: opts.urlDoAsaas ? "Abrir a cobrança no Asaas" : "Abrir os pedidos de reembolso", url: botaoUrl },
    motivoDoRodape: "Você recebe este e-mail porque cuida do financeiro desta instalação.",
  });

  return { subject: paraAssunto(titulo), html, text };
}
