import { campoSoLeitura } from '@/lib/automacoes/campos';
import { GATILHO_TRAZ_CONTATO } from '@/lib/automacoes/schemas';
import {
  cabecalhoComSegredoEscrito,
  cabecalhoProibido,
  FRASE_DO_SEGREDO_ESCRITO,
  corpoEhJsonValido,
  metodoTemCorpo,
  porNoCaminhoDoCorpo,
  problemaDaUrl,
  segredosDoBloco,
  TENTATIVA_DE_SEGREDO,
} from '@/lib/automacoes/http';
import { fraseDaChavePresa, hostDaUrlDoBloco, hostPermitido } from '@/lib/automacoes/hosts-permitidos';
import { nomeDoCampo } from '@/lib/automacoes/vocabulario';
import type { FlowGraph, FlowEdge, FlowNode, NodeType } from './graph-schema';
import type { FollowupFlowSurface, TriggerConfig } from './api-schemas';
import {
  branchIdForCondition,
  duracaoMaximaDaEspera,
  duracaoMinimaDaEspera,
  ehRegraNova,
  NO_REPLY_BRANCH_ID,
  nodeBranches,
} from './graph-schema';
import { NOS_DA_SUPERFICIE } from './registro-de-nos';
import { rotuloDoRamo } from './rotulo-do-ramo';
import type { NomesDeValor } from './vocabulario';
import type { EtapaCitada } from './etapas-citadas';
import type { ModelosDaConta } from './modelos-citados';
import { recusaDeMotivoForaDoVocabulario } from '../leads/motivo-da-perda';
import {
  capabilitiesOf,
  opcoesNativas,
  PROVIDERS_SOCIAIS,
  TETO_DO_TEXTO_DO_DIRECT_BYTES,
  transportaMensagem,
  type ChannelProvider,
} from '../channels/capabilities';
import { bytesDoTextoQueSai } from '../channels/opcoes-numeradas';
import type { OutboundInteractive } from '../channels/types';
import { CUSTO_NO_MOTOR, TETO_DE_PASSOS_DO_MOTOR } from './custo-no-motor';
import { horarioDaEsperaValido } from './espera-no-horario';
import { horaValida } from '../automacoes/plano-de-tempo';

/**
 * Structural publish validator for follow-up flow graphs.
 * Checks are purely structural (reachability, coverage, cycles) — no DB access.
 * What only the database knows (which stages exist) arrives injected through
 * `ContextoDoPublish`, so this stays a pure function.
 */

export const PUBLISH_ERROR_CODES = [
  'no_trigger',
  'multiple_triggers',
  'unreachable_node',
  'no_end_path',
  'missing_class_edge',
  'missing_branch_edge',
  'missing_no_reply_edge',
  'missing_always_fallback',
  'empty_check_value',
  'check_value_not_number',
  'check_stage_not_found',
  'check_stage_archived',
  'grace_too_short',
  'long_wait_needs_template',
  'immune_wait_too_short',
  'cycle_without_wait',
  'max_steps_exceeded',
  // #2965 — o teto do MOTOR (`steps_taken`/`MAX_STEPS`, ver `custo-no-motor.ts`):
  // o caminho linear que ele não conseguiria terminar.
  'max_engine_steps_exceeded',
  'no_fora_da_superficie',
  'interno_com_envio',
  'roteiro_ramificado',
  'campo_repetido',
  'roteiro_em_ciclo',
  'gatilho_da_automacao',
  'regra_de_automacao',
  'campo_so_leitura',
  'espera_imune_na_automacao',
  'espera_so_na_automacao',
  'mensagem_sem_contato',
  'automacao_iniciar_propria',
  'automacao_iniciar_inexistente',
  'instagram_sem_gatilho_de_comentario',
  'instagram_publica_antes_da_privada',
  'instagram_mensagem_antes_da_resposta',
  'instagram_gatilhos_misturados',
  'instagram_texto_longo',
  // #2065 — configuração dos dois nós de ação que não falam com o cliente.
  'etapa_destino_ausente',
  'etapa_destino_arquivada',
  'motivo_da_perda_ausente',
  'motivo_da_perda_invalido',
  'tag_ausente',
  // Seguimento do #3056 — o modelo de mensagem do passo não existe nesta conta
  // (importado de outra, ou apagado): o motor lançaria a cada envio.
  'modelo_inexistente',
  // Regra de data (item 14): sem o campo do negócio ela não tem o que comparar
  // e responderia `false` para sempre, sem dizer por quê.
  'campo_de_data_ausente',
  // Espera com horário (`ate_o_horario`): início depois do fim, nenhum dia ou
  // hora torta — o motor não teria como obedecer e terminaria a espera na
  // duração crua, calado (`espera-no-horario.ts` falha aberta).
  'horario_da_espera_invalido',
  // Lote 6: a espera "até um dia e horário" / "até a data de um campo" com hora
  // torta, sem o número de dias ou sem o dia da semana.
  'hora_da_espera_invalida',
  // Lote 6: a espera "até a data de um campo" aponta para um campo de data que
  // nenhum funil da organização tem (apagado, renomeado, de outra conta).
  'campo_de_data_inexistente',
  // Bloco "Requisição HTTP" (lote 4): URL, cabeçalho, chave do cofre e corpo.
  'http_url_invalida',
  'http_segredo_na_url',
  'http_segredo_no_texto',
  'http_cabecalho_proibido',
  'http_segredo_inexistente',
  'http_corpo_no_get',
  'http_corpo_invalido',
  // Migration 1007: a chave citada só pode ir para os endereços permitidos dela.
  'http_host_nao_permitido',
] as const;
export type PublishErrorCode = (typeof PUBLISH_ERROR_CODES)[number];

export type PublishValidationError = {
  node_id: string | null;
  code: PublishErrorCode;
  message: string;
  /** Qual saída do nó ficou descoberta — o editor ancora o aviso na bolinha certa, não no nó inteiro. */
  branch_id?: string;
};

/**
 * AVISOS DE SEGURANÇA DA PUBLICAÇÃO — o que não reprova, mas quem publica
 * precisa ler antes de clicar.
 *
 * Por que aviso e não erro: estes três são decisões legítimas em algum fluxo
 * (um toque único de "10 minutos depois" não quer teto de silêncio), e virar
 * erro duro REPROVARIA o re-publish de fluxos de silêncio que já existem em
 * outras instalações. Reprovar o que já está publicado e funcionando é quebrar
 * dado alheio para dar uma lição.
 */
export const PUBLISH_WARNING_CODES = [
  /** Fluxo de silêncio sem teto: alcança todo contato calado além do mínimo, de uma vez, ao ser ligado. */
  'silencio_sem_teto',
  /** Fluxo de silêncio sem teto de repetições: a pausa só espaça, e quem nunca responde recomeça para sempre. */
  'silencio_sem_limite_de_repeticoes',
  /** Fluxo de silêncio que alcança quem a EQUIPE não respondeu. */
  'silencio_alcanca_nao_atendido',
] as const;
export type PublishWarningCode = (typeof PUBLISH_WARNING_CODES)[number];

export type PublishValidationWarning = {
  code: PublishWarningCode;
  message: string;
};

/**
 * `warnings` é OPCIONAL nos dois braços de propósito: todo consumidor atual lê
 * `ok` e, no `false`, `errors`. Acrescentar campo opcional não quebra nenhum —
 * e o braço `ok: true` passa a poder carregar recado, que antes não tinha onde
 * caber.
 */
export type PublishValidationResult =
  | { ok: true; warnings?: PublishValidationWarning[] }
  | { ok: false; errors: PublishValidationError[]; warnings?: PublishValidationWarning[] };

/**
 * O que só o banco sabe, lido por quem chama (a rota de publish). Ausente, a
 * conferência que depende dele não roda — nunca adivinha.
 */
export interface ContextoDoPublish {
  /** Etapas da organização por `stage_id`, com o nome como a tela mostra («Etapa · Funil»). */
  etapas?: ReadonlyMap<string, EtapaCitada>;
  /** Superfície do pointer. Ausente = follow-up (o que a coluna tem por padrão). */
  surface?: FollowupFlowSurface;
  /**
   * Roteiro: o id do que está sendo publicado e, dos OUTROS roteiros ativos da
   * empresa, para onde o "ao concluir" de cada um encadeia (versão publicada).
   * Com os dois, a publicação que FECHARIA um ciclo A → B → A é recusada — é
   * sempre a última publicação do ciclo que o fecha, então conferir só nela basta.
   */
  roteiro?: RoteiroDoPublish;
  /**
   * Alguma conexão da organização EXIGE modelo aprovado com a janela de 24 h
   * fechada — canal que tem a regra da janela E tem catálogo de definições
   * aprovadas a oferecer (`algumCanalExigeModeloForaDaJanela`, #3109)? Só aí o
   * plano B (`fallback_template_id`) de uma mensagem por IA depois de 24 h de
   * espera tem o que fazer — em runtime ele só sai com a janela fechada
   * (`janelaFechada` em followup-turn.ts). Num canal sem janela, ou num canal
   * que fecha a janela mas não tem modelo aprovado nenhum (o canal social de
   * Instagram/Facebook), exigi-lo travaria o publish sem oferecer saída: o
   * seletor do plano B só oferece modelos aprovados. Ausente = exige (o
   * comportamento de antes).
   */
  exigeModeloForaDaJanela?: boolean;
  /**
   * Automação: o id do que está sendo publicado e as automações DESTA
   * organização que a ação "Iniciar outra automação" cita e existem
   * (`surface = 'automacao'`, lidas filtrando a organização). Sem `existentes`,
   * só a conferência de "iniciar a si mesma" roda.
   */
  automacao?: {
    pointerId: string;
    existentes?: ReadonlySet<string>;
    /** Chaves do cofre DESTA organização entre as que os blocos "Requisição HTTP" citam. Ausente = não confere. */
    segredosExistentes?: ReadonlySet<string>;
    /** Nome e endereços permitidos dessas chaves (migration 1007). Ausente = não confere o host. */
    destinosDosSegredos?: ReadonlyMap<string, { nome: string; hosts_permitidos: string[] | null }>;
  };
  /**
   * O gatilho que vai armar este fluxo. Só os AVISOS o leem — nenhuma recusa
   * depende dele —, e ausente significa "não há o que avisar sobre o gatilho".
   */
  trigger?: TriggerConfig;
  /**
   * Dos modelos que o grafo cita (`template_id`/`fallback_template_id`), os que
   * existem na organização (`carregaModelosCitados`). Ausente = não confere.
   */
  modelos?: ModelosDaConta;
  /**
   * Lote 6: as chaves dos campos de DATA do negócio em algum funil da
   * organização (`camposDeDataDoNegocio`). Ausente = não confere.
   */
  camposDeData?: ReadonlySet<string>;
}

