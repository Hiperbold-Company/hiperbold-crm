/**
 * COB-12, aviso de exclusão dos dados (D-30 e D-7): a assinatura acabou e os dados da organização serão
 * excluídos na data informada. A Política de Privacidade promete 90 dias para exportar. Quem encerrou a
 * assinatura pode exportar o que precisa em Configurações ou reativar a assinatura para manter tudo; na
 * exclusão programada à mão pelo operador (sem assinatura), a saída é falar com a equipe.
 */
import { traduzir } from "@/lib/i18n/dicionario";

import {
  formatarData,
  montarEmailTransacional,
  paraAssunto,
  preencher,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "COB-12";

export interface ExclusaoDeDadosProgramadaEmailOptions extends OpcoesBaseDoEmail {
  /** Data da exclusão (`aaaa-mm-dd` ou ISO). */
  excluirEm: string;
  /** Quantos dias faltam neste aviso: 30 ou 7. */
  dias: number;
  /** Por que está programada: assinatura cancelada, suspensa, ou programada pelo operador. */
  motivo: "cancelada" | "suspensa" | "manual";
}

export function buildExclusaoDeDadosProgramadaEmail(opts: ExclusaoDeDadosProgramadaEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const { idioma, marca } = opts;
  const data = formatarData(opts.excluirEm);

  const titulo = preencher(traduzir("Seus dados serão excluídos em {data}", idioma), { data });
  const texto = preencher(
    traduzir(
      "Seus dados no {crm} serão excluídos em {data}. Exporte o que precisar em Configurações ou reative a assinatura para manter tudo.",
      idioma,
    ),
    { crm: marca.nome, data },
  );
  const textoManual = preencher(
    traduzir(
      "Seus dados no {crm} serão excluídos em {data}. Exporte o que precisar em Configurações ou fale com a nossa equipe para manter tudo.",
      idioma,
    ),
    { crm: marca.nome, data },
  );
  const aviso = preencher(
    traduzir(
      "Depois dessa data, as conversas, os contatos e os arquivos da {empresa} não poderão ser recuperados. Guardamos apenas os registros que a lei manda manter.",
      idioma,
    ),
    { empresa: opts.empresa },
  );

  const { html, text } = montarEmailTransacional({
    marca,
    idioma,
    empresa: opts.empresa,
    faixaDoOperador: opts.faixaDoOperador,
    selo: { texto: traduzir("Exclusão dos dados", idioma), tom: opts.dias <= 7 ? "perigo" : "alerta" },
    titulo,
    paragrafos: [opts.motivo === "manual" ? textoManual : texto, aviso],
    resumo: [
      { rotulo: traduzir("Data da exclusão", idioma), valor: data },
      { rotulo: traduzir("Dias restantes", idioma), valor: String(opts.dias) },
    ],
    botao: {
      texto: traduzir(opts.motivo === "manual" ? "Abrir configurações" : "Reativar a assinatura", idioma),
      url: opts.url,
    },
  });

  return { subject: paraAssunto(titulo), html, text };
}
