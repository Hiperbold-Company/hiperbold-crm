/**
 * MODELOS DA CHAVE DA INSTALAÇÃO — o freio de custo (decisão do dono, 16/10/2026).
 *
 * A chave da instalação (a OpenRouter da Hiperbold, `OPENROUTER_API_KEY`) paga a
 * conta de TODAS as empresas e é a única que debita os tokens do plano
 * (`origem_da_chave = 'chave_da_instalacao'`, `lib/ai/log-invocation.ts`). Modelo
 * caro nela vira prejuízo; por isso só os modelos da lista `MODELOS_DA_INSTALACAO`
 * (ids separados por vírgula, editável em /admin/configuracao) rodam nela. O
 * PRIMEIRO id é o padrão: o que um agente novo recebe e o que substitui um modelo
 * não liberado.
 *
 * Quem usa a PRÓPRIA chave (BYOK, `credencial_da_organizacao`) escolhe qualquer
 * modelo: o custo é dela.
 *
 * Este arquivo é PURO (sem banco, sem env): é a regra. A leitura da configuração
 * mora em `./modelos-da-instalacao-leitura.ts` (resolvedor da instalação, para o
 * app e os workers antigos) e em `@/lib/agent-engine/edge/llm/modelos-da-instalacao`
 * (pg, para o motor, que não pode fazer HTTP no caminho do turno).
 */

export const CHAVE_MODELOS_DA_INSTALACAO = "MODELOS_DA_INSTALACAO";

/** Na lista, libera TODOS os modelos (o freio desligado; chave de emergência do operador). */
export const LIBERA_TODOS = "*";

/** O padrão quando a configuração está vazia ou ilegível: o modelo da Luna. */
export const MODELO_PADRAO_DA_INSTALACAO = "openai/gpt-6-luna";

/** Nome para mostrar do que o catálogo ainda não conhece, e o texto de quem não tem chave. */
export const ROTULO_DO_MODELO_PADRAO = "Luna (OpenAI)";

/** Quem aceita o id com prefixo de fabricante (`openai/gpt-6-luna`) inteiro. */
const ROTEADORES = new Set(["openrouter", "requesty", "custom"]);

/**
 * A lista em vigor, a partir do texto da configuração. Vírgula, quebra de linha
 * e ponto e vírgula separam; espaços e repetições saem. Vazio vale o padrão: a
 * lista nunca fica vazia, porque lista vazia = nenhum modelo roda = a IA para.
 */
export function lerModelosDaInstalacao(bruto: string | null | undefined): string[] {
  const vistos = new Set<string>();
  for (const parte of (bruto ?? "").split(/[,;\n]/)) {
    const id = parte.trim();
    if (id !== "") vistos.add(id);
  }
  return vistos.size > 0 ? [...vistos] : [MODELO_PADRAO_DA_INSTALACAO];
}

/** A lista restringe de verdade? Não, quando traz `*` (libera todos). */
export function listaRestringe(lista: readonly string[]): boolean {
  return !lista.includes(LIBERA_TODOS);
}

/** O modelo que um agente sem escolha explícita recebe (o primeiro da lista, ignorando `*`). */
export function modeloPadraoDaInstalacao(lista: readonly string[]): string {
  return lista.find((id) => id !== LIBERA_TODOS) ?? MODELO_PADRAO_DA_INSTALACAO;
}

/**
 * O id como ele é escrito para aquele provedor, ou `null` quando o provedor não
 * sabe executá-lo (id de outro fabricante). Os roteadores levam o id inteiro; os
 * diretos (`openai`, `anthropic`…) recebem só o nome, sem o prefixo de rota.
 */
export function idNoProvedor(provedor: string, id: string): string | null {
  if (ROTEADORES.has(provedor)) return id;
  if (!id.includes("/")) return id;
  if (id.startsWith(`${provedor}/`)) return id.slice(provedor.length + 1);
  return null;
}

/**
 * O id canônico (`fabricante/modelo`) de um id como o catálogo ou o agente o
 * guarda: roteador já traz o prefixo, provedor direto guarda o nome puro.
 */
function idCanonico(provedor: string | null | undefined, id: string): string {
  if (id.includes("/") || !provedor || ROTEADORES.has(provedor)) return id;
  return `${provedor}/${id}`;
}

/** O modelo está liberado na chave da instalação? Compara o id canônico, sem caixa. */
export function modeloLiberado(
  lista: readonly string[],
  modelId: string,
  provedor?: string | null,
): boolean {
  if (!listaRestringe(lista)) return true;
  const alvo = idCanonico(provedor, modelId).toLowerCase();
  const puro = modelId.toLowerCase();
  return lista.some((liberado) => {
    const l = liberado.toLowerCase();
    // Id puro (sem fabricante) casa com o nome depois da barra: `gpt-6-luna` é `openai/gpt-6-luna`.
    return l === alvo || l === puro || (!puro.includes("/") && l.endsWith(`/${puro}`));
  });
}