/** Chave do dicionário (a rota traduz): a frase não cita id, que a pessoa não lê. */
export const MENSAGEM_MODELO_INEXISTENTE =
  'Escolha um modelo de mensagem: o que estava aqui não existe nesta conta.';

/**
 * Os avisos que o gatilho de silêncio rende. Nenhum reprova; todos são coisas
 * medidas em instalação real que quem publica não tinha como ver na tela.
 */
export function avisosDoGatilho(trigger: TriggerConfig | undefined): PublishValidationWarning[] {
  if (!trigger || trigger.kind !== 'silence') return [];
  const avisos: PublishValidationWarning[] = [];
  const p = trigger.params;

  if (!p.max_silence_minutes) {
    avisos.push({
      code: 'silencio_sem_teto',
      message:
        'Sem “silêncio máximo”, o fluxo alcança TODO contato calado há mais que o mínimo — inclusive quem sumiu há meses — e começa para todos eles na primeira varredura, um minuto depois de publicar.',
    });
  }
  if (!p.max_enrollments_por_contato) {
    avisos.push({
      code: 'silencio_sem_limite_de_repeticoes',
      message:
        'Sem limite de repetições, a pausa só ESPAÇA os reinícios: quem nunca responde volta a receber o fluxo a cada pausa, indefinidamente.',
    });
  }
  if (!p.exige_resposta_da_equipe) {
    avisos.push({
      code: 'silencio_alcanca_nao_atendido',
      message:
        'O silêncio conta da última mensagem do CLIENTE, e mensagem da equipe não zera essa conta: quem escreveu e não foi atendido também entra no fluxo. Ligue “Só começar se a equipe já respondeu a última mensagem do cliente” se o fluxo é para quem sumiu, não para quem está esperando.',
    });
  }
  return avisos;
}

/**
 * `true` quando alguma conexão da organização EXIGE modelo aprovado fora da
 * janela de 24 h — a única situação em que o plano B (`fallback_template_id`) de
 * uma mensagem por IA depois de 24 h tem o que fazer.
 *
 * ─── Não basta o canal ter janela (#3109) ─────────────────────────────────
 *
 * A versão anterior perguntava só `!freeformOutsideWindow`. O canal social de
 * Instagram/Facebook fecha a janela (`freeformOutsideWindow: false`, MEDIDO: a
 * Meta recusa a ENTREGA com 131047) e mesmo assim NÃO tem catálogo de definições
 * aprovadas (`requiresTemplates: false` — não há WABA por trás dele). Nessa conta
 * o seletor do plano B nasce vazio: não existe modelo aprovado a escolher, e a
 * exigência fica impossível de cumprir. Como a conta era da ORGANIZAÇÃO INTEIRA,
 * uma conexão social reprovava o publish de um fluxo que só roda no WhatsApp por
 * QR (canal sem janela) — e nem com plano B nem sem ele havia configuração
 * válida para publicar.
 *
 * Então as duas perguntas entram juntas, e a segunda é a que faltava: o canal tem
 * a REGRA da janela E tem DEFINIÇÕES aprovadas para oferecer? Sem catálogo, o
 * plano B não é exigência — é impossibilidade, e recusar a publicação não
 * destrava nenhuma configuração: quem trata o que acontece com a mensagem livre
 * fora da janela num contato de canal social é o envio, não o publish.
 *
 * Provider que esta imagem não conhece (ou que não manda mensagem) não conta: por
 * ele não sai follow-up nenhum.
 */
export function algumCanalExigeModeloForaDaJanela(providers: readonly (string | null)[]): boolean {
  return providers.some((p) => {
    if (!transportaMensagem(p)) return false;
    const caps = capabilitiesOf(p as ChannelProvider);
    return !caps.freeformOutsideWindow && caps.requiresTemplates;
  });
}

export interface RoteiroDoPublish {
  pointerId: string;
  encadeamentos: ReadonlyMap<string, { nome: string; proximos: readonly string[] }>;
}

