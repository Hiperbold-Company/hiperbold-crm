/**
 * ADM-01, recibo da exclusão dos dados, SÓ para o operador da instalação (nunca para a organização cliente, que
 * deixou de existir). Só contagens: nenhum dado pessoal de contato entra aqui. Sempre em português.
 */
import {
  montarEmailTransacional,
  paraAssunto,
  type OpcoesBaseDoEmail,
} from "./_layout-transacional";

export const ID_DO_EMAIL = "ADM-01";

export interface ExclusaoDeDadosConcluidaEmailOptions extends OpcoesBaseDoEmail {
  /** Quem foi excluída: o nome de exibição da organização, lido antes da exclusão. */
  nomeDaOrganizacao: string;
  origem: "automatica" | "manual";
  motivo: "cancelada" | "suspensa" | "manual";
  contatos: number;
  conversas: number;
  mensagens: number;
  negocios: number;
  arquivosApagados: number;
  conexoesEncerradas: number;
  registrosFiscaisArquivados: number;
  usuariosRemovidos: number;
  usuariosMantidos: number;
}

export function buildExclusaoDeDadosConcluidaEmail(opts: ExclusaoDeDadosConcluidaEmailOptions): {
  subject: string;
  html: string;
  text: string;
} {
  const n = (v: number) => String(v);
  const titulo = `Dados da organização ${opts.nomeDaOrganizacao} excluídos`;
  const { html, text } = montarEmailTransacional({
    marca: opts.marca,
    idioma: "pt-BR",
    empresa: opts.empresa,
    selo: { texto: "Exclusão concluída", tom: "info" },
    titulo,
    paragrafos: [
      `A exclusão ${opts.origem === "manual" ? "programada pelo operador" : "automática, depois do fim da assinatura"} foi concluída. Os registros fiscais ficam guardados por 5 anos e a auditoria de acesso pelo prazo de retenção.`,
    ],
    resumo: [
      { rotulo: "Contatos", valor: n(opts.contatos) },
      { rotulo: "Conversas", valor: n(opts.conversas) },
      { rotulo: "Mensagens", valor: n(opts.mensagens) },
      { rotulo: "Negócios", valor: n(opts.negocios) },
      { rotulo: "Arquivos apagados do Storage", valor: n(opts.arquivosApagados) },
      { rotulo: "Conexões encerradas", valor: n(opts.conexoesEncerradas) },
      { rotulo: "Registros fiscais arquivados", valor: n(opts.registrosFiscaisArquivados) },
      { rotulo: "Contas de usuário removidas", valor: n(opts.usuariosRemovidos) },
      { rotulo: "Contas mantidas", valor: n(opts.usuariosMantidos) },
    ],
    botao: { texto: "Abrir exclusões", url: opts.url },
  });
  return { subject: paraAssunto(titulo), html, text };
}
