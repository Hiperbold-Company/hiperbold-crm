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

/**
 * POR ONDE A CHAVE DA INSTALAÇÃO SAI (decisão do dono, 20/10/2026): sempre pela OpenRouter.
 *
 * A chave da instalação é a que paga a conta de todas as empresas e debita os tokens do plano.
 * Ela nunca vai direto à OpenAI nem à Anthropic, mesmo que `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`
 * estejam no servidor (a OpenAI está, para outras coisas): o provedor da chamada é este, e a
 * `llm_calls` grava `provider = 'openrouter'`. Sem `OPENROUTER_API_KEY` a chamada falha com o erro
 * claro de "sem chave" — nunca cai para outro provedor. Quem cola a PRÓPRIA chave (BYOK) escolhe
 * o provedor que quiser, e este arquivo não se aplica a ela.
 */
export const PROVEDOR_DA_CHAVE_DA_INSTALACAO = "openrouter";

/**
 * `openai/gpt-6-luna:batch` é a variante de LOTE da OpenRouter (Batch API: assíncrona, com metade
 * do preço): "`:batch` endpoints are not usable interactively". Serve a processamento em massa,
 * nunca a uma conversa de WhatsApp, então não pode ser oferecida a agente nenhum.
 */
export function ehVarianteEmLote(modelId: string): boolean {
  return /:batch$/i.test(modelId.trim());
}

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
 * O id como a OpenRouter o escreve (`fabricante/modelo`), a partir do id que o agente ou o catálogo
 * guarda e do provedor que ELE pediu. Id que já traz o fabricante passa intacto; o nome puro do
 * catálogo de um provedor direto (`claude-sonnet-5`, pedido ao `anthropic`) ganha o prefixo dele.
 * Sem isso, a chave da instalação mandaria `claude-sonnet-5` à OpenRouter, que não o conhece.
 */
export function idNaRotaDaInstalacao(provedorPedido: string | null | undefined, id: string): string {
  if (id.includes("/") || !provedorPedido || ROTEADORES.has(provedorPedido)) return id;
  return `${provedorPedido}/${id}`;
}

/**
 * O id canônico (`fabricante/modelo`) de um id como o catálogo ou o agente o
 * guarda: roteador já traz o prefixo, provedor direto guarda o nome puro.
 */
function idCanonico(provedor: string | null | undefined, id: string): string {
  if (id.includes("/") || !provedor || ROTEADORES.has(provedor)) return id;
  return `${provedor}/${id}`;
}

/** O que vem depois do fabricante: `openai/gpt-6` -> `gpt-6`. Sem barra, o próprio id. */
function semFabricante(id: string): string {
  const i = id.indexOf("/");
  return i === -1 ? id : id.slice(i + 1);
}

/**
 * A entrada da lista (`liberado`) e o id pedido (`pedido`) são o MESMO modelo? Iguais, sem caixa —
 * ou a entrada traz o fabricante e o pedido é o nome puro (`openai/gpt-6` na lista, `gpt-6` no
 * agente). O contrário NÃO vale: entrada sem fabricante (`gpt-6`) não libera `anthropic/gpt-6`,
 * porque o nome sozinho não diz de quem é o modelo e um fabricante qualquer passaria pelo freio de
 * custo. Aceitar aquele par exigiria consultar o catálogo (`ai_models`) para confirmar o fabricante,
 * e esta régua é pura e síncrona (roda no caminho do turno); sem a consulta, o par exato com
 * prefixo é o único seguro. Os dois com fabricante só casam se iguais.
 */
function mesmoModelo(liberado: string, pedido: string): boolean {
  const x = liberado.toLowerCase();
  const y = pedido.toLowerCase();
  if (x === y) return true;
  // Entrada com fabricante, pedido puro: o nome bate. Todo o resto é modelo diferente.
  return x.includes("/") && !y.includes("/") && x.endsWith(`/${y}`);
}

/** O modelo está liberado na chave da instalação? Compara o id canônico, sem caixa. */
export function modeloLiberado(
  lista: readonly string[],
  modelId: string,
  provedor?: string | null,
): boolean {
  if (!listaRestringe(lista)) return true;
  const alvo = idCanonico(provedor, modelId);
  return lista.some((liberado) => mesmoModelo(liberado, alvo) || mesmoModelo(liberado, modelId));
}

/**
 * Entradas da lista que NÃO existem no catálogo (`ai_models`). Lista com id escrito errado libera
 * nada em silêncio: o aviso na hora de salvar é a única chance de a pessoa notar.
 */
export function idsForaDoCatalogo(
  lista: readonly string[],
  catalogo: ReadonlyArray<{ provider: string | null; model_id: string }>,
): string[] {
  const conhecidos = catalogo.map((m) => idCanonico(m.provider, m.model_id));
  return lista.filter((id) => !conhecidos.some((c) => mesmoModelo(id, c) || mesmoModelo(id, semFabricante(c))));
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
  /** Mantido por compatibilidade: na chave da instalação o provedor é sempre a OpenRouter, qualquer que seja o escolhido na tela. */
  provedor?: string;
  restrito: boolean;
}): Array<M | OpcaoDeModelo> {
  if (!d.restrito || !listaRestringe(d.liberados)) return [...d.catalogo];
  const opcoes: Array<M | OpcaoDeModelo> = [];
  for (const liberado of d.liberados) {
    if (liberado === LIBERA_TODOS) continue;
    // A chave da instalação roda TUDO pela OpenRouter, que aceita o id inteiro (`openai/gpt-6-luna`):
    // o liberado entra no seletor seja qual for o provedor escolhido na tela, e o Claude do catálogo
    // da Anthropic não aparece para quem não tem chave própria.
    const doCatalogo = d.catalogo.find((c) => c.model_id.toLowerCase() === liberado.toLowerCase());
    const nomeDoCatalogo = doCatalogo ? doCatalogo.display_name : liberado;
    const nome = NOMES_PARA_A_TELA[liberado] ?? nomeDoCatalogo;
    opcoes.push({ ...(doCatalogo ?? {}), model_id: doCatalogo?.model_id ?? liberado, display_name: nome } as M | OpcaoDeModelo);
  }
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