/** Para onde o "ao concluir" dos Fins de um grafo encadeia (ids de ponteiro). */
export function proximosDoGrafo(graph: unknown): string[] {
  const nodes = (graph as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((n) => {
    const fim = (n as { type?: unknown; config?: { ao_finalizar?: { tipo?: unknown; fluxo?: unknown } } }).config
      ?.ao_finalizar;
    return (n as { type?: unknown }).type === 'end' && fim?.tipo === 'proximo_fluxo' && typeof fim.fluxo === 'string'
      ? [fim.fluxo]
      : [];
  });
}

/**
 * Caminho do encadeamento que volta ao próprio roteiro (nomes, para a
 * mensagem), ou `null`. Sem isto dois roteiros que se apontam recomeçam um ao
 * outro a cada conclusão, e o cliente responde as mesmas perguntas sem fim.
 */
function cicloDoEncadeamento(
  graph: FlowGraph,
  roteiro: RoteiroDoPublish,
): string[] | null {
  const visitados = new Set<string>();
  const busca = (id: string, caminho: string[]): string[] | null => {
    if (id === roteiro.pointerId) return caminho;
    if (visitados.has(id)) return null;
    visitados.add(id);
    const outro = roteiro.encadeamentos.get(id);
    if (!outro) return null;
    for (const prox of outro.proximos) {
      const achou = busca(prox, [...caminho, roteiro.encadeamentos.get(prox)?.nome ?? 'este roteiro']);
      if (achou) return achou;
    }
    return null;
  };
  for (const prox of proximosDoGrafo(graph)) {
    const achou = busca(prox, [roteiro.encadeamentos.get(prox)?.nome ?? 'este roteiro']);
    if (achou) return achou;
  }
  return null;
}

/**
 * Os tipos de nó que cada superfície EXECUTA. É a mesma lista que a paleta do
 * editor oferece: o que um motor não sabe rodar, a tela não deixa pôr.
 *
 * O roteiro de atendimento (`lib/followup/atendimento.ts`) percorre só
 * início → pergunta/skill → fim, em linha. O relógio do follow-up nunca vê
 * `collect`/`skill` — no motor dele, os dois são passagem (`node-handlers.ts`),
 * e publicar um fluxo de retomada com pergunta seria fluxo com passo mudo.
 * Na prova prática do #1130 a paleta do roteiro oferecia seis caixas que o motor
 * recusava em silêncio; a recusa aqui é o erro que a pessoa lê no editor.
 */
// Derivado do registro de nós (`registro-de-nos.ts`): uma entrada por tipo, exaustiva.
export { NOS_DA_SUPERFICIE };

const TIPOS_DO_INSTAGRAM: ReadonlySet<NodeType> = new Set<NodeType>([
  'instagram_private_reply',
  'instagram_public_reply',
  'instagram_check_follow',
]);

/**
 * Blocos do Instagram: só valem quando TODO gatilho da automação é "Comentário
 * no Instagram" (é dele que vêm o comentário, a conta e o autor), e a resposta
 * pública nunca vem antes da privada no mesmo caminho — o canal só envia a
 * pública depois da privada, e responder em público primeiro deixa o
 * comentário inelegível para a privada.
 */
function validarBlocosDoInstagram(graph: FlowGraph, errors: PublishValidationError[]): void {
  const blocos = graph.nodes.filter((n) => TIPOS_DO_INSTAGRAM.has(n.type)).sort(byId);
  if (blocos.length === 0) return;
  const gatilhos = graph.nodes.flatMap((n) => (n.type === 'trigger' && 'triggers' in n.config ? n.config.triggers : []));
  if (gatilhos.length > 0 && gatilhos.some((g) => g.kind !== 'instagram_comment')) {
    for (const n of blocos) {
      errors.push({
        node_id: n.id,
        code: 'instagram_sem_gatilho_de_comentario',
        message: `"${n.label}": os blocos do Instagram só funcionam quando todos os gatilhos são "Comentário no Instagram".`,
      });
    }
  }
  const saidas = new Map<string, string[]>();
  for (const e of graph.edges) saidas.set(e.source, [...(saidas.get(e.source) ?? []), e.target]);
  const privadas = new Set(blocos.filter((n) => n.type === 'instagram_private_reply').map((n) => n.id));
  if (privadas.size === 0) return;
  for (const publica of blocos.filter((n) => n.type === 'instagram_public_reply')) {
    // Alguma resposta privada é alcançável DEPOIS desta pública?
    const vistos = new Set<string>();
    const fila = [...(saidas.get(publica.id) ?? [])];
    let depois: string | null = null;
    while (fila.length > 0 && !depois) {
      const id = fila.shift()!;
      if (vistos.has(id)) continue;
      vistos.add(id);
      if (privadas.has(id)) depois = id;
      else fila.push(...(saidas.get(id) ?? []));
    }
    if (depois) {
      const privada = graph.nodes.find((n) => n.id === depois);
      errors.push({
        node_id: publica.id,
        code: 'instagram_publica_antes_da_privada',
        message: `"${publica.label}": a resposta em público está antes de "${privada?.label ?? 'Responder em privado'}". Ponha a resposta privada antes da pública no mesmo caminho.`,
      });
    }
  }
}

/** A aresta é a saída "Sem resposta" (o tempo acabou e a pessoa não respondeu). */
function ehSaidaSemResposta(e: FlowEdge): boolean {
  return (
    (e.condition.type === 'branch' && e.condition.branch_id === NO_REPLY_BRANCH_ID) ||
    (e.condition.type === 'class_match' && e.condition.value === NO_REPLY_BRANCH_ID)
  );
}

export const TEXTO_LONGO_NO_INSTAGRAM =
  'O texto (com as opções numeradas) passa do limite do Instagram (1000 bytes; acento e emoji contam mais de um).';

export const GATILHOS_MISTURADOS_NO_INSTAGRAM =
  "Automação que começa por comentário do Instagram não pode ter outros gatilhos quando manda mensagens.";

export const MENSAGEM_ANTES_DA_RESPOSTA_NO_INSTAGRAM =
  "No Instagram, a conversa só abre quando a pessoa responde. Ponha um 'Aguardar o contato responder' antes.";

/**
 * Automação que começa por comentário: a conversa do Direct só existe depois
 * que a pessoa responde (a resposta privada é o único primeiro envio possível,
 * e não abre conversa no CRM). Mensagem ou Pergunta alcançável a partir do
 * Início sem passar pela saída "Respondeu" de um "Aguardar até responder" sai
 * sempre por "Erro" — recusa na publicação, com a frase que diz o que fazer.
 * A saída "Sem resposta" da espera não conta: a pessoa não respondeu.
 */
function validarConversaNoDirect(graph: FlowGraph, errors: PublishValidationError[]): void {
  const gatilhos = graph.nodes.flatMap((n) => (n.type === 'trigger' && 'triggers' in n.config ? n.config.triggers : []));
  if (!gatilhos.some((g) => g.kind === 'instagram_comment')) return;
  // Mensagem e Pergunta saem pelo Direct quando a execução começou por
  // comentário, e pelo WhatsApp nas outras: com gatilhos misturados o mesmo
  // bloco mudaria de canal conforme quem o iniciou. Recusa.
  const conversa = graph.nodes.filter((n) => n.type === 'message' || n.type === 'question');
  if (conversa.length > 0 && gatilhos.some((g) => g.kind !== 'instagram_comment')) {
    const inicio = graph.nodes.find((n) => n.type === 'trigger');
    errors.push({
      node_id: inicio?.id ?? conversa[0]!.id,
      code: 'instagram_gatilhos_misturados',
      message: GATILHOS_MISTURADOS_NO_INSTAGRAM,
    });
  }
  // O teto do Direct é em BYTES, com as opções numeradas (o canal social não
  // desenha botão): a mesma régua do envio (`bytesDoTextoQueSai`). O texto aqui
  // ainda tem as variáveis cruas; o envio confere de novo depois de preenchê-las.
  const opcoesNativasNoDirect = PROVIDERS_SOCIAIS.every((p) => opcoesNativas(p));
  for (const n of [...conversa].sort(byId)) {
    const textos: Array<{ texto: string | undefined; comOpcoes: boolean }> =
      n.type === 'message'
        ? [
            { texto: n.config.body, comOpcoes: true },
            { texto: n.config.invalid_reply?.message, comOpcoes: true },
          ]
        : [
            { texto: n.config.question, comOpcoes: false },
            { texto: n.config.retry_message, comOpcoes: false },
            { texto: n.config.timeout_message, comOpcoes: false },
          ];
    const opcoes = n.type === 'message' ? (n.config.options as OutboundInteractive | undefined) : undefined;
    const passou = textos.some(
      ({ texto, comOpcoes }) =>
        typeof texto === 'string' &&
        bytesDoTextoQueSai(texto.trim(), comOpcoes ? opcoes : undefined, opcoesNativasNoDirect) >
          TETO_DO_TEXTO_DO_DIRECT_BYTES,
    );
    if (passou) {
      errors.push({
        node_id: n.id,
        code: 'instagram_texto_longo',
        message: `"${n.label}": ${TEXTO_LONGO_NO_INSTAGRAM}`,
      });
    }
  }
  const porId = new Map(graph.nodes.map((n) => [n.id, n]));
  const saidas = new Map<string, FlowEdge[]>();
  for (const e of graph.edges) saidas.set(e.source, [...(saidas.get(e.source) ?? []), e]);
  const fila = graph.nodes.filter((n) => n.type === 'trigger').map((n) => n.id);
  const vistos = new Set<string>();
  const acusados: FlowNode[] = [];
  while (fila.length > 0) {
    const id = fila.shift()!;
    if (vistos.has(id)) continue;
    vistos.add(id);
    const n = porId.get(id);
    if (!n) continue;
    if (n.type === 'message' || n.type === 'question') {
      acusados.push(n);
      continue;
    }
    const esperaResposta = n.type === 'wait' && n.config.mode === 'until_reply';
    for (const e of saidas.get(id) ?? []) {
      if (esperaResposta && !ehSaidaSemResposta(e)) continue;
      fila.push(e.target);
    }
  }
  for (const n of acusados.sort(byId)) {
    errors.push({
      node_id: n.id,
      code: 'instagram_mensagem_antes_da_resposta',
      message: `"${n.label}": ${MENSAGEM_ANTES_DA_RESPOSTA_NO_INSTAGRAM}`,
    });
  }
}

/**
 * Os nós que ENVIAM mensagem ao cliente num follow-up (#1540).
 *
 * `action` é o envio (texto, IA ou template); `collect`/`skill` são de roteiro
 * de atendimento — superfícies que não têm a marca "somente interno" e, num
 * fluxo interno, já teriam sido recusadas por `no_fora_da_superficie`.
 */
const NOS_QUE_ENVIAM: readonly NodeType[] = ['action'];

/**
 * SOMENTE INTERNO (#1540): o fluxo marcou que não fala com o cliente, e tem nó
 * de envio. Recusar na publicação é o único desfecho honesto — aceitar calado
 * daria ao operador a tela dizendo "publicado" enquanto uma mensagem sairia
 * para o cliente num fluxo que ele achava interno.
 */
function validarSomenteInterno(
  graph: FlowGraph,
  surface: FollowupFlowSurface,
  errors: PublishValidationError[],
): void {
  if (surface === 'atendimento') return;
  if (graph.settings?.somente_interno !== true) return;
  const enviadores = new Set(NOS_QUE_ENVIAM);
  for (const n of [...graph.nodes].sort(byId)) {
    if (!enviadores.has(n.type)) continue;
    errors.push({
      node_id: n.id,
      code: 'interno_com_envio',
      message: `O fluxo é "somente interno" e a caixa "${n.label}" envia mensagem ao cliente — tire a marca "somente interno" ou troque a caixa por "Lembrete interno".`,
    });
  }
}

const FRASE_DA_URL: Record<NonNullable<ReturnType<typeof problemaDaUrl>>, string> = {
  vazia: 'informe o endereço (URL) que a automação vai chamar.',
  segredo_na_url: 'a chave secreta não pode ir no endereço (URL) — API key em URL vaza em log. Use um cabeçalho com a chave.',
  invalida: 'o endereço (URL) não é válido. Escreva o endereço completo, como https://api.example.com/v1/recurso.',
  https_obrigatorio: 'o endereço precisa começar com https://.',
  credencial_na_url: 'o endereço não pode ter usuário e senha. Use um cabeçalho com a chave.',
  variavel_no_dominio: 'o domínio do endereço não pode ter variável: escreva o domínio fixo e use variáveis só no caminho, depois da primeira /.',
};

/**
 * Bloco "Requisição HTTP": a URL bem formada (https, sem chave, sem usuário e
 * senha), nenhum cabeçalho proibido, nenhum `{{segredo...}}` em texto, corpo
 * JSON válido (e só em método que leva corpo), a chave citada existe nesta
 * organização e o campo de destino do mapeamento pode ser escrito.
 */
function validarRequisicoesHttp(
  graph: FlowGraph,
  errors: PublishValidationError[],
  segredosExistentes?: ReadonlySet<string>,
  destinosDosSegredos?: ReadonlyMap<string, { nome: string; hosts_permitidos: string[] | null }>,
): void {
  for (const n of [...graph.nodes].sort(byId)) {
    if (n.type !== 'http_request') continue;
    const c = n.config;
    const erro = (code: PublishErrorCode, message: string) => errors.push({ node_id: n.id, code, message: `"${n.label}": ${message}` });
    const url = problemaDaUrl(c.url);
    if (url) erro(url === 'segredo_na_url' ? 'http_segredo_na_url' : 'http_url_invalida', FRASE_DA_URL[url]);
    // O domínio da URL é fixo (variável ali é recusada acima), então o host é conhecido no publish:
    // a chave citada que não pode ir para ele é recusada aqui, e não só no motor.
    const host = url ? null : hostDaUrlDoBloco(c.url);
    if (host && destinosDosSegredos) {
      const avisadas = new Set<string>();
      for (const id of segredosDoBloco(c)) {
        const d = destinosDosSegredos.get(id);
        if (!d || avisadas.has(id) || hostPermitido(host, d.hosts_permitidos)) continue;
        avisadas.add(id);
        erro(
          'http_host_nao_permitido',
          `${fraseDaChavePresa(d.nome, d.hosts_permitidos ?? [])} O endereço do bloco é ${host}: troque o endereço ou inclua ${host} na chave em Automações › Chaves secretas.`,
        );
      }
    }
    for (const h of c.headers) {
      if (cabecalhoProibido(h.name)) {
        erro('http_cabecalho_proibido', `o cabeçalho ${h.name} não pode ser definido pela automação.`);
      }
      if (h.kind === 'texto' && TENTATIVA_DE_SEGREDO.test(h.value)) {
        erro('http_segredo_no_texto', `não escreva a chave no texto do cabeçalho ${h.name}: escolha "Chave secreta" e selecione a chave.`);
      }
      if (cabecalhoComSegredoEscrito(h)) {
        erro('http_segredo_no_texto', `o cabeçalho ${h.name} leva credencial e o bloco é visível para toda a equipe. ${FRASE_DO_SEGREDO_ESCRITO}`);
      }
      if (h.kind === 'chave' && segredosExistentes && !segredosExistentes.has(h.secret_id)) {
        erro('http_segredo_inexistente', `a chave secreta do cabeçalho ${h.name} não existe mais — escolha outra em Automações › Chaves secretas.`);
      }
    }
    if (c.body !== undefined && c.body.trim() !== '') {
      if (!metodoTemCorpo(c.method)) {
        erro('http_corpo_no_get', 'requisição GET não leva corpo: troque o método ou apague o corpo.');
      } else if (TENTATIVA_DE_SEGREDO.test(c.body)) {
        erro('http_segredo_no_texto', 'não escreva a chave no corpo: escolha a chave em "Chave secreta no corpo".');
      } else if (!corpoEhJsonValido(c.body)) {
        erro('http_corpo_invalido', 'o corpo não é um JSON válido. Coloque cada variável entre aspas, como {"nome": "{{contact.name}}"}.');
      }
    }
    for (const b of c.body_secrets ?? []) {
      if (!metodoTemCorpo(c.method) || c.body === undefined || c.body.trim() === '') {
        erro('http_corpo_invalido', 'a chave secreta do corpo precisa de um corpo JSON (e de um método que leve corpo).');
      } else if (corpoEhJsonValido(c.body) && !porNoCaminhoDoCorpo(JSON.parse(c.body), b.path, '')) {
        erro('http_corpo_invalido', `o corpo não tem o campo de texto ${b.path} para receber a chave secreta. Escreva-o, como {"token": ""}.`);
      }
      if (segredosExistentes && !segredosExistentes.has(b.secret_id)) {
        erro('http_segredo_inexistente', 'a chave secreta do corpo não existe mais — escolha outra em Automações › Chaves secretas.');
      }
    }
    for (const m of c.mappings) {
      if (m.to && campoSoLeitura(m.to)) {
        erro('campo_so_leitura', `${nomeDoCampo(m.to)} não pode ser alterado por automação.`);
      }
    }
  }
}

/** Regras do roteiro de atendimento que o grafo sozinho não carrega. */
function validarSuperficie(
  graph: FlowGraph,
  surface: FollowupFlowSurface,
  errors: PublishValidationError[],
  roteiro?: RoteiroDoPublish,
  automacao?: ContextoDoPublish['automacao'],
): void {
  const permitidos = new Set<NodeType>(NOS_DA_SUPERFICIE[surface]);
  for (const n of [...graph.nodes].sort(byId)) {
    if (!permitidos.has(n.type)) {
      errors.push({
        node_id: n.id,
        code: 'no_fora_da_superficie',
        message:
          surface === 'atendimento'
            ? `A caixa "${n.label}" não é de roteiro de atendimento — use Pergunta, Skill e Fim.`
            : surface === 'automacao'
              ? `A caixa "${n.label}" não roda numa automação.`
              : n.type === 'crm_action' || n.type === 'field_op' || n.type === 'message' || n.type === 'question' || n.type === 'http_request' || TIPOS_DO_INSTAGRAM.has(n.type)
                ? `A caixa "${n.label}" é de automação e não roda num follow-up.`
                : `A caixa "${n.label}" é de roteiro de atendimento e não roda num follow-up.`,
      });
    }
  }
  if (surface === 'automacao') {
    for (const n of [...graph.nodes].sort(byId)) {
      // Telefone e e-mail do contato, etapa/funil/situação/responsável/origem do
      // negócio: a operação de campo não escreve (o motor recusa de novo).
      if (n.type === 'field_op') {
        for (const op of n.config.ops) {
          if (campoSoLeitura(op.target)) {
            errors.push({
              node_id: n.id,
              code: 'campo_so_leitura',
              message: `"${n.label}": ${nomeDoCampo(op.target)} não pode ser alterado por automação.`,
            });
          }
        }
      }
      // Pergunta e mensagem gravam a resposta num campo: o mesmo limite da
      // operação de campo (telefone, e-mail, etapa... não se escrevem).
      if ((n.type === 'message' || n.type === 'question') && n.config.save_to && campoSoLeitura(n.config.save_to)) {
        errors.push({
          node_id: n.id,
          code: 'campo_so_leitura',
          message: `"${n.label}": ${nomeDoCampo(n.config.save_to)} não pode ser alterado por automação.`,
        });
      }
      // Espera "imune à resposta" deixa a execução em `dormente`, fora da vaga
      // de automação do contato (índice e trava da 0986): duas execuções da
      // mesma automação conviveriam. Na automação a espera não ouve resposta.
      if (n.type === 'wait' && 'immune_to_reply' in n.config && n.config.immune_to_reply) {
        errors.push({
          node_id: n.id,
          code: 'espera_imune_na_automacao',
          message: `"${n.label}": na automação a espera não tem a opção "imune à resposta".`,
        });
      }
    }
  }
  // Espera em segundos e "até responder" são da automação: o motor dos
  // follow-ups não lê resposta assim nem tem o relógio para segundos.
  if (surface !== 'automacao') {
    for (const n of [...graph.nodes].sort(byId)) {
      if (
        n.type === 'wait' &&
        (n.config.mode === 'delay' ||
          n.config.mode === 'until_reply' ||
          n.config.mode === 'until_time' ||
          n.config.mode === 'until_date_field')
      ) {
        errors.push({
          node_id: n.id,
          code: 'espera_so_na_automacao',
          message: `"${n.label}": espera em segundos, "até responder", "até um dia e horário" e "até a data de um campo" só existem nas automações.`,
        });
      }
    }
  }
  if (surface === 'automacao' && automacao) {
    for (const n of [...graph.nodes].sort(byId)) {
      if (n.type !== 'crm_action') continue;
      for (const a of n.config.actions) {
        if (a.type !== 'start_automation') continue;
        if (a.pointer_id === automacao.pointerId) {
          errors.push({
            node_id: n.id,
            code: 'automacao_iniciar_propria',
            message: `"${n.label}": a automação não pode iniciar a si mesma — escolha outra.`,
          });
        } else if (automacao.existentes && !automacao.existentes.has(a.pointer_id)) {
          errors.push({
            node_id: n.id,
            code: 'automacao_iniciar_inexistente',
            message: `"${n.label}": a automação escolhida não existe mais — escolha outra na lista.`,
          });
        }
      }
    }
  }
  if (surface === 'automacao') {
    const conversa = graph.nodes.filter((n) => n.type === 'message' || n.type === 'question');
    const gatilhos = graph.nodes.flatMap((n) =>
      n.type === 'trigger' && 'triggers' in n.config ? n.config.triggers : [],
    );
    if (conversa.length > 0 && gatilhos.some((g) => !GATILHO_TRAZ_CONTATO[g.kind])) {
      for (const n of [...conversa].sort(byId)) {
        errors.push({
          node_id: n.id,
          code: 'mensagem_sem_contato',
          message: `"${n.label}": um dos gatilhos não traz contato, e a mensagem precisa de alguém para receber.`,
        });
      }
    }
  }
  if (surface === 'automacao') {
    validarBlocosDoInstagram(graph, errors);
    validarConversaNoDirect(graph, errors);
    validarRequisicoesHttp(graph, errors, automacao?.segredosExistentes, automacao?.destinosDosSegredos);
  }
  // Os gatilhos de uma AUTOMAÇÃO moram no nó Início (vários por fluxo); nos
  // follow-ups, em `pointer.trigger_config`, e o Início fica sem configuração.
  for (const n of [...graph.nodes].sort(byId)) {
    if (n.type !== 'trigger') continue;
    const temGatilhos = 'triggers' in n.config;
    if (surface === 'automacao' && !temGatilhos) {
      errors.push({
        node_id: n.id,
        code: 'gatilho_da_automacao',
        message: 'Escolha no Início quando a automação começa.',
      });
    }
    if (surface !== 'automacao' && temGatilhos) {
      errors.push({
        node_id: n.id,
        code: 'gatilho_da_automacao',
        message: 'Os gatilhos no Início são de automação; neste fluxo o disparo fica nas configurações.',
      });
    }
  }
  if (surface !== 'atendimento') {
    for (const n of [...graph.nodes].sort(byId)) {
      if (n.type !== 'condition' || surface === 'automacao') continue;
      if (n.config.checks.some(ehRegraNova)) {
        errors.push({
          node_id: n.id,
          code: 'regra_de_automacao',
          message: `A condição "${n.label}" usa uma regra de automação, que o follow-up não sabe avaliar.`,
        });
      }
    }
    return;
  }

  const saidas = new Map<string, number>();
  for (const e of graph.edges) {
    saidas.set(e.source, (saidas.get(e.source) ?? 0) + 1);
    if (e.condition.type !== 'always') {
      errors.push({
        node_id: e.source,
        code: 'roteiro_ramificado',
        message: 'No roteiro de atendimento as caixas são ligadas direto, sem condição.',
      });
    }
  }
  for (const [origem, n] of [...saidas.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (n > 1) {
      errors.push({
        node_id: origem,
        code: 'roteiro_ramificado',
        message: 'O roteiro de atendimento segue uma linha só: cada caixa liga em uma próxima.',
      });
    }
  }
  const chaves = new Map<string, string>();
  for (const n of [...graph.nodes].sort(byId)) {
    if (n.type !== 'collect') continue;
    const dona = chaves.get(n.config.key);
    if (dona !== undefined) {
      errors.push({
        node_id: n.id,
        code: 'campo_repetido',
        message: `O campo "${n.config.key}" já é perguntado em outra caixa — cada pergunta grava um campo diferente.`,
      });
    } else {
      chaves.set(n.config.key, n.id);
    }
  }
  if (roteiro) {
    const ciclo = cicloDoEncadeamento(graph, roteiro);
    if (ciclo) {
      const fim = [...graph.nodes].sort(byId).find((n) => proximosDoGrafo({ nodes: [n] }).length > 0);
      errors.push({
        node_id: fim?.id ?? null,
        code: 'roteiro_em_ciclo',
        message: `O "ao concluir" volta a este roteiro pela cadeia (${['este roteiro', ...ciclo].join(' → ')}) — o cliente responderia as mesmas perguntas sem fim. Escolha outro roteiro ou "Nada".`,
      });
    }
  }
}

const LONG_WAIT_THRESHOLD_MS = 86_400_000; // 24h
const MIN_CYCLE_WAIT_MS = 300_000; // 5min
const MAX_PATH_STEPS = 30;
/**
 * O QUE o teto de passos conta (#2896): o que o CLIENTE sente, não o que a tela
 * desenha.
 *
 * O teto existe para limitar o tamanho da cadência — quantas vezes o cliente é
 * tocado e quanto ele espera entre os toques. Contar TODO nó do caminho com o
 * mesmo peso fazia a medida mentir: o fluxo de retomada do reporter (gatilho,
 * filtro de entrada, 7 × mensagem + condição + tag, 7 esperas, mover para
 * Perdido e fim) soma 32 nós e era recusado, embora só 14 deles — 7 mensagens e
 * 7 esperas — cheguem ao cliente. Os outros 18 (gatilho, condição, tag, mover,
 * fim) são trabalho interno e não somam toque nenhum; do jeito antigo QUALQUER
 * cadência que registrasse algo por toque estourava com 6 ou 7 toques, e a
 * única saída era cortar toque.
 *
 * Então conta quem produz algo que o cliente lê (mensagem, pergunta, o turno em
 * que a skill entra no contexto do agente) ou quem o faz esperar (`wait`, e as
 * caixas que ficam esperando a resposta com prazo — `ai_classify` e
 * `match_reply`, que `isSufficientWaitNode` já trata como espera). Roteamento
 * (`condition`, `repeat`) e ação interna (`internal_task`, `move_lead`,
 * `edit_lead_tag`) não contam: não mudam nada do que o cliente sente, que é a
 * única coisa que o teto prometeu medir.
 *
 * O `Record` é exaustivo DE PROPÓSITO: um tipo de nó novo quebra o typecheck
 * até alguém dizer se ele conta. Com um `Set` de contados, o tipo novo cairia
 * fora da conta sem ninguém notar — que é exatamente como o teto passou a
 * mentir.
 */
export const CONTA_NO_TETO: Record<NodeType, boolean> = {
  // Fala com o cliente.
  action: true, // mensagem: texto, IA ou modelo
  collect: true, // pergunta do roteiro de atendimento
  skill: true, // o turno em que a skill entra no contexto do agente
  // Faz o cliente esperar.
  wait: true,
  ai_classify: true, // parado esperando a resposta classificar (grace)
  match_reply: true, // parado esperando a resposta casar o texto (grace)
  // Controle e trabalho interno: não chegam ao cliente.
  trigger: false, // entrada do fluxo
  condition: false, // decide o caminho
  repeat: false, // conta as voltas
  internal_task: false, // lembrete para a equipe
  move_lead: false, // move o card no funil
  edit_lead_tag: false, // grava tag no lead
  end: false, // desfecho
  // Blocos das automações visuais (Hiperbold, superfície `automacao`).
  message: true, // mensagem ao cliente
  question: true, // pergunta ao cliente (e espera a resposta)
  instagram_private_reply: true, // resposta privada no Direct
  instagram_public_reply: true, // resposta pública no comentário
  crm_action: false, // efeito no CRM
  field_op: false, // grava campo
  instagram_check_follow: false, // consulta se segue
  http_request: false, // chama outro sistema (não fala com o cliente)
};

function waitMs(config: Extract<FlowNode, { type: 'wait' }>['config']): number {
  return duracaoMaximaDaEspera(config);
}

/**
 * A wait node whose duration meets the 5min floor required to break a cycle.
 *
 * Os blocos de conversa que ESPERAM resposta (pergunta, mensagem com opções,
 * "até responder") também quebram o ciclo: só andam com o prazo vencido ou com
 * o contato escrevendo — e uma volta por mensagem do contato é conversa, não
 * rajada (o teto de 30 por hora e as 20 visitas por bloco seguram o resto).
 */
function isSufficientWaitNode(node: FlowNode): boolean {
  if (node.type === 'match_reply') return node.config.grace_timeout_ms >= MIN_CYCLE_WAIT_MS;
  if (node.type === 'question') return node.config.timeout_ms >= MIN_CYCLE_WAIT_MS;
  if (node.type === 'message') return (node.config.reply_timeout_ms ?? 0) >= MIN_CYCLE_WAIT_MS && !!node.config.options;
  if (node.type !== 'wait') return false;
  return duracaoMinimaDaEspera(node.config) >= MIN_CYCLE_WAIT_MS;
}

function buildOutEdges(edges: FlowEdge[]): Map<string, FlowEdge[]> {
  const map = new Map<string, FlowEdge[]>();
  for (const edge of edges) {
    const list = map.get(edge.source);
    if (list) list.push(edge);
    else map.set(edge.source, [edge]);
  }
  return map;
}

function bfsReachable(startIds: string[], outEdges: Map<string, FlowEdge[]>): Set<string> {
  const visited = new Set<string>(startIds);
  const queue = [...startIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of outEdges.get(id) ?? []) {
      if (!visited.has(edge.target)) {
        visited.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return visited;
}

/**
 * Tarjan strongly-connected-components. Returned components are in the
 * algorithm's natural finishing order, which is the REVERSE of a topological
 * order of the condensation DAG (a component finishes only after every
 * component reachable from it has already finished). Callers that need a
 * source-to-sink sweep should iterate the result back-to-front.
 */
function stronglyConnectedComponents(
  nodeIds: string[],
  outEdges: Map<string, FlowEdge[]>
): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  function strongconnect(v: string) {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const edge of outEdges.get(v) ?? []) {
      const w = edge.target;
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  }

  for (const id of nodeIds) {
    if (!indices.has(id)) strongconnect(id);
  }
  return components;
}

/**
 * Whether a component (as returned by stronglyConnectedComponents) is an
 * actual cycle in `outEdges`: more than one node, or a single node with a
 * self-loop.
 */
function isCycleComponent(component: string[], outEdges: Map<string, FlowEdge[]>): boolean {
  if (component.length > 1) return true;
  const onlyId = component[0]!; // Tarjan never yields an empty component
  return (outEdges.get(onlyId) ?? []).some((e) => e.target === onlyId);
}

/**
 * SCC condensation + topological forward sweep from the trigger, computing —
 * per component reachable from it — the MAX accumulated wait (fixed ->
 * duration_ms, smart -> max_ms) and MAX accumulated step count over any path
 * from the trigger. A component's own internal wait/step total is counted
 * once no matter how many original-graph cycles loop inside it (implements
 * "cycles count 1 iteration"). Polynomial (O(V+E)): no per-path enumeration,
 * so branching/reconverging DAGs can't blow it up.
 *
 * O passo contado é o que o CLIENTE sente (`CONTA_NO_TETO`, #2896) — mensagem,
 * pergunta, espera — e nunca o nó interno que só registra estado.
 *
 * ponytail: dentro de um SCC multi-ramo o total soma TODOS os waits/nós do
 * componente — upper bound conservador (nunca aceita grafo ruim; pode gerar
 * 422 a mais num SCC com sub-loops independentes). Máximo exato por caminho
 * simples é NP-difícil; upgrade só se 422 falso-positivo aparecer na prática.
 */
function analyzeCondensedPaths(
  startId: string,
  nodes: FlowNode[],
  nodesById: Map<string, FlowNode>,
  outEdges: Map<string, FlowEdge[]>
): { longWaitNodeIds: Set<string>; maxStepsExceeded: boolean } {
  const longWaitNodeIds = new Set<string>();
  let maxStepsExceeded = false;

  const components = stronglyConnectedComponents(
    nodes.map((n) => n.id),
    outEdges
  );
  const componentIndexById = new Map<string, number>();
  components.forEach((comp, idx) => comp.forEach((id) => componentIndexById.set(id, idx)));

  const waitWeight = components.map((comp) =>
    comp.reduce((sum, id) => {
      const node = nodesById.get(id);
      return node && node.type === 'wait' ? sum + waitMs(node.config) : sum;
    }, 0)
  );
  // O passo do teto é o que o cliente sente: mensagem, pergunta, espera. Um nó
  // interno (condição, tag, mover, fim) não conta — ver `CONTA_NO_TETO` (#2896).
  const stepWeight = components.map((comp) =>
    comp.reduce((sum, id) => {
      const node = nodesById.get(id);
      return node !== undefined && CONTA_NO_TETO[node.type] ? sum + 1 : sum;
    }, 0)
  );

  const condOut = new Map<number, Set<number>>();
  for (const edgeList of outEdges.values()) {
    for (const edge of edgeList) {
      const cu = componentIndexById.get(edge.source);
      const cv = componentIndexById.get(edge.target);
      if (cu === undefined || cv === undefined || cu === cv) continue;
      const succs = condOut.get(cu);
      if (succs) succs.add(cv);
      else condOut.set(cu, new Set([cv]));
    }
  }

  const startComp = componentIndexById.get(startId);
  if (startComp === undefined) return { longWaitNodeIds, maxStepsExceeded };

  const arriveWait = new Map<number, number>([[startComp, 0]]);
  const arriveSteps = new Map<number, number>([[startComp, 0]]);

  // components[] is in reverse-topological (Tarjan finishing) order; walking
  // it back-to-front visits every predecessor component before its successors.
  for (let idx = components.length - 1; idx >= 0; idx--) {
    const arrivedWait = arriveWait.get(idx);
    if (arrivedWait === undefined) continue; // not reachable from the trigger
    const arrivedSteps = arriveSteps.get(idx)!;

    const totalWait = arrivedWait + waitWeight[idx]!;
    const totalSteps = arrivedSteps + stepWeight[idx]!;

    if (totalSteps > MAX_PATH_STEPS) maxStepsExceeded = true;

    for (const id of components[idx]!) {
      const node = nodesById.get(id);
      if (
        node &&
        node.type === 'action' &&
        node.config.mode === 'ai_message' &&
        !node.config.fallback_template_id &&
        totalWait >= LONG_WAIT_THRESHOLD_MS
      ) {
        longWaitNodeIds.add(id);
      }
    }

    for (const succ of condOut.get(idx) ?? []) {
      arriveWait.set(succ, Math.max(arriveWait.get(succ) ?? -Infinity, totalWait));
      arriveSteps.set(succ, Math.max(arriveSteps.get(succ) ?? -Infinity, totalSteps));
    }
  }

  return { longWaitNodeIds, maxStepsExceeded };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id.localeCompare(b.id);
}

/**
 * Trava da multiplicação das voltas de um ciclo com `repeat` (#2977). O número
 * EXATO não muda veredito nenhum — qualquer coisa acima do teto do motor já
 * recusa — e sem a trava um desenho patológico (muitos `repeat` dentro do MESMO
 * ciclo) poria `Infinity` na mensagem do 422 em vez de um número que a pessoa lê.
 */
const TETO_DAS_VOLTAS = 1_000_000;

export interface CustoNoMotorDoFluxo {
  /** Ticks que o motor gasta no caminho mais caro a partir do gatilho. */
  total: number;
  /** O ciclo com `repeat` que mais pesa no caminho MAIS CARO — o que a recusa nomeia. `null` se esse caminho não passa por `repeat`. */
  cicloDeRepeat: { node_id: string; voltas: number; peso: number } | null;
}

/**
 * O custo, em ticks do MOTOR (ver `custo-no-motor.ts`), do caminho mais caro a
 * partir do gatilho — o que o `steps_taken` gasta até o fim do fluxo (#2965).
 *
 * O ciclo entra nesta soma, e entra de duas formas (#2977):
 *
 * - cada componente de ciclo vale no MÍNIMO uma volta completa (o piso: uma
 *   volta que o lead faz) e a soma SEGUE pelos sucessores do ciclo. Antes, a
 *   aresta que entrava num ciclo era descartada e tudo o que só se alcançava
 *   DEPOIS dele nunca era somado — o mantenedor mediu isso na issue: `repeat` +
 *   cauda linear de 86 ticks publicava, porque o custo linear dava 1;
 * - o ciclo que tem `repeat` vale as voltas que ele permite. O motor lê o número
 *   de voltas da resposta do lead (`node-handlers.ts`, caso `repeat`), limitado
 *   por `max_count`, e o teto do motor tem de aguentar o PIOR caso: `max_count`
 *   voltas vezes o peso do ciclo, mais UMA passada pelo próprio `repeat` — a que
 *   acha `taken >= total` e sai pela saída `done`. Dois `repeat` no mesmo ciclo
 *   (aninhados) MULTIPLICAM as voltas entre si; nunca somam.
 *
 * O peso de uma volta é a soma dos nós do componente — upper bound, a mesma
 * doutrina conservadora do `ponytail` de `analyzeCondensedPaths`: nunca aceita um
 * grafo que morre; pode recusar um a mais.
 *
 * Ciclo SEM `repeat` continua valendo só o piso: quantas voltas ele dá não está
 * declarado em lugar nenhum (depende da resposta), e o teto prefere não inventar
 * número.
 */
export function custoNoMotorDoFluxo(graph: FlowGraph): CustoNoMotorDoFluxo {
  const semCiclo: CustoNoMotorDoFluxo = { total: 0, cicloDeRepeat: null };
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const outEdges = buildOutEdges(graph.edges);
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  if (!trigger) return semCiclo;

  const components = stronglyConnectedComponents(
    graph.nodes.map((n) => n.id),
    outEdges
  );
  const componentIndexById = new Map<string, number>();
  components.forEach((comp, idx) => comp.forEach((id) => componentIndexById.set(id, idx)));

  const emCiclo = components.map((comp) => isCycleComponent(comp, outEdges));

  /** O que uma volta pelo componente custa: todos os nós dele, contados uma vez. */
  const peso = components.map((comp) =>
    comp.reduce((sum, id) => {
      const node = nodesById.get(id);
      return sum + (node ? CUSTO_NO_MOTOR[node.type] : 0);
    }, 0)
  );

  const voltas = components.map((comp, idx) => {
    if (!emCiclo[idx]) return 1;
    let voltasDeclaradas = 1;
    for (const id of comp) {
      const node = nodesById.get(id);
      if (node?.type === 'repeat') {
        voltasDeclaradas = Math.min(voltasDeclaradas * node.config.max_count, TETO_DAS_VOLTAS);
      }
    }
    return voltasDeclaradas;
  });

  /**
   * A passada EXTRA do `repeat`: além das `max_count` voltas pelo corpo, ele
   * ainda decide uma vez que `taken >= total` e segue pela saída `done`.
   */
  const passadaDoRepeat = components.map((comp, idx) => {
    if (!emCiclo[idx]) return 0;
    return comp.reduce((sum, id) => {
      const node = nodesById.get(id);
      return node?.type === 'repeat' ? sum + CUSTO_NO_MOTOR.repeat : sum;
    }, 0);
  });

  const custoDoComponente = components.map((_, idx) => peso[idx]! * voltas[idx]! + passadaDoRepeat[idx]!);

  const detalheDoCiclo = components.map((comp, idx) => {
    if (!emCiclo[idx]) return null;
    const repeatId = comp.filter((id) => nodesById.get(id)?.type === 'repeat').sort()[0];
    if (repeatId === undefined) return null;
    return { node_id: repeatId, voltas: voltas[idx]!, peso: peso[idx]! };
  });

  const condOut = new Map<number, Set<number>>();
  for (const edgeList of outEdges.values()) {
    for (const edge of edgeList) {
      const cu = componentIndexById.get(edge.source);
      const cv = componentIndexById.get(edge.target);
      if (cu === undefined || cv === undefined || cu === cv) continue;
      const succs = condOut.get(cu);
      if (succs) succs.add(cv);
      else condOut.set(cu, new Set([cv]));
    }
  }

  const startComp = componentIndexById.get(trigger.id);
  if (startComp === undefined) return semCiclo;
  // Gatilho DENTRO de um ciclo: o motor não produz esse desenho (o gatilho é a
  // entrada) e somar voltas por ele não diria nada. Fica fora, como no #2965.
  if (emCiclo[startComp]) return semCiclo;

  const chegaEm = new Map<number, number>([[startComp, 0]]);
  // O ciclo com `repeat` que mais pesa no caminho MAIS CARO até cada componente:
  // a recusa cita o repeat do caminho que estoura, não o de um ramo paralelo.
  const cicloNoCaminho = new Map<number, CustoNoMotorDoFluxo['cicloDeRepeat']>([[startComp, null]]);
  let total = 0;
  let cicloDeRepeat: CustoNoMotorDoFluxo['cicloDeRepeat'] = null;

  // `components[]` está em ordem reversa de topologia (fim do Tarjan): varrer de
  // trás para frente visita todo componente ANTES dos seus sucessores.
  for (let idx = components.length - 1; idx >= 0; idx--) {
    const chegou = chegaEm.get(idx);
    if (chegou === undefined) continue; // não é alcançável a partir do gatilho
    const custoAqui = chegou + custoDoComponente[idx]!;

    const herdado = cicloNoCaminho.get(idx) ?? null;
    const detalhe = detalheDoCiclo[idx];
    const cicloAqui =
      detalhe && (herdado === null || detalhe.peso * detalhe.voltas > herdado.peso * herdado.voltas)
        ? detalhe
        : herdado;

    if (custoAqui > total) {
      total = custoAqui;
      cicloDeRepeat = cicloAqui;
    }

    for (const succ of condOut.get(idx) ?? []) {
      if (custoAqui > (chegaEm.get(succ) ?? -Infinity)) {
        chegaEm.set(succ, custoAqui);
        cicloNoCaminho.set(succ, cicloAqui);
      }
    }
  }

  return { total, cicloDeRepeat };
}


/**
 * Toda saída declarada do nó precisa levar a algum lugar, e a mensagem nomeia
 * QUAL ficou solta. Serve tanto ao `condition` por regra quanto ao
 * `ai_classify` migrado: a pergunta é a mesma — "existe aresta para este
 * ramo?" — e escrevê-la duas vezes é como a cobertura de classes ficou para
 * trás quando os ramos nasceram.
 */
function cobrirRamos(
  node: FlowNode,
  outgoing: FlowEdge[],
  errors: PublishValidationError[],
  nomes: NomesDeValor
): void {
  for (const branch of nodeBranches(node)) {
    if (outgoing.some((e) => branchIdForCondition(node, e.condition) === branch.id)) continue;
    if (branch.kind === 'fallback') {
      errors.push({
        node_id: node.id,
        code: 'missing_always_fallback',
        branch_id: branch.id,
        message: `Nó "${node.id}" não tem a saída de escape: um negócio que não se encaixar em nenhuma saída fica parado aqui.`,
      });
      continue;
    }
    errors.push({
      node_id: node.id,
      code: 'missing_branch_edge',
      branch_id: branch.id,
      message: `Nó "${node.id}": a saída "${rotuloDoRamo(branch, nomes)}" não está ligada a nada.`,
    });
  }
}

/**
 * #2065 — nó `move_lead` sem etapa de destino, ou com uma etapa que não existe
 * mais / está arquivada. Mesma régua da `conferirRegras` logo abaixo (e o mesmo
 * `ContextoDoPublish.etapas`, lido por quem publica): o que só o banco sabe chega
 * injetado, nunca adivinhado. Sem `contexto.etapas` a conferência não roda — ela
 * recusa o que é visível, não o que é incerto.
 *
 * Etapa de perda exige motivo da perda no próprio bloco: sem ele o motor seria
 * recusado com 422 (`lost_reason_required`) e o fluxo seguiria como se o card
 * tivesse andado. Etapa que NÃO é de perda publica sem motivo — e aceita o
 * motivo mesmo assim, para não reprovar rascunho que trocou de destino.
 */
function conferirEtapaDestino(
  node: Extract<FlowNode, { type: 'move_lead' }>,
  contexto: ContextoDoPublish,
  errors: PublishValidationError[]
): void {
  const destino = node.config.stage_id.trim();
  const ancora = { node_id: node.id };
  if (destino === '') {
    errors.push({
      ...ancora,
      code: 'etapa_destino_ausente',
      message: `A caixa "${node.label}" não tem etapa de destino — escolha para onde o card vai.`,
    });
    return;
  }
  if (contexto.etapas === undefined) return;
  const etapa = contexto.etapas.get(destino);
  if (etapa === undefined) {
    errors.push({
      ...ancora,
      code: 'etapa_destino_ausente',
      message: `A caixa "${node.label}" aponta para uma etapa que não existe mais — escolha a etapa na lista.`,
    });
    return;
  }
  if (etapa.arquivada) {
    errors.push({
      ...ancora,
      code: 'etapa_destino_arquivada',
      message: `A caixa "${node.label}" move para a etapa arquivada "${etapa.nome}" — escolha uma etapa ativa.`,
    });
  }
  if (!etapa.isPerda) return;
  const motivo = (node.config.lost_reason ?? '').trim();
  if (motivo === '') {
    errors.push({
      ...ancora,
      code: 'motivo_da_perda_ausente',
      message: `A caixa "${node.label}" move para a etapa de perda "${etapa.nome}" — escolha o motivo da perda no bloco antes de publicar.`,
    });
    return;
  }
  const foraDoVocabulario = recusaDeMotivoForaDoVocabulario({
    motivo,
    settingsDoFunil: etapa.settingsDoFunil,
  });
  if (foraDoVocabulario) {
    errors.push({
      ...ancora,
      code: 'motivo_da_perda_invalido',
      message: `A caixa "${node.label}" tem um motivo de perda que não está na lista deste funil — escolha um dos motivos configurados.`,
    });
  }
}

/**
 * #2065 — nó `edit_lead_tag` sem tag (lista vazia ou com tag em branco). O
 * schema aceita, porque o rascunho tem de salvar trabalho pela metade; publicado,
 * um nó que não grava nada é mentira de interface.
 */
function conferirTags(
  node: Extract<FlowNode, { type: 'edit_lead_tag' }>,
  errors: PublishValidationError[]
): void {
  const tags = node.config.tags.map((t) => t.trim());
  if (tags.length === 0 || tags.some((t) => t === '')) {
    errors.push({
      node_id: node.id,
      code: 'tag_ausente',
      message: `A caixa "${node.label}" não tem tag para gravar — escreva ao menos uma tag.`,
    });
  }
}

/**
 * Uma regra de condição que não pode decidir nada. O rascunho aceita todas estas
 * formas — trabalho pela metade precisa salvar —, mas publicada cada uma é uma
 * saída que nunca é tomada ou que é tomada sempre, com cara de regra pronta:
 * - valor vazio: `eq` nunca casa e `neq` sempre casa;
 * - passos que não é número: maior/menor nunca é verdadeiro;
 * - etapa que não é `stage_id` de etapa ativa: o motor compara o id, então o
 *   nome digitado ("PAGO", fluxo anterior ao seletor) nunca casa, e etapa
 *   arquivada não tem negócio nenhum dentro.
 * Vale nos DOIS modos do nó: nenhuma destas formas funciona em fluxo antigo
 * também, então recusá-las não reprova nada que esteja decidindo de verdade.
 */
function conferirRegras(
  node: Extract<FlowNode, { type: 'condition' }>,
  contexto: ContextoDoPublish,
  errors: PublishValidationError[]
): void {
  node.config.checks.forEach((check, i) => {
    const regra = `Regra ${i + 1}`;
    const ancora = {
      node_id: node.id,
      ...(node.config.branching === 'per_check' && check.id !== undefined ? { branch_id: check.id } : {}),
    };
    if (ehRegraNova(check)) {
      // Regra de automação: o operador que compara precisa de valor; "tem valor"
      // e "está vazio" não. O resto (ids de etapa/funil) o schema já exige.
      if (
        check.kind === 'field' &&
        check.op !== 'has_value' &&
        check.op !== 'empty' &&
        String(check.value ?? '').trim() === ''
      ) {
        errors.push({ ...ancora, code: 'empty_check_value', message: `${regra} sem valor: preencha ou remova a regra.` });
      }
      // "Está no horário?": um horário que não dá para obedecer responderia
      // "Não" para sempre, calado.
      if (check.kind === 'business_hours' && !horarioDaEsperaValido(check)) {
        errors.push({
          ...ancora,
          code: 'horario_da_espera_invalido',
          message: `${regra}: o horário precisa de pelo menos um dia e de um início antes do fim.`,
        });
      }
      return;
    }
    const valor = String(check.value).trim();

    // A regra de DATA é conferida antes: o "valor" dela é um prazo em dias, e
    // `0` — o caso mais comum, "hoje ou já passou" — não pode cair no
    // `empty_check_value` nem no `check_value_not_number`.
    if (check.field === 'lead_date') {
      const chave = (check.key ?? '').trim();
      if (chave === '') {
        errors.push({
          ...ancora,
          code: 'campo_de_data_ausente',
          message: `${regra}: escolha o campo do negócio que guarda a data.`,
        });
        return;
      }
      // `valor` vazio NAO pode virar 0: `Number("")` e 0, e um prazo em branco
      // publicaria como "inclui hoje" sem ninguem ver. Achado pela prova de tela.
      const dias = valor === "" ? Number.NaN : Number(valor);
      if (!Number.isInteger(dias) || dias < 0) {
        errors.push({
          ...ancora,
          code: 'check_value_not_number',
          message: `${regra}: o prazo em dias é um número de 0 para cima (0 inclui hoje).`,
        });
      }
      return;
    }

    if (valor === '') {
      errors.push({ ...ancora, code: 'empty_check_value', message: `${regra} sem valor: preencha ou remova a regra.` });
      return;
    }
    // A pergunta é "o motor consegue comparar isto?", não "é inteiro?": ele
    // compara passos como número, e um valor que vira número (inclusive escrito
    // como texto) decide de verdade. Recusar 2.5 seria recusar o que funciona.
    if (check.field === 'steps_taken' && !Number.isFinite(Number(valor))) {
      errors.push({
        ...ancora,
        code: 'check_value_not_number',
        message: `${regra}: “${valor}” não é um número de passos.`,
      });
      return;
    }
    if (check.field !== 'lead_stage' || contexto.etapas === undefined) return;

    const etapa = contexto.etapas.get(valor);
    if (etapa === undefined) {
      errors.push({
        ...ancora,
        code: 'check_stage_not_found',
        // Id que não existe mais não vira texto de tela; o nome digitado à mão,
        // sim — é a única pista de qual regra a pessoa escreveu.
        message: UUID_RX.test(valor)
          ? `${regra}: a etapa escolhida não existe mais — escolha a etapa na lista.`
          : `${regra}: “${valor}” não é uma etapa do funil — escolha a etapa na lista.`,
      });
      return;
    }
    if (etapa.arquivada) {
      errors.push({
        ...ancora,
        code: 'check_stage_archived',
        // "está arquivada" é o que o banco disse; "nenhum negócio fica nela" era
        // afirmação que o produto NÃO garante (mover um lead de volta não é barrado).
        message: `${regra}: a etapa “${etapa.nome}” foi arquivada e não está mais no quadro — escolha uma etapa ativa.`,
      });
    }
  });
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateFlowForPublish(
  graph: FlowGraph,
  contexto: ContextoDoPublish = {}
): PublishValidationResult {
  const { nodes, edges } = graph;
  const errors: PublishValidationError[] = [];
  const surface = contexto.surface ?? 'followup';
  validarSuperficie(graph, surface, errors, contexto.roteiro, contexto.automacao);
  validarSomenteInterno(graph, surface, errors);
  const etapas = contexto.etapas;
  const nomes: NomesDeValor = etapas ? { etapa: (id) => etapas.get(id)?.nome ?? null } : {};
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const outEdges = buildOutEdges(edges);
  const inEdges = buildOutEdges(edges.map((e) => ({ ...e, source: e.target, target: e.source })));

  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) {
    errors.push({
      node_id: null,
      code: 'no_trigger',
      message: 'O fluxo precisa de exatamente um nó trigger.',
    });
  }
  if (triggers.length > 1) {
    for (const extra of triggers.slice(1)) {
      errors.push({
        node_id: extra.id,
        code: 'multiple_triggers',
        message: `Nó trigger duplicado: "${extra.id}".`,
      });
    }
  }

  const startTrigger = triggers[0];
  if (startTrigger) {
    const reachable = bfsReachable([startTrigger.id], outEdges);
    for (const node of [...nodes].sort(byId)) {
      if (!reachable.has(node.id)) {
        errors.push({
          node_id: node.id,
          code: 'unreachable_node',
          message: `Nó "${node.id}" não é alcançável a partir do trigger.`,
        });
      }
    }

    const endNodes = nodes.filter((n) => n.type === 'end');
    const canReachEnd = bfsReachable(endNodes.map((n) => n.id), inEdges);
    for (const node of [...nodes].sort(byId)) {
      if (reachable.has(node.id) && !canReachEnd.has(node.id)) {
        errors.push({
          node_id: node.id,
          code: 'no_end_path',
          message: `Nó "${node.id}" não tem caminho até um nó de fim.`,
        });
      }
    }

    const { longWaitNodeIds, maxStepsExceeded } = analyzeCondensedPaths(
      startTrigger.id,
      nodes,
      nodesById,
      outEdges
    );
    const exigeModelo = contexto.exigeModeloForaDaJanela !== false;
    for (const id of exigeModelo ? [...longWaitNodeIds].sort() : []) {
      errors.push({
        node_id: id,
        code: 'long_wait_needs_template',
        message: `Nó "${id}" acumula ≥24h de espera e precisa de fallback_template_id.`,
      });
    }
    if (maxStepsExceeded) {
      errors.push({
        node_id: null,
        code: 'max_steps_exceeded',
        message: `O caminho mais longo a partir do trigger passa de ${MAX_PATH_STEPS} passos que o cliente sente (mensagem, pergunta, skill e espera) — tire um toque da cadência.`,
      });
    }

    // A SEGUNDA ponta do teto (#2965): o do MOTOR. O caminho LINEAR que custa mais
    // ticks do que o relógio consegue dar publicava e morria no meio — a inscrição
    // fechava com `cancel_reason = 'max_steps'` sem gravar as últimas caixas nem
    // chegar ao fim (medido pelo mantenedor: 14 toques × mensagem+tag+tag+espera
    // somam 86 ticks e o teto do motor é 80).
    //
    // A #2977 fechou a fronteira que este PR tinha deixado: o custo de um ciclo
    // de `repeat` não é "depende das voltas do lead" — é `max_count` vezes o peso
    // do ciclo, e o teto do motor tem de aguentar o pior caso (o número de voltas
    // sai da resposta do lead, `node-handlers.ts`, e o publish não manda nele).
    // A soma também SEGUE pelos sucessores do ciclo, então a cauda que só se
    // alcança depois do `repeat` volta a contar.
    // O roteiro de atendimento continua fora: quem o conduz é o motor do TURNO
    // (`atendimento.ts`, com o teto próprio), não o relógio.
    if (surface !== 'atendimento') {
      const { total: custoNoMotor, cicloDeRepeat } = custoNoMotorDoFluxo(graph);
      if (custoNoMotor > TETO_DE_PASSOS_DO_MOTOR) {
        // A caixa é nomeada pelo RÓTULO que a pessoa vê no editor, não pelo id
        // interno (`repeat-3`). E só cita o repeat que está no caminho que estoura
        // e dá mais de uma volta: com 1 volta, "reduza as voltas" é um conselho
        // impossível — quem estoura é a cadência.
        const repeatQuePesa = cicloDeRepeat && cicloDeRepeat.voltas > 1 ? cicloDeRepeat : null;
        const rotuloDoRepeat = repeatQuePesa
          ? graph.nodes.find((n) => n.id === repeatQuePesa.node_id)?.label ?? repeatQuePesa.node_id
          : null;
        errors.push({
          node_id: null,
          code: 'max_engine_steps_exceeded',
          message: `O caminho mais longo deste fluxo custa ${custoNoMotor} passos no motor (o relógio conta cada tick: gatilho, mensagem, espera e registro) e ele desiste da inscrição depois de ${TETO_DE_PASSOS_DO_MOTOR} — a retomada morreria no meio, sem chegar ao fim.${
            repeatQuePesa
              ? ` O trecho que a caixa "${rotuloDoRepeat}" repete custa ${repeatQuePesa.peso} passos por volta e ela permite até ${repeatQuePesa.voltas} voltas — reduza as voltas ou tire um toque de dentro do repetir.`
              : ' Encurte a cadência.'
          }`,
        });
      }
    }
  }

  // Espera imune é para cadência LONGA. Uma imune de dez minutos prende um lead
  // no meio da conversa: ele responde, e nada no motor encurta a espera — que é
  // exatamente o que a imunidade promete, e exatamente o que ninguém quer num
  // intervalo curto. O piso é o mesmo 24h que já separa espera curta de longa.
  for (const node of [...nodes].sort(byId)) {
    if (node.type !== 'wait') continue;
    const cfg = node.config;
    if (cfg.mode !== 'fixed' || cfg.immune_to_reply !== true) continue;
    if (cfg.duration_ms < LONG_WAIT_THRESHOLD_MS) {
      errors.push({
        node_id: node.id,
        code: 'immune_wait_too_short',
        message: `Nó "${node.id}" é imune à resposta e precisa de pelo menos 24h de espera.`,
      });
    }
  }

  // Espera com horário: o rascunho aceita o horário torto (o painel grava a cada
  // clique — ver `horarioDaEsperaSchema`), a publicação não. Um horário que não
  // dá para obedecer viraria "sem horário" no motor, e o toque sairia de
  // madrugada com a tela dizendo o contrário.
  for (const node of [...nodes].sort(byId)) {
    if (node.type !== 'wait') continue;
    const cfg = node.config;
    if (cfg.mode === 'smart' || cfg.mode === 'until_reply') continue;
    const horario = cfg.ate_o_horario;
    if (horario === undefined || horarioDaEsperaValido(horario)) continue;
    errors.push({
      node_id: node.id,
      code: 'horario_da_espera_invalido',
      message: `Nó "${node.id}": o horário da espera precisa de pelo menos um dia e de um início antes do fim.`,
    });
  }

  // Lote 6: o dia e a hora das esperas por horário. O rascunho aceita a hora em
  // branco (o painel grava a cada clique); a publicação não — o motor seguiria
  // na hora (ou sairia por "Sem data") sem ninguém ver por quê.
  for (const node of [...nodes].sort(byId)) {
    if (node.type !== 'wait') continue;
    const cfg = node.config;
    if (cfg.mode === 'until_time') {
      const falta =
        !horaValida(cfg.time)
          ? 'escolha a hora (HH:MM)'
          : cfg.when === 'in_days' && cfg.days === undefined
            ? 'diga daqui a quantos dias'
            : cfg.when === 'next_weekday' && cfg.weekday === undefined
              ? 'escolha o dia da semana'
              : null;
      if (falta) {
        errors.push({ node_id: node.id, code: 'hora_da_espera_invalida', message: `"${node.label}": ${falta}.` });
      }
    }
    if (cfg.mode === 'until_date_field') {
      const chave = cfg.field_key.trim();
      if (chave === '') {
        errors.push({
          node_id: node.id,
          code: 'campo_de_data_ausente',
          message: `"${node.label}": escolha o campo do negócio que guarda a data.`,
        });
      } else if (contexto.camposDeData && !contexto.camposDeData.has(chave)) {
        errors.push({
          node_id: node.id,
          code: 'campo_de_data_inexistente',
          message: `"${node.label}": o campo de data escolhido não existe em nenhum funil — escolha outro.`,
        });
      }
      if (!horaValida(cfg.time)) {
        errors.push({
          node_id: node.id,
          code: 'hora_da_espera_invalida',
          message: `"${node.label}": escolha a hora (HH:MM).`,
        });
      }
    }
  }

  // Cobertura por ramo — SÓ no modo 'per_check'. É deliberado que o modo
  // combinado fique de fora: hoje nenhuma regra exige aresta por resultado num
  // nó de condição, e passar a exigir reprovaria no publish fluxos v1 que estão
  // rodando. Regra nova só vale para a forma nova.
  for (const node of [...nodes].sort(byId)) {
    if (node.type !== 'condition' || node.config.branching !== 'per_check') continue;
    const outgoing = outEdges.get(node.id) ?? [];

    cobrirRamos(node, outgoing, errors, nomes);
  }

  for (const node of [...nodes].sort(byId)) {
    if (node.type === 'condition') conferirRegras(node, contexto, errors);
  }

  // Blocos de conversa: cada OPÇÃO da mensagem leva a algum lugar (a escolha
  // do contato não pode cair no escape), e a pergunta / "até responder" têm o
  // caminho de quem respondeu. "Sem resposta", "Resposta inválida" e "Erro"
  // soltos seguem pela saída comum — como o "Erro" dos blocos de CRM.
  for (const node of [...nodes].sort(byId)) {
    const outgoing = outEdges.get(node.id) ?? [];
    const ligado = (id: string) => outgoing.some((e) => branchIdForCondition(node, e.condition) === id);
    if (node.type === 'message' && node.config.options) {
      for (const item of node.config.options.items) {
        if (ligado(item.id)) continue;
        errors.push({
          node_id: node.id,
          code: 'missing_branch_edge',
          branch_id: item.id,
          message: `Nó "${node.id}": a opção "${item.label}" não está ligada a nada.`,
        });
      }
    }
    if (node.type === 'question' || (node.type === 'wait' && node.config.mode === 'until_reply')) {
      if (!ligado('else')) {
        errors.push({
          node_id: node.id,
          code: 'missing_always_fallback',
          branch_id: 'else',
          message: `Nó "${node.id}": a saída "Respondeu" não está ligada a nada.`,
        });
      }
    }
  }

  // #2065 — os nós de ação nascem sem destino (o rascunho valida só a forma) e
  // é AQUI que a escolha passa a ser obrigatória: publicar um nó que não move
  // nem grava nada seria dizer à pessoa que o fluxo faz o que ele não faz.
  for (const node of [...nodes].sort(byId)) {
    if (node.type === 'move_lead') conferirEtapaDestino(node, contexto, errors);
    if (node.type === 'edit_lead_tag') conferirTags(node, errors);
    if (node.type === 'action' && contexto.modelos !== undefined) {
      const { prontos, doCanal } = contexto.modelos;
      const cfg = node.config;
      const faltando =
        cfg.mode === 'template'
          ? !!cfg.template_id && !prontos.has(cfg.template_id) && !doCanal.has(cfg.template_id)
          : cfg.mode === 'ai_message' && !!cfg.fallback_template_id && !doCanal.has(cfg.fallback_template_id);
      if (faltando) {
        errors.push({ node_id: node.id, code: 'modelo_inexistente', message: MENSAGEM_MODELO_INEXISTENTE });
      }
    }
  }

  for (const node of [...nodes].sort(byId)) {
    if (node.type !== 'ai_classify' && node.type !== 'match_reply' && node.type !== 'repeat') continue;
    const outgoing = outEdges.get(node.id) ?? [];

    if (node.type === 'match_reply' || node.type === 'repeat' || node.config.branches !== undefined) {
      cobrirRamos(node, outgoing, errors, nomes);
      if (node.type === 'repeat') continue;
      if (node.config.grace_timeout_ms < 900_000) {
        errors.push({
          node_id: node.id,
          code: 'grace_too_short',
          message: `Nó "${node.id}" tem grace_timeout_ms abaixo do mínimo de 15min.`,
        });
      }
      continue;
    }

    for (const cls of node.config.classes) {
      const hasEdge = outgoing.some(
        (e) => e.condition.type === 'class_match' && e.condition.value === cls
      );
      if (!hasEdge) {
        errors.push({
          node_id: node.id,
          code: 'missing_class_edge',
          message: `Nó "${node.id}" não tem edge class_match para a classe "${cls}".`,
        });
      }
    }

    const hasNoReply = outgoing.some(
      (e) => e.condition.type === 'class_match' && e.condition.value === 'no_reply'
    );
    if (!hasNoReply) {
      errors.push({
        node_id: node.id,
        code: 'missing_no_reply_edge',
        message: `Nó "${node.id}" não tem edge class_match para "no_reply".`,
      });
    }

    const hasAlways = outgoing.some((e) => e.condition.type === 'always');
    if (!hasAlways) {
      errors.push({
        node_id: node.id,
        code: 'missing_always_fallback',
        message: `Nó "${node.id}" não tem edge "always" de fallback.`,
      });
    }

    if (node.config.grace_timeout_ms < 900_000) {
      errors.push({
        node_id: node.id,
        code: 'grace_too_short',
        message: `Nó "${node.id}" tem grace_timeout_ms abaixo do mínimo de 15min.`,
      });
    }
  }

  // cycle_without_wait — exact, not an approximation: a directed cycle with no
  // sufficient-wait node exists IFF removing every sufficient-wait node still
  // leaves a cycle (SCC with >1 node, or a self-loop) in the remaining
  // subgraph. Runs independently of trigger reachability — a node can carry
  // both unreachable_node and cycle_without_wait at once; that's intentional,
  // each signal is independently actionable for the editor UI.
  const sufficientWaitIds = new Set(nodes.filter(isSufficientWaitNode).map((n) => n.id));
  const remainingIds = nodes.map((n) => n.id).filter((id) => !sufficientWaitIds.has(id));
  const remainingEdges = edges.filter(
    (e) => !sufficientWaitIds.has(e.source) && !sufficientWaitIds.has(e.target)
  );
  const remainingOutEdges = buildOutEdges(remainingEdges);
  const cycleComponents = stronglyConnectedComponents(remainingIds, remainingOutEdges);
  for (const component of cycleComponents) {
    if (!isCycleComponent(component, remainingOutEdges)) continue;
    const nodeId = [...component].sort()[0]!;
    errors.push({
      node_id: nodeId,
      code: 'cycle_without_wait',
      message: `Ciclo sem espera mínima de 5min detectado (contém "${nodeId}").`,
    });
  }

  const warnings = avisosDoGatilho(contexto.trigger);

  if (errors.length === 0) {
    return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
  }

  errors.sort((a, b) => {
    const rankDiff = PUBLISH_ERROR_CODES.indexOf(a.code) - PUBLISH_ERROR_CODES.indexOf(b.code);
    if (rankDiff !== 0) return rankDiff;
    return (a.node_id ?? '').localeCompare(b.node_id ?? '');
  });

  return warnings.length > 0 ? { ok: false, errors, warnings } : { ok: false, errors };
}