export interface DecisaoDeModelo {
  /** O id a usar, escrito como o PROVEDOR da chamada o entende. */
  modelId: string;
  trocado: boolean;
  /** O que foi pedido (igual a `modelId` quando não houve troca). */
  pedido: string;
}

/**
 * A regra do freio. Só age na chave da instalação; BYOK passa intacto. Modelo fora
 * da lista vira o padrão — nunca falha o turno. Quando o provedor da chamada não
 * sabe executar o padrão (ex.: chave da instalação da Anthropic e padrão da
 * OpenAI), mantém o pedido: trocar para um id que o provedor recusa derrubaria o
 * turno, e o chamador registra o aviso.
 */
export function decidirModeloDaChave(d: {
  lista: readonly string[];
  origemDaChave: "chave_da_instalacao" | "credencial_da_organizacao";
  provedor: string;
  modelId: string;
}): DecisaoDeModelo & { semTraducao?: true } {
  const mantem: DecisaoDeModelo = { modelId: d.modelId, trocado: false, pedido: d.modelId };
  if (d.origemDaChave !== "chave_da_instalacao") return mantem;
  if (modeloLiberado(d.lista, d.modelId, d.provedor)) return mantem;
  const padrao = idNoProvedor(d.provedor, modeloPadraoDaInstalacao(d.lista));
  if (padrao === null) return { ...mantem, semTraducao: true };
  return { modelId: padrao, trocado: true, pedido: d.modelId };
}

const jaAvisados = new Set<string>();

/** `true` só na PRIMEIRA vez que (organização, modelo) aparece neste processo — para logar uma vez. */
export function primeiraVezDoModelo(organizationId: string, modelId: string): boolean {
  const k = `${organizationId}|${modelId}`;
  if (jaAvisados.has(k)) return false;
  jaAvisados.add(k);
  return true;
}

/** Só para teste: zera a memória do aviso único. */
export function _esquecerAvisosDeModelo(): void {
  jaAvisados.clear();
}

/** Nomes para a tela dos modelos liberados que a gente conhece (a regra do dono: "Luna (OpenAI)"). */
const NOMES_PARA_A_TELA: Record<string, string> = {
  [MODELO_PADRAO_DA_INSTALACAO]: ROTULO_DO_MODELO_PADRAO,
};

export interface OpcaoDeModelo {
  model_id: string;
  display_name: string;
}

/**
 * A lista que a TELA oferece. Com chave própria (ou credencial escolhida): o
 * catálogo inteiro, como sempre. Sem: só os liberados, na ordem da configuração
 * (o primeiro é o padrão) — e o catálogo não precisa conhecê-los: o id liberado
 * entra com o nome amigável, para o seletor nunca ficar vazio numa instalação
 * cujo catálogo ainda não sincronizou.
 */
export function modelosParaOSeletor<M extends OpcaoDeModelo>(d: {
  catalogo: readonly M[];
  liberados: readonly string[];
  provedor: string;
  restrito: boolean;
}): Array<M | OpcaoDeModelo> {
  if (!d.restrito || !listaRestringe(d.liberados)) return [...d.catalogo];
  const opcoes: Array<M | OpcaoDeModelo> = [];
  for (const liberado of d.liberados) {
    const id = idNoProvedor(d.provedor, liberado);
    if (id === null) continue;
    const doCatalogo = d.catalogo.find((c) => c.model_id.toLowerCase() === id.toLowerCase());
    const nomeDoCatalogo = doCatalogo ? doCatalogo.display_name : id;
    const nome = NOMES_PARA_A_TELA[liberado] ?? nomeDoCatalogo;
    opcoes.push({ ...(doCatalogo ?? {}), model_id: doCatalogo?.model_id ?? id, display_name: nome } as M | OpcaoDeModelo);
  }
  // Nenhum liberado é deste provedor (ex.: a instalação roda num provedor direto e a lista só
  // tem modelos do OpenRouter): restringir abriria o seletor VAZIO. O freio do servidor já
  // mantém o modelo pedido nesse caso (sem rota para o padrão), então a tela segue igual a ele.
  if (opcoes.length === 0) return [...d.catalogo];
  return opcoes;
}

/**
 * O agente vai rodar na chave da INSTALAÇÃO? Sim quando não há credencial
 * escolhida de fato (vazio, ou o marcador "chave desta instalação") E a
 * organização não tem credencial própria validada do provedor — porque, sem
 * credencial escolhida, o motor usa a própria da organização quando existe
 * (`resolveOrgLlmConfig`). Credencial escolhida = chave própria = sem limite.
 */
export function agenteUsaChaveDaInstalacao(d: {
  provedor: string;
  credentialId: string;
  marcadorDaInstalacao: string;
  credenciais: ReadonlyArray<{ provider: string; validada: boolean }>;
}): boolean {
  if (d.credentialId !== "" && d.credentialId !== d.marcadorDaInstalacao) return false;
  return !d.credenciais.some((c) => c.provider === d.provedor && c.validada);
}
