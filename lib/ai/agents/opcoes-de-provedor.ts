/**
 * AS OPÇÕES DO CAMPO "EMPRESA DE INTELIGÊNCIA ARTIFICIAL" DO AGENTE (decisão do dono, 20/10/2026).
 *
 * O campo deixa de listar todos os provedores do produto. Oferece SÓ:
 *
 *  1. a chave do plano — "Chave própria do Hiperbold CRM (OpenRouter)" — que é a chave da instalação
 *     via OpenRouter, desconta do limite do plano, e nela o modelo é um dos de `MODELOS_DA_INSTALACAO`;
 *  2. os provedores que a organização CONECTOU em Configurações › IA › "Usar minha própria chave de IA
 *     (avançado)": credencial ativa e validada. Provedor sem credencial conectada não aparece.
 *
 * Se a organização conectou a PRÓPRIA OpenRouter, ela aparece separada da opção do plano ("OpenRouter
 * (sua chave)"), para ninguém confundir a conta do plano com a dela.
 *
 * Puro (sem React, sem banco): a tela monta as opções daqui e a regra do servidor
 * (`./provedor-permitido.ts`) é a mesma, só que no salvar e no publicar.
 */

/** O valor da opção do plano no `<Select>`. Não é provedor nenhum: é "a chave da instalação". */
export const VALOR_DA_OPCAO_DO_PLANO = "__plano__";

/** O valor mostrado quando o agente guardado usa um par que o plano já não permite. */
export const VALOR_DO_PAR_NAO_PERMITIDO = "__atual__";

export const ROTULO_DA_OPCAO_DO_PLANO = "Chave própria do Hiperbold CRM (OpenRouter)";
export const ROTULO_DA_OPENROUTER_DA_EMPRESA = "OpenRouter (sua chave)";
export const AJUDA_DA_CHAVE_DO_PLANO = "Na chave do Hiperbold CRM, o uso desconta do limite do seu plano.";
export const AVISO_DO_PAR_NAO_PERMITIDO = "não disponível no seu plano; escolha outro";

export interface OpcaoDeProvedor {
  /** O valor do `<SelectItem>`. */
  valor: string;
  rotulo: string;
  /** O provedor que o agente grava (`openrouter` na opção do plano). */
  provider: string;
  /**
   * A credencial que a opção grava. `null` = a opção do plano (a chave da instalação);
   * em provedor conectado, a mais recente das validadas.
   */
  credentialId: string | null;
}

export interface CredencialParaAsOpcoes {
  id: string;
  provider: string;
  /** Ativa E validada: é o que "conectada" quer dizer. */
  conectada: boolean;
  /** ISO — desempata a credencial usada ao escolher o provedor (a mais recente). */
  criadaEm?: string | null;
}

export function opcoesDeProvedor(d: {
  credenciais: readonly CredencialParaAsOpcoes[];
  /** Os ids de provedor que o produto sabe executar (`PROVEDORES`). Jev e afins ficam de fora. */
  provedoresConhecidos: ReadonlyArray<{ id: string; rotulo: string }>;
}): OpcaoDeProvedor[] {
  const opcoes: OpcaoDeProvedor[] = [
    { valor: VALOR_DA_OPCAO_DO_PLANO, rotulo: ROTULO_DA_OPCAO_DO_PLANO, provider: "openrouter", credentialId: null },
  ];
  for (const p of d.provedoresConhecidos) {
    const doProvedor = d.credenciais
      .filter((c) => c.provider === p.id && c.conectada)
      .sort((a, b) => Date.parse(b.criadaEm ?? "") - Date.parse(a.criadaEm ?? "") || 0);
    const escolhida = doProvedor[0];
    if (!escolhida) continue;
    opcoes.push({
      valor: p.id,
      rotulo: p.id === "openrouter" ? ROTULO_DA_OPENROUTER_DA_EMPRESA : p.rotulo,
      provider: p.id,
      credentialId: escolhida.id,
    });
  }
  return opcoes;
}

/**
 * Qual opção corresponde ao que o formulário tem. `credentialId` é o do formulário, onde
 * `marcadorDaInstalacao` quer dizer "a chave da instalação" e o vazio, "não escolhida".
 * Sem correspondência (agente salvo com um par que o plano deixou de permitir) devolve
 * `VALOR_DO_PAR_NAO_PERMITIDO` — a tela mostra o valor atual com o aviso, em vez de um campo em branco.
 */
export function valorDaOpcaoEmVigor(d: {
  provider: string;
  credentialId: string;
  marcadorDaInstalacao: string;
  opcoes: readonly OpcaoDeProvedor[];
}): string {
  if (d.credentialId === d.marcadorDaInstalacao) {
    return d.provider === "openrouter" ? VALOR_DA_OPCAO_DO_PLANO : VALOR_DO_PAR_NAO_PERMITIDO;
  }
  const daEmpresa = d.opcoes.find((o) => o.credentialId !== null && o.provider === d.provider);
  return daEmpresa ? daEmpresa.valor : VALOR_DO_PAR_NAO_PERMITIDO;
}

/**
 * O que um agente NOVO escolhe: o provedor que a organização já usa, se ela o conectou; senão a
 * opção do plano.
 */
export function opcaoInicialDoAgenteNovo(d: {
  provedorPadrao?: string | undefined;
  opcoes: readonly OpcaoDeProvedor[];
}): OpcaoDeProvedor {
  const plano = d.opcoes[0]!;
  if (!d.provedorPadrao) return plano;
  return d.opcoes.find((o) => o.credentialId !== null && o.provider === d.provedorPadrao) ?? plano;
}
