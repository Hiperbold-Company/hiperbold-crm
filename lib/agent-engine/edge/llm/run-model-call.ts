import { guardServiceTools } from "@/lib/atendimento/fronteira-server";
/**
 * SEAM ÚNICO de chamada de modelo: TODA chamada de LLM do harness passa por
 * runModelCall — agente, classificadores auxiliares e compaction usam esta MESMA
 * função (nenhum call site instancia provider).
 *
 * Por chamada: resolve a config da org no DB (BYOK em ai_provider_credentials +
 * knobs em organizations.settings->'llm'; troca de modelo/provider = UPDATE na
 * config, vale no run seguinte, sem restart) → checa o budget mensal ANTES de
 * sair byte para o provider → generateText do AI SDK → grava usage/custo em
 * llm_calls. A chave da org nunca entra em prompt, tool result ou log — ela só
 * cruza a fronteira na instância do provider.
 *
 * Shape do usage: `LanguageModelUsage` (node_modules/ai/dist/index.d.ts):
 * inputTokens/outputTokens totais + inputTokenDetails.{cacheReadTokens,
 * cacheWriteTokens}. Validado no ai@7 via scripts/smoke-llm.sh (modelo real) —
 * upgrade de major re-valida esses paths pelo mesmo gate (regra dura 16).
 */
import { generateText, stepCountIs, streamText, type ModelMessage, type ToolSet } from 'ai';
import type pg from 'pg';
import { z } from 'zod';

import { PROVEDOR_POR_ASSINATURA } from '@/lib/ai/pontos/provedores';
import { chamarComRetryUnicoEm401 } from '@/lib/ai/pontos/renovacao-da-assinatura';
import { sincronizarAvisoDaAssinatura } from '@/lib/ai/credenciais/aviso-da-assinatura';
import { renovarAssinaturaNoTurno } from '@/lib/ai/credenciais/login-codex';
import { createAdminClient } from '@/lib/supabase/admin';
import { PONTO_POR_ID } from '@/lib/ai/pontos/registro';
import { criarResolvedorDeCatalogo, type ModelPricingRow } from '@/lib/ai/runtime/cost';
// O par (provedor, modelo) é a mesma régua em TODOS os caminhos de execução:
// este seam, a resolução dos pontos, a mídia, o embedding e o runtime do agente
// importam daqui — não cada um a sua (issue #2377).
import { ParProvedorModeloInvalidoError, validarParProvedorModelo } from '@/lib/ai/par-provedor-modelo';
import { decidirQuedaDoProvedor } from '@/lib/ai/pontos/reserva-da-assinatura';
import { scrubMessage } from '@/lib/sentry/scrub';
import { identificarConteudoBloqueado } from './conteudo-bloqueado';

import type { Logger } from '../../obs/logger';
import { decidirParaOSeam, marcarEconomicoQueFalhou } from './binding-do-ponto';
import {
  resolveOrgLlmConfig,
  temChaveDeReserva,
  type LlmEdgeConfig,
  type OrcamentoDaOrg,
  type OrgLlmConfig,
  type OrigemDaChaveLlm,
} from './credentials';
import {
  AVISO_CORPO,
  AVISO_TITULO,
  BLOQUEIO_TITULO,
  CORPO_TETO_DO_PLANO,
  corpoDoBloqueio,
  decidirOrcamento,
  decidirTetoDoPlano,
  lerTetoDoPlano,
  MOTIVO_TETO_DO_PLANO,
  TITULO_TETO_DO_PLANO,
  normalizarModoDeOrcamento,
  LIMIAR_PADRAO_PCT,
  PURPOSES_ISENTOS,
  SQL_ORCAMENTO,
  type ChaveDeOrcamento,
} from './orcamento';
import {
  aplicarChaveNoVeredicto,
  carteiraBloqueioTitulo,
  corpoDoBloqueioDaCarteira,
  deveConsultarCarteira,
  interpretarVeredictoDaCarteira,
  normalizarModoDeBilling,
  SQL_MODO_DE_BILLING,
  type ModoDeBilling,
  type VeredictoDaCarteira,
} from './carteira';
import {
  corpoDaSuspensaoDeAssinatura,
  deveConsultarAssinatura,
  PURPOSES_ISENTOS_DA_ASSINATURA,
  TITULO_ASSINATURA_SUSPENSA,
} from './assinatura';
import { decidirModeloDaChave, idNaRotaDaInstalacao, primeiraVezDoModelo } from '@/lib/ai/modelos-da-instalacao';
import { modelosDaInstalacaoPeloDb } from './modelos-da-instalacao';
import { custoCentsComCatalogo, custoTerraPorPassos, costCents, gravacaoDeUmaHora } from './pricing';
import { custoDoModeloForaDoMotor } from './pricing-do-catalogo';
import { chaveDeOrcamentoDaInstalacao } from '../../../instalacao/comportamento';
import { cobrancaLigadaComMemo } from '../../../instalacao/modulos';
import { createDefaultRegistry, type ProviderRegistry } from './providers';
import { buildStablePrefix } from './stable-prefix';
import {
  degrauDoEnderecoProprio,
  prazoLegivel,
  RECUSA_A_PARTIR_DE,
} from './prazo-do-endereco-proprio';

// Call sites FORA da camada importam os tipos daqui — nunca de 'ai' direto
// (o seam é a única porta). `tool` idem: é como o agente define ToolSet sem
// tocar no SDK.
export { tool } from 'ai';
export type { ModelMessage, ToolSet } from 'ai';
export type { LlmEdgeConfig } from './credentials';
export { llmEdgeConfigFromEnv, LlmNotConfiguredError } from './credentials';

/** Teto mensal da org esgotado — runs recusados ANTES do provider (zero tokens). */
export class LlmBudgetExceededError extends Error {
  // Tipo alargado para `string` (em vez do literal inferido) só para permitir a
  // subclasse `LlmCarteiraEsgotadaError` (fase F3, decisão 7) sobrescrever com o
  // próprio literal: sem isto o TypeScript recusa o `override` por variância de
  // literal, mesmo o valor em si nunca mudando de tipo em runtime.
  override readonly name: string = 'llm_budget_exceeded';
  /**
   * Veto PERMANENTE de negócio, não incidente de sistema — tentar de novo daqui
   * a um minuto dá o mesmo resultado, porque o gasto não diminui sozinho.
   *
   * Quem lê isto é a fila (`workers/agent-worker/main.ts`), para mandar o job
   * ao `cancelJob` em vez do `failJob`: sem isso, um bloqueio produz N conversas
   * × `max_attempts` tentativas e N alertas CRÍTICOS `job_dead` sem dedup,
   * afogando o único `budget_exceeded` — que é o alerta que explica. O
   * REPONTAMENTO da fila é da onda seguinte; o rótulo entra aqui, com o erro.
   */
  readonly terminal = true;
  /** `motivo` só muda no teto do PLANO (`MOTIVO_TETO_DO_PLANO`); o padrão é o do orçamento da org. */
  constructor(
    motivo = 'orçamento mensal de IA da organização atingido — chamada recusada antes de sair byte para o provedor; ajuste o teto em Uso de IA › Orçamento, desligue a proteção, ou aguarde a virada do mês (agent_inbox_items kind=budget_exceeded)',
  ) {
    super(motivo);
  }
}

/**
 * Carteira de tokens de IA da organização esgotada: decisão 7 da fase F3
 * (`hiperbold/planos/fase-F3-tarefas.md`). SUBCLASSE, de propósito: a fila
 * (`workers/agent-worker/main.ts`) lê `terminal` por herança e cancela em vez de
 * repetir, e a escolta de handoff (`comHandoffSeOrcamentoAcabar`, `inbound-turn.ts`)
 * reconhece pela CLASSE-MÃE: os dois desfechos já certos do orçamento em dólar
 * valem aqui sem duplicar nenhum dos dois. `name` e `message` são sobrescritos
 * porque este é um veto DIFERENTE (carteira de tokens do plano, não teto de gasto
 * escolhido pela organização), e as duas tabelas que leem o erro
 * (`llm_calls.error_message`, o `job_dead` da fila) mostram o texto: confundir os
 * dois motivos mandaria quem lê consertar o campo errado (Uso de IA › Orçamento em
 * vez de Configurações › Plano e uso).
 */
export class LlmCarteiraEsgotadaError extends LlmBudgetExceededError {
  override readonly name = 'llm_carteira_esgotada';
  constructor(saldoTokens: number | null) {
    super();
    this.message =
      `carteira de tokens de IA da organização esgotada neste ciclo` +
      (saldoTokens === null ? '' : ` (saldo: ${saldoTokens} tokens)`) +
      ': chamada recusada antes de sair byte para o provedor; contrate mais tokens em ' +
      'Configurações › Plano e uso (agent_inbox_items ref_kind=billing_carteira)';
  }
}

/**
 * Conta em MODO LEITURA (assinatura suspensa/cancelada, bloqueio ligado e
 * carência vencida): decisões 5 e 6 da fase F4 (`hiperbold/planos/fase-F4-
 * tarefas.md`, Tarefa 6). SUBCLASSE de propósito, IRMÃ de
 * `LlmCarteiraEsgotadaError` (as duas estendem `LlmBudgetExceededError`
 * diretamente, nunca uma a outra): a fila lê `terminal` por herança e cancela
 * em vez de repetir, e a escolta de handoff (`comHandoffSeOrcamentoAcabar`,
 * `inbound-turn.ts`) reconhece pela classe-mãe. `name` e `message` são
 * sobrescritos porque este é um veto de NEGÓCIO diferente dos outros dois
 * (mensalidade não paga, não gasto nem carteira do plano) — confundir os três
 * mandaria quem lê consertar o campo errado.
 */
export class LlmAssinaturaSuspensaError extends LlmBudgetExceededError {
  override readonly name = 'llm_assinatura_suspensa';
  constructor() {
    super();
    this.message =
      'a assinatura desta organização está suspensa (modo leitura, pagamento em atraso além da ' +
      'carência): chamada recusada antes de sair byte para o provedor; regularize o pagamento em ' +
      'Configurações › Plano e uso (agent_inbox_items ref_kind=billing_assinatura)';
  }
}

/**
 * Organização suspensa ou arquivada (`organizations.status` diferente de `active`): M2 da auditoria
 * do lote 16 (D-091). Os produtores já param de enfileirar, mas o job que JÁ estava na fila quando a
 * organização foi suspensa rodava e gastava a chave da Hiperbold. O seam recusa antes de sair byte.
 *
 * NÃO estende `LlmBudgetExceededError` de propósito: aquela classe aciona a escolta de handoff
 * (`comHandoffSeOrcamentoAcabar`), que AVISA O LEAD e devolve a conversa à fila humana, e uma conta
 * suspensa não manda mensagem nenhuma. `terminal = true` é o contrato da fila
 * (`workers/agent-worker/main.ts`): o job vai para `cancelJob` (desfecho claro, sem retry e sem
 * `job_dead` crítico), porque tentar de novo dá o mesmo resultado até alguém reativar a conta.
 */
export class LlmOrganizacaoInativaError extends Error {
  override readonly name = 'llm_organizacao_inativa';
  readonly terminal = true;
  constructor(readonly statusDaOrg: string) {
    super(
      `organização com status "${statusDaOrg}" (não está ativa): chamada recusada antes de sair byte ` +
        'para o provedor; o job é cancelado e a conversa não recebe resposta da IA',
    );
  }
}

/** Provider da config sem entrada no registry — erro de config, nunca fallback. */
export class LlmProviderUnknownError extends Error {
  override readonly name = 'llm_provider_unknown';
  constructor(provider: string) {
    super(`provider LLM desconhecido na config da org: ${provider}`);
  }
}

/** Modelo pedido fora de enabled_models da org. */
export class LlmModelNotEnabledError extends Error {
  override readonly name = 'llm_model_not_enabled';
  constructor(model: string) {
    super(`modelo não habilitado para a org (enabled_models): ${model}`);
  }
}

/**
 * Endereço próprio escolhido pela ORGANIZAÇÃO + chave da INSTALAÇÃO: a chamada
 * é recusada antes de sair byte (decisão 22-a do dono do produto).
 *
 * A mensagem é a instrução, numa linha só, porque é ela que chega a quem opera
 * por três caminhos: a tela de Execuções (via `llm_calls.error_message`), o
 * ensaio do agente (que mostra o erro na tela) e o `job_dead` da fila, que
 * guarda a primeira linha de `last_error` no corpo do aviso.
 *
 * NÃO é `terminal`, e isso é escolha: `terminal` manda a fila cancelar o job
 * sem retry, e a fila só pode fazer isso com segurança porque o orçamento tem
 * a escolta de handoff em `runAgentTurn` — este erro não tem. Sem a escolta, o
 * job cancelado deixaria a conversa sem resposta e sem ninguém. Como erro
 * comum, ele segue o mesmo caminho dos irmãos de configuração
 * (`LlmNotConfiguredError`, `LlmModelNotEnabledError`): a fila tenta de novo
 * com espera crescente — quem corrigir a configuração nesse intervalo tem a
 * conversa respondida — e, esgotadas as tentativas, o `job_dead` leva esta
 * frase como motivo.
 */
export class LlmEnderecoExigeChaveDaEmpresaError extends Error {
  override readonly name = 'llm_endereco_exige_chave_da_empresa';
  constructor() {
    super(
      'o endereço de IA configurado para esta empresa só é usado com a chave dela, e ela não tem chave cadastrada para este provedor — a chave da instalação não é enviada a endereço escolhido pela empresa; cadastre a chave da empresa em Agente de IA › Provedores, ou tire o endereço próprio para voltar ao provedor padrão da instalação',
    );
  }
}

/**
 * O título do aviso na Central. Constante exportada porque é também a chave de
 * dedup: o aviso usa `kind='other'` sem referência (ver `recusarEndereco…`).
 */
export const TITULO_ENDERECO_SEM_CHAVE_DA_EMPRESA =
  'A IA recusou usar o endereço próprio desta empresa sem a chave dela';

/**
 * O título da fase de AVISO — antes do prazo, a chamada SEGUE, e dizer
 * "recusou" seria falso na tela de quem administra. Título diferente também
 * separa a dedup: o aviso do prazo e a recusa de depois são dois itens, e é
 * assim que a Central conta a história em vez de sobrescrevê-la.
 */
export const TITULO_ENDERECO_SEM_CHAVE_PRAZO =
  `A IA vai deixar de usar o endereço próprio desta empresa sem a chave dela em ${prazoLegivel()}`;

/** O corpo do aviso — só o HOST do endereço, nunca a URL inteira. */
export function corpoDoAvisoDeEnderecoSemChave(d: {
  purpose: string;
  provider: string;
  baseUrl: string;
  /** `avisa` antes do prazo (a chamada seguiu), `recusa` depois dele. */
  degrau: 'avisa' | 'recusa';
}): string {
  const ponto = PONTO_POR_ID.get(d.purpose)?.rotulo ?? d.purpose;
  // Só o host: uma URL pode carregar usuário e senha (`https://u:s@host`) ou um
  // token na query, e este corpo é lido por qualquer pessoa da equipe.
  let destino = 'um endereço próprio';
  try {
    destino = `um endereço próprio (${new URL(d.baseUrl).host})`;
  } catch {
    // Endereço que nem é URL: o aviso segue sem o host, que é detalhe.
  }
  return (
    `O ponto "${ponto}" está configurado em Agente de IA › Provedores para ${destino}, ` +
    `mas esta empresa não tem chave de ${d.provider} cadastrada e validada. ` +
    `A chave de IA da instalação — a que paga a conta de todas as empresas deste servidor — ` +
    `não é enviada a um endereço escolhido por uma empresa. ` +
    (d.degrau === 'recusa'
      ? `A chamada foi recusada antes de sair. Enquanto isso não for corrigido, as chamadas desse ponto ` +
        `continuam recusadas; quando o ponto faz parte do atendimento, o agente deixa de responder aos ` +
        `clientes desta empresa. `
      : `A chamada SEGUIU desta vez, mas isso tem prazo: a partir de ${prazoLegivel()} ela passa a ser ` +
        `recusada, e quando o ponto faz parte do atendimento o agente deixa de responder aos clientes ` +
        `desta empresa. Corrija antes dessa data. `) +
    `Para resolver: cadastre a chave da empresa em Agente de IA › Provedores, ` +
    `ou tire o endereço próprio para voltar ao provedor padrão da instalação.`
  );
}

// Whitelist de params da org (jsonb livre no DB → só o que o seam entende passa).
const paramsSchema = z
  .object({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().int().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .passthrough();

/**
 * Teto de saída quando nem a organização (`settings.llm.params.maxOutputTokens`)
 * nem a chamada dizem um. Sem teto o pedido sai sem `max_tokens`, e o OpenRouter
 * reserva o MÁXIMO do modelo (64000 no Haiku 4.5) contra o saldo da chave: uma
 * chave com crédito para milhares de respostas curtas recusava todas com
 * "You requested up to 64000 tokens, but can only afford 7978" — medido em
 * produção. Uma resposta de WhatsApp com ferramentas cabe com folga em 4096.
 */
export const TETO_DE_SAIDA_PADRAO = 4096;

export function tetoDeSaida(daOrganizacao: number | undefined, daChamada: number | undefined): number {
  const base = daOrganizacao ?? TETO_DE_SAIDA_PADRAO;
  return daChamada === undefined ? base : Math.min(base, daChamada);
}

/** Provedores em que `reasoning: 'none'` foi conferido contra a API real (#2904). */
const PROVEDORES_COM_RACIOCINIO_NENHUM_MEDIDO: ReadonlySet<string> = new Set(['anthropic', 'openai']);

export interface RunModelCallInput {
  tenantId: string;
  leadId?: string | null;
  jobId?: string | null;
  variantId?: string | null;
  /**
   * De QUEM é esta execução — `ai_agents.id` do agente publicado que está no
   * turno. Vai para `llm_calls.agent_id`, a coluna que existia com FK e nunca
   * era escrita (medido em produção: 0 de 130 linhas de `agent_turn`).
   *
   * Sem ela a aba "Execuções" da tela do agente não tem como filtrar o que
   * mostrar — e era por isso que ela dizia "Nenhuma execução ainda" enquanto o
   * agente respondia. Opcional porque a maioria dos chamadores é auxiliar
   * (classificador, compaction, flywheel) e não pertence a um agente.
   */
  agentId?: string | null;
  /** atribuição de custo: 'agent_turn' (default) | 'classifier' | 'compaction' | 'connection_test' */
  purpose?: string;
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  /**
   * Override do modelo default da org — é como classificador/compaction usam um
   * modelo pequeno pela MESMA camada. Sujeito a enabled_models quando a lista
   * não é vazia. NUNCA um id hardcoded: o valor vem de config de quem chama.
   */
  model?: string;
  /**
   * Teto do loop de tool-calls do generateText (vira stopWhen: stepCountIs). Sem
   * ele o SDK para no 1º step (default stepCountIs(1)) — tools executam mas o
   * modelo não vê o resultado. Quem chama passa o knob (ex.: AGENT_MAX_STEPS do
   * agente), nunca constante.
   */
  maxSteps?: number;
  /**
   * Encerra o loop quando o predicado for verdadeiro ao fim de uma etapa (além
   * do teto de `maxSteps`). É predicado, e não nome de tool, de propósito: o
   * rascunho assistido para quando há resposta ACEITA, não quando o modelo
   * chamou `send_message` — um envio vetado devolve o erro ao modelo para ele
   * reescrever na etapa seguinte, e parar ali entregava rascunho vazio.
   */
  pararQuando?: () => boolean;
  /** Teto por chamada auxiliar; nunca aumenta o limite configurado pela organização. */
  maxOutputTokens?: number;
  /**
   * Raciocínio pedido NESTA chamada, na opção portátil do AI SDK (`reasoning`).
   * Cada provedor traduz para o seu campo — a Anthropic desliga o `thinking` (ou
   * baixa o esforço no modelo que não deixa desligar), a OpenAI manda
   * `reasoning.effort` — então quem chama não nomeia provedor.
   *
   * `'none'` é de quem devolve uma palavra (as classificações): o modelo que
   * pensa antes dela cobra a espera do cliente e os tokens sem ganho. Ausente =
   * o padrão do modelo, como sempre foi.
   */
  reasoning?: 'none';
  /** Cancelamento propagado pelo chamador; a falha continua registrada em llm_calls. */
  abortSignal?: AbortSignal;
  /**
   * Override de provider/credencial vindo da versão PUBLICADA do agente (Fase
   * 2B) — resolvido no seam, nunca no call site. Sem ele, config da org.
   */
  llmOverride?: import('./credentials').LlmResolveOverride;
}

export interface RunModelCallDeps {
  registry?: ProviderRegistry;
  log?: Logger;
  /**
   * O relógio, injetável por causa do degrau de `./prazo-do-endereco-proprio`:
   * sem ele a virada do prazo nunca é exercitada em teste e o dia do corte vira
   * surpresa em produção.
   */
  agora?: Date;
}

/**
 * O subconjunto do `GenerateTextResult` que o motor deste seam CONSUME — e a
 * régua que o ramo da assinatura tem de satisfazer campo a campo.
 *
 * Existe por causa do defeito da #2657: o ramo da assinatura monta à mão um
 * objeto com cara de resultado de generateText (o SIWC exige streamText), e o
 * cast duplo do SDK escondia do compilador o campo responseMessages que
 * faltava — o motor lê esse campo em `inbound-turn.ts` e o turno quebrava com
 * `TypeError: e is not iterable` logo depois de a resposta já ter saído. Com o
 * `satisfies` aqui, tirar (ou jamais adicionar) qualquer campo que o motor lê
 * vira erro de tipo NA HORA, não um turno mudo em produção.
 */
export type ResultadoDoModeloDoSeam = Pick<
  Awaited<ReturnType<typeof generateText>>,
  'text' | 'usage' | 'response' | 'responseMessages' | 'steps' | 'toolCalls' | 'finishReason'
>;

/**
 * O `usage` cru do provedor em cada passo do laço de ferramentas — é onde mora a
 * divisão da gravação de cache por TTL. Sem passos (resposta de um passo só),
 * vale o `usage` do resultado.
 */
export function usosCrusDosPassos(result: { usage: { raw?: unknown }; steps?: ReadonlyArray<{ usage?: { raw?: unknown } }> }): unknown[] {
  const dosPassos = (result.steps ?? []).map((s) => s.usage?.raw).filter((r) => r !== undefined);
  return dosPassos.length > 0 ? dosPassos : [result.usage.raw];
}

/**
 * Texto do aviso de limiar. É PONTEIRO, não retrato: manda ver os números na
 * tela em vez de congelar um "80%" que envelhece no mesmo minuto em que o gasto
 * sobe. O statement do gate insere este item de dentro do banco, junto com a
 * leitura, e por isso os números do momento ainda não existem em JS quando o
 * texto é montado — a escolha do ponteiro transforma essa limitação em acerto.
 *
 * A cópia mora em `./orcamento` porque o caminho legado
 * (`workers/ai-response-worker.ts`) abre os MESMOS dois itens e não pode
 * importar este arquivo (ele arrastaria `pg` e o SDK para o bundle do Next).
 */

/** Só o que a linha de recusa em `llm_calls` grava — quem chama de fora do seam não tem mensagens. */
export type RastroDaChamada = Pick<RunModelCallInput, 'tenantId' | 'leadId' | 'jobId' | 'variantId' | 'agentId'>;

/** O que o statement do gate devolve — uma ida ao banco, um snapshot. */
interface LinhaDoOrcamento {
  teto: number | string | null;
  modo: string | null;
  efetivo_em: Date | null;
  limiar_pct: number | string | null;
  /** `numeric` do Postgres chega como STRING no node-pg. Sempre coagir. */
  gasto: string | number | null;
  avisado_antes: boolean | null;
}

/**
 * O GATE — lê o estado, deixa `decidirOrcamento` decidir, e executa o veredito.
 *
 * ═══ POR QUE ELE NÃO DECIDE NADA POR CONTA PRÓPRIA ═══
 *
 * A regra inteira mora em `./orcamento.ts`, pura e testável sem banco. Aqui só
 * há I/O: uma query, um insert quando bloqueia, um log. As duas condições
 * repetidas abaixo (`modo === 'off'` e `chave === 'off'`) NÃO são uma segunda
 * cópia da regra — são um atalho de CUSTO, e o que as autoriza é que a função
 * pura devolve `seguir` para as duas sob qualquer outro valor de entrada. Essa
 * concordância é cobrada por teste; se alguém mudar a função e não o atalho, o
 * teste vermelhece antes do cliente.
 *
 * ═══ O CUSTO NO CAMINHO QUENTE ═══
 *
 * Com `enforcement_mode = 'off'` — 100% das organizações no dia do upgrade,
 * porque a coluna nasce assim por DEFAULT — o gate volta ANTES de qualquer
 * query. É estritamente menos trabalho que o `assertBudget` de antes, que ia ao
 * banco somar `llm_calls` sempre que o jsonb tivesse um número.
 *
 * ═══ FALHA ABERTA NA AÇÃO, ABERTA NA INFORMAÇÃO ═══
 *
 * Erro na leitura do orçamento NUNCA bloqueia: o cliente não pode perder o
 * agente porque uma query falhou. Mas a causa vai para o log, nomeada — a frase
 * tranquilizadora sozinha é o que faz um defeito viver meses.
 *
 * Ordem (spec da cobrança §5): chave de emergência → teto do PLANO → orçamento da org.
 */
/** O que o gate recebe do seam. */
export interface EntradaDoGate {
  db: pg.Pool;
  organizationId: string;
  /** Só para o atalho de custo. A decisão usa o snapshot de `SQL_ORCAMENTO`. */
  orcamentoDaConfig: OrcamentoDaOrg;
  orcamentoIndisponivelPorque: string | null;
  chave: ChaveDeOrcamento;
  /** De QUEM é a chave carregada — o teto do plano só vincula a da instalação. */
  origemDaChave: OrigemDaChaveLlm;
  purpose: string;
  provider: string;
  model: string;
  origem: string;
  input: RastroDaChamada;
  log?: Logger;
}

/**
 * Exportado para o worker de mídia: a visão de imagem chama o provedor fora
 * deste seam (`workers/media-derive-worker.ts`) e precisa da MESMA recusa —
 * mesmo veredito, mesmo item na Central, mesma linha `orcamento_esgotado` em
 * `llm_calls`. Uma segunda cópia do gate seria uma segunda régua.
 */
export async function aplicarOrcamento(d: EntradaDoGate): Promise<void> {
  const comum = { organization_id: d.organizationId, purpose: d.purpose };
  const inicio = Date.now();

  // (1) A alavanca de emergência vem antes dos DOIS tetos. Decisão D-9 da
  // cobrança do revendedor: o interruptor único do dono da instalação desliga
  // também o teto do plano — é o bolso dele que os dois protegem.
  if (d.chave === 'off') {
    return;
  }

  // (2) O TETO DO PLANO, antes do orçamento da org: o `modo 'off'` dela não
  // desliga o que o dono da instalação vende. Só a chave da instalação consulta
  // (a chave própria é paga pela empresa). Consulta PRÓPRIA, e não pendurada em
  // `SQL_CONFIG_COM_ORCAMENTO`: o catch de lá troca para a query legada em
  // qualquer erro e desliga o orçamento de toda org — a função nova falhando
  // levaria junto o orçamento que já existe.
  // Com a cobrança desligada — a instalação de empresa única, quase todas —
  // o statement nem sai: a chave vem do memo de módulos (MEMO_DO_MODULO_MS).
  if (d.origemDaChave === 'chave_da_instalacao' && (await cobrancaLigadaComMemo(d.db))) {
    const plano = await lerTetoDoPlano(d.db, d.organizationId);
    if ('indisponivel' in plano) {
      d.log?.warn('llm: teto do plano não pôde ser lido — a chamada SEGUE sem ele', {
        ...comum,
        causa: plano.indisponivel,
      });
    } else if (
      decidirTetoDoPlano({
        tetoUsdCents: plano.tetoUsdCents,
        gastoUsdCents: plano.gastoUsdCents,
        origemDaChave: d.origemDaChave,
        purpose: d.purpose,
        chave: d.chave,
      }).acao === 'bloquear'
    ) {
      await recusarPorTeto(d, {
        refKind: 'plano',
        titulo: TITULO_TETO_DO_PLANO,
        corpo: CORPO_TETO_DO_PLANO,
        erro: new LlmBudgetExceededError(MOTIVO_TETO_DO_PLANO),
        gastoCents: plano.gastoUsdCents,
        tetoCents: plano.tetoUsdCents ?? 0,
        inicio,
      });
    }
  }

  // (3) O orçamento da ORGANIZAÇÃO — o de sempre.
  if (d.orcamentoIndisponivelPorque !== null) {
    d.log?.warn('llm: orçamento não pôde ser lido — a chamada SEGUE sem teto', {
      ...comum,
      causa: d.orcamentoIndisponivelPorque,
    });
    return;
  }
  if (d.orcamentoDaConfig.modo === 'off') {
    return;
  }

  let linha: LinhaDoOrcamento | undefined;
  try {
    const { rows } = await d.db.query<LinhaDoOrcamento>(SQL_ORCAMENTO, [
      d.organizationId,
      AVISO_TITULO,
      AVISO_CORPO,
    ]);
    linha = rows[0];
  } catch (err) {
    d.log?.warn('llm: consulta de orçamento falhou — a chamada SEGUE sem teto', {
      ...comum,
      ...normalizarErro(err),
    });
    return;
  }
  if (linha === undefined) {
    // `select` de CTEs escalares sempre devolve uma linha; zero linhas aqui é
    // um mundo que não deveria existir, e nele a resposta segue sendo a frouxa.
    d.log?.warn('llm: consulta de orçamento não devolveu linha — a chamada SEGUE', comum);
    return;
  }

  const gastoCents = Number(linha.gasto ?? 0);
  const tetoCents = Number(linha.teto ?? 0);
  const veredito = decidirOrcamento({
    modo: normalizarModoDeOrcamento(linha.modo),
    tetoCents,
    gastoCents,
    efetivoEm: linha.efetivo_em ?? null,
    agora: new Date(),
    purpose: d.purpose,
    chave: d.chave,
    limiarPct: Number(linha.limiar_pct ?? LIMIAR_PADRAO_PCT),
    avisadoNesteMes: linha.avisado_antes === true,
  });

  if (veredito.acao === 'seguir') {
    return;
  }
  if (veredito.acao === 'avisar_e_seguir') {
    // O item da Central já foi aberto pelo próprio statement (CTE `avisa`), no
    // mesmo snapshot que decidiu — aqui só sobra o log.
    d.log?.warn('llm: gasto de IA passou do aviso — a chamada SEGUE', {
      ...comum,
      porque: veredito.porque,
      gasto_cents: gastoCents,
      teto_cents: tetoCents,
    });
    return;
  }

  await recusarPorTeto(d, {
    refKind: 'ai_budget',
    titulo: BLOQUEIO_TITULO,
    corpo: corpoDoBloqueio(gastoCents, tetoCents),
    erro: new LlmBudgetExceededError(),
    gastoCents,
    tetoCents,
    inicio,
  });
}

/**
 * Executa a recusa de UM dos dois tetos: item na Central, linha de erro em
 * `llm_calls`, log e o `throw`.
 *
 * `ref_kind`/`ref_id` existem para que ALGUÉM possa fechar o item: o insert de
 * antes não gravava ref nenhum, e nenhum auto-resolvedor o alcançava. E o dedup
 * olha o `ref_kind` (spec da cobrança §5): sem ele, o item aberto do plano
 * calaria o do orçamento da org, e vice-versa. `refKind` é uma união fechada,
 * por isso entra literal no SQL.
 */
async function recusarPorTeto(
  d: EntradaDoGate,
  r: {
    refKind: 'ai_budget' | 'plano';
    titulo: string;
    corpo: string;
    erro: LlmBudgetExceededError;
    gastoCents: number;
    tetoCents: number;
    inicio: number;
  },
): Promise<never> {
  await d.db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     select $1, 'budget_exceeded', 'critical', $2, $3, '${r.refKind}', $1
     where not exists (
       select 1 from agent_inbox_items
       where organization_id = $1 and kind = 'budget_exceeded' and status = 'open'
         and ref_kind = '${r.refKind}'
     )
     -- on conflict SEM ALVO pela mesma razão do statement do orçamento
     -- (SQL_ORCAMENTO): a forma com alvo exige que o índice já exista, e um
     -- clone fora de ordem falharia aqui com 42P10 — trocando a RECUSA (o erro
     -- lançado abaixo) por um erro de banco. Sem alvo, se outro processo abriu o
     -- mesmo item entre a guarda e o insert, a linha não entra e a recusa
     -- continua valendo. Cada família tem o seu índice (0540 para o orçamento
     -- da org; o da cobrança para o plano), então um não cala o outro.
     on conflict do nothing`,
    [d.organizationId, r.titulo, r.corpo],
  );
  // A recusa vira LINHA em llm_calls: a tela /app/ai/runs nasceu porque
  // "llm_calls só registrava sucesso", e o único caso em que o agente para DE
  // PROPÓSITO continuava invisível.
  await registrarFalha(d.db, {
    input: d.input,
    purpose: d.purpose,
    provider: d.provider,
    model: d.model,
    origem: d.origem,
    latencyMs: Date.now() - r.inicio,
    erro: r.erro,
    origemDaChave: d.origemDaChave,
  }).catch(() => {
    // Gravar a recusa não pode impedir a recusa.
  });
  d.log?.warn(
    r.refKind === 'plano' ? 'llm: chamada recusada pelo teto de IA do plano' : 'llm: chamada recusada por orçamento',
    {
      organization_id: d.organizationId,
      purpose: d.purpose,
      provider: d.provider,
      model: d.model,
      gasto_cents: r.gastoCents,
      teto_cents: r.tetoCents,
    },
  );
  throw r.erro;
}

/**
 * `billing_settings.modo`, cacheado 60s POR POOL (decisão 6 da fase F3: "o modo,
 * lido com cache curto em memória, como a chave do orçamento"). `WeakMap<pg.Pool,…>`
 * pelo MESMO motivo do `resolvedoresDeCatalogoPorPool` abaixo: cada pool ganha seu
 * próprio cache, dois pools de teste nunca vazam estado entre si, e um pool
 * finalizado libera a entrada sozinho.
 *
 * 60s (e não os 30s do memo de `comportamentoEmVigor`) porque este é OUTRO dado:
 * `billing_settings` é tabela do fork Hiperbold, lida pelo `db` (pg.Pool) do
 * próprio `run-model-call`, nunca pelo Supabase admin client (HTTP): o invariante
 * `tests/invariants/autonomia-preview-core.test.ts` exige ZERO `fetch` no caminho
 * do ensaio do agente, e ler `billing_settings` por HTTP quebraria exatamente isso.
 */
const CACHE_MODO_DE_BILLING_TTL_MS = 60_000;
const modoDeBillingPorPool = new WeakMap<pg.Pool, { modo: ModoDeBilling; expiraEm: number }>();

async function modoDeBillingPeloDb(db: pg.Pool): Promise<ModoDeBilling> {
  const cache = modoDeBillingPorPool.get(db);
  if (cache && cache.expiraEm > Date.now()) return cache.modo;
  const { rows } = await db.query<{ modo: string | null }>(SQL_MODO_DE_BILLING);
  const modo = normalizarModoDeBilling(rows[0]?.modo ?? null);
  modoDeBillingPorPool.set(db, { modo, expiraEm: Date.now() + CACHE_MODO_DE_BILLING_TTL_MS });
  return modo;
}

/**
 * O GATE DA ASSINATURA SUSPENSA (MODO LEITURA): decisões 5 e 6 da fase F4
 * (`hiperbold/planos/fase-F4-tarefas.md`, Tarefa 6). Roda ANTES de
 * `aplicarCarteira` no seam (chamado primeiro em `runModelCall`, logo abaixo) e
 * ANTES dos atalhos de origem de chave e de propósito que `aplicarCarteira` tem
 * — aqui a isenção é a estreita de `./assinatura.ts` (só os dois guardrails de
 * segurança), sem o atalho de `origemDaChave` (a suspensão vale para BYOK e
 * chave da instalação igual, decisão 6).
 *
 * "Zero consulta a mais" no modo avisar/desligado: usa a MESMA leitura cacheada
 * de `billing_settings.modo` que a carteira (`modoDeBillingPeloDb`, 60s por
 * pool) — as duas nunca pagam duas leituras da mesma linha na mesma janela de
 * 60s. `fn_billing_modo_leitura`, a única consulta não cacheada, só roda quando
 * `deveConsultarAssinatura` (a decisão pura, sem I/O) já confirmou que vale a
 * pena.
 */
async function aplicarAssinatura(d: {
  db: pg.Pool;
  organizationId: string;
  chave: ChaveDeOrcamento;
  purpose: string;
  provider: string;
  model: string;
  origem: string;
  origemDaChave: OrigemDaChaveLlm;
  input: RunModelCallInput;
  log?: Logger;
}): Promise<void> {
  const comum = { organization_id: d.organizationId, purpose: d.purpose };

  // Atalhos de custo #1 e #2: SÓ a chave de emergência e o propósito (ambos já
  // em memória) decidem SE vale a pena ler o modo cacheado — nenhum toca o
  // banco. Decisão 6: aqui NÃO há atalho de `origemDaChave` (o terceiro atalho
  // que `aplicarCarteira` tem) — é a diferença que separa este gate do dela,
  // ver o cabeçalho de `./assinatura.ts`.
  if (d.chave === 'off') return;
  if ((PURPOSES_ISENTOS_DA_ASSINATURA as readonly string[]).includes(d.purpose)) return;

  let modo: ModoDeBilling;
  try {
    modo = await modoDeBillingPeloDb(d.db);
  } catch (err) {
    d.log?.warn('llm: leitura de billing_settings.modo falhou (gate de assinatura) — a chamada SEGUE', {
      ...comum,
      ...normalizarErro(err),
    });
    return;
  }

  if (!deveConsultarAssinatura({ chave: d.chave, modoDoBanco: modo, purpose: d.purpose })) {
    return;
  }

  let leitura = false;
  try {
    const { rows } = await d.db.query<{ leitura: boolean | null }>(
      'select public.fn_billing_modo_leitura($1) as leitura',
      [d.organizationId],
    );
    leitura = rows[0]?.leitura === true;
  } catch (err) {
    d.log?.warn('llm: consulta de fn_billing_modo_leitura falhou — a chamada SEGUE sem checagem de assinatura', {
      ...comum,
      ...normalizarErro(err),
    });
    return;
  }

  if (!leitura) return;

  if (d.chave === 'avisar') {
    // A chave de emergência só sabe AFROUXAR (mesma doutrina do orçamento e da
    // carteira): 'avisar' rebaixa o bloqueio para um log, nunca para um throw.
    d.log?.warn('llm: conta suspensa (modo leitura) — chamada SEGUE por PLANOS_BLOQUEIO=avisar', comum);
    return;
  }

  const erro = new LlmAssinaturaSuspensaError();
  // Mesmo molde de `aplicarCarteira`: dedup por TÍTULO ABERTO (sem período
  // embutido, ver o cabeçalho de `TITULO_ASSINATURA_SUSPENSA` sobre por que —
  // `billing_token_avisos_emitidos` não é concedida ao papel que executa este
  // seam). `ref_kind = 'billing_assinatura'` é o que entra nas três proteções
  // contra o membro (migration 0908 parte 2).
  await d.db
    .query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select $1, 'other', 'critical', $2, $3, 'billing_assinatura', $1
       where not exists (
         select 1 from agent_inbox_items
         where organization_id = $1 and kind = 'other' and ref_kind = 'billing_assinatura' and title = $2 and status = 'open'
       )`,
      [d.organizationId, TITULO_ASSINATURA_SUSPENSA, corpoDaSuspensaoDeAssinatura()],
    )
    .catch((err: unknown) => {
      d.log?.warn('llm: aviso de assinatura suspensa não pôde ser aberto na Central — a recusa segue', {
        ...comum,
        ...normalizarErro(err),
      });
    });
  await registrarFalha(d.db, {
    input: d.input,
    purpose: d.purpose,
    provider: d.provider,
    model: d.model,
    origem: d.origem,
    origemDaChave: d.origemDaChave,
    latencyMs: 0,
    erro,
  }).catch(() => {
    // Gravar a recusa não pode impedir a recusa.
  });
  d.log?.warn('llm: chamada recusada: conta suspensa (modo leitura)', comum);
  throw erro;
}

/**
 * O GATE DA CARTEIRA DE TOKENS: decisões 6 e 7 da fase F3
 * (`hiperbold/planos/fase-F3-tarefas.md`). Roda logo depois de `aplicarOrcamento`,
 * no MESMO ponto (antes de sair byte para o provedor): os dois vetos são
 * independentes (ver o cabeçalho de `./carteira.ts`) e por isso um não substitui o
 * outro.
 *
 * ═══ "SEGUE SEM CONSULTA NENHUMA" É LITERAL ═══
 *
 * As quatro condições de `deveConsultarCarteira` são checadas ANTES de qualquer
 * leitura de banco, inclusive antes de `modoDeBillingPeloDb`, que já é cacheada:
 * a variável (`d.chave`), a origem da chave e o propósito estão todos em memória, e
 * só quando as três permitem é que a leitura (cacheada) do modo acontece. Só
 * quando o modo também permite é que a RPC `fn_billing_ia_pode_responder`, a
 * única consulta desta função que não é cacheada, porque o saldo muda a cada
 * resposta, é chamada. No modo `avisar` (billing_settings) e com
 * `PLANOS_BLOQUEIO=off`, zero consulta a mais: nem a de `modoDeBillingPeloDb`
 * quando as três primeiras já bastam para decidir.
 *
 * Mídia (transcrição, visão, embedding) não passa por este gate (decisão 8 da
 * fase): nenhum desses caminhos chama `runModelCall`, então a exclusão é por
 * construção, não por um `if` aqui.
 */
async function aplicarCarteira(d: {
  db: pg.Pool;
  organizationId: string;
  chave: ChaveDeOrcamento;
  origemDaChave: OrigemDaChaveLlm;
  purpose: string;
  provider: string;
  model: string;
  origem: string;
  input: RunModelCallInput;
  log?: Logger;
}): Promise<void> {
  const comum = { organization_id: d.organizationId, purpose: d.purpose };

  // Atalhos de custo #1 a #3: nenhum toca o banco. `deveConsultarCarteira` não
  // recebe o modo ainda (ele é o quarto atalho, e o único que exige I/O), porque a
  // função pura precisa do modo já resolvido; aqui ele entra com o valor mais
  // frouxo possível ('desligado') só para as três primeiras condições decidirem
  // sozinhas: se elas já bastarem para recusar a consulta, o modo nunca é lido.
  if (
    d.chave === 'off' ||
    d.origemDaChave !== 'chave_da_instalacao' ||
    (PURPOSES_ISENTOS as readonly string[]).includes(d.purpose)
  ) {
    return;
  }

  let modo: ModoDeBilling;
  try {
    modo = await modoDeBillingPeloDb(d.db);
  } catch (err) {
    d.log?.warn('llm: leitura de billing_settings.modo falhou: a chamada SEGUE sem teto de carteira', {
      ...comum,
      ...normalizarErro(err),
    });
    return;
  }

  if (!deveConsultarCarteira({ chave: d.chave, modoDoBanco: modo, origemDaChave: d.origemDaChave, purpose: d.purpose })) {
    return;
  }

  let veredito: VeredictoDaCarteira;
  try {
    const { rows } = await d.db.query<{ veredito: unknown }>(
      'select public.fn_billing_ia_pode_responder($1) as veredito',
      [d.organizationId],
    );
    veredito = interpretarVeredictoDaCarteira(rows[0]?.veredito);
  } catch (err) {
    d.log?.warn('llm: consulta da carteira de tokens falhou: a chamada SEGUE sem teto de carteira', {
      ...comum,
      ...normalizarErro(err),
    });
    return;
  }

  veredito = aplicarChaveNoVeredicto(veredito, d.chave);

  if (veredito.acao === 'seguir') {
    return;
  }
  if (veredito.acao === 'avisar_e_seguir') {
    // O aviso de fim de saldo já é da PRÓPRIA carteira (fn_billing_avisar_carteira,
    // 0906, Central), não duplica aqui (decisão 7 da fase F3).
    d.log?.warn('llm: saldo da carteira de tokens abaixo do limiar: a chamada SEGUE', {
      ...comum,
      motivo: veredito.motivo,
      saldo: veredito.saldo,
    });
    return;
  }

  const erro = new LlmCarteiraEsgotadaError(veredito.saldo);
  // `kind='other'`, não `'budget_exceeded'`: o CHECK de `agent_inbox_items.kind` é
  // vocabulário fechado (tests/invariants/vocabulario-banco-x-typescript.test.ts) e
  // esta tarefa não abre migração nova. `ref_kind='billing_carteira'` é o que
  // garante a dedup PRÓPRIA (decisão 7: "não se misturar com o budget_exceeded do
  // orçamento em dólar"), mesmo padrão de `billing_limite` (0905/0907), que
  // também vive em `kind='other'` com `ref_kind` próprio.
  //
  // Revisão da F3 (achado baixo 7): a dedup por SÓ "existe item aberto" fazia
  // um aviso de um mês anterior, nunca fechado, impedir o aviso do mês atual
  // de nascer. `carteiraBloqueioTitulo(veredito.ciclo)` embute o ciclo no
  // título (mesmo molde do aviso de limiar em `fn_billing_avisar_carteira`,
  // 0906, que embute o mês para o mesmo fim); a dedup agora é por
  // ref_kind + TÍTULO + status='open', então um aviso de agosto aberto não
  // impede o de setembro.
  const titulo = carteiraBloqueioTitulo(veredito.ciclo);
  await d.db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     select $1, 'other', 'critical', $2, $3, 'billing_carteira', $1
     where not exists (
       select 1 from agent_inbox_items
       where organization_id = $1 and kind = 'other' and ref_kind = 'billing_carteira' and title = $2 and status = 'open'
     )`,
    [d.organizationId, titulo, corpoDoBloqueioDaCarteira(veredito.saldo)],
  );
  await registrarFalha(d.db, {
    input: d.input,
    purpose: d.purpose,
    provider: d.provider,
    model: d.model,
    origem: d.origem,
    origemDaChave: d.origemDaChave,
    latencyMs: 0,
    erro,
  }).catch(() => {
    // Gravar a recusa não pode impedir a recusa.
  });
  d.log?.warn('llm: chamada recusada: carteira de tokens de IA esgotada', {
    ...comum,
    motivo: veredito.motivo,
    saldo: veredito.saldo,
  });
  throw erro;
}

/**
 * Deixa o rastro da recusa por endereço da empresa com chave da instalação e
 * DEVOLVE o erro — quem chama o lança (`throw await …`), para a recusa ficar
 * visível no ponto em que acontece.
 *
 * Três rastros, cada um para um leitor:
 *
 *  - **Aviso na Central**, para quem administra a empresa, com a instrução.
 *    `kind='other'` sem referência, e não um kind próprio: kind novo exige
 *    reconstruir o CHECK de `agent_inbox_items.kind` (migration + bloco único do
 *    baseline), o mesmo custo que `pacing/aviso-de-janela.ts` recusou pelo mesmo
 *    motivo. SEM referência de propósito: com `ref_kind` fora da política de
 *    `other`, a Central mostraria "Este contexto não está disponível para
 *    você", frase falsa aqui; sem referência ela mostra a orientação do kind. A
 *    dedup é pelo TÍTULO aberto — uma rajada de conversas vira UM aviso.
 *  - **Linha em `llm_calls`**, para a tela de Execuções dizer o que fazer
 *    (`error_code='endereco_exige_chave_da_empresa'`). A tabela que explica o
 *    silêncio não pode ficar vazia justamente numa recusa nossa.
 *  - **Log**, para quem lê o contêiner.
 *
 * Nenhum dos três pode impedir a recusa: falha ao gravar vira log, e o erro
 * devolvido é sempre o da recusa.
 */
async function registrarRecusaDeEnderecoSemChave(d: {
  db: pg.Pool;
  input: RunModelCallInput;
  purpose: string;
  provider: string;
  model: string;
  origem: string;
  /** 0906 (carteira de tokens): sempre 'chave_da_instalacao' neste caminho (é a condição que leva a esta recusa), repassado à linha de falha. */
  origemDaChave: OrigemDaChaveLlm;
  baseUrl: string;
  /** `avisa` antes do prazo (a chamada segue), `recusa` depois dele. */
  degrau: 'avisa' | 'recusa';
  log?: Logger;
}): Promise<LlmEnderecoExigeChaveDaEmpresaError | null> {
  const erro = new LlmEnderecoExigeChaveDaEmpresaError();
  const comum = {
    organization_id: d.input.tenantId,
    purpose: d.purpose,
    provider: d.provider,
    model: d.model,
  };

  try {
    await d.db.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body)
       select $1, 'other', 'critical', $2, $3
       where not exists (
         select 1 from agent_inbox_items
         where organization_id = $1 and kind = 'other' and title = $2 and status = 'open'
       )`,
      [
        d.input.tenantId,
        d.degrau === 'recusa' ? TITULO_ENDERECO_SEM_CHAVE_DA_EMPRESA : TITULO_ENDERECO_SEM_CHAVE_PRAZO,
        corpoDoAvisoDeEnderecoSemChave({
          purpose: d.purpose,
          provider: d.provider,
          baseUrl: d.baseUrl,
          degrau: d.degrau,
        }),
      ],
    );
  } catch (err) {
    d.log?.warn('llm: o aviso da recusa por endereço sem chave da empresa não abriu — a recusa segue', {
      ...comum,
      ...normalizarErro(err),
    });
  }

  if (d.degrau === 'avisa') {
    // A chamada SEGUE até o prazo: gravar uma linha de FALHA em `llm_calls`
    // para uma chamada que vai acontecer seria mentira na tela de Execuções —
    // ela vira a linha normal da chamada, logo abaixo, como qualquer outra.
    d.log?.warn(
      'llm: endereço da empresa com a chave da instalação — a chamada SEGUE até o prazo',
      { ...comum, recusa_a_partir_de: RECUSA_A_PARTIR_DE },
    );
    return null;
  }

  await registrarFalha(d.db, {
    input: d.input,
    purpose: d.purpose,
    provider: d.provider,
    model: d.model,
    origem: d.origem,
    origemDaChave: d.origemDaChave,
    latencyMs: 0,
    erro,
  }).catch(() => {
    // Gravar a recusa não pode impedir a recusa.
  });

  d.log?.warn('llm: chamada recusada — endereço escolhido pela empresa com a chave da instalação', comum);
  return erro;
}

/**
 * Um resolvedor de catálogo POR POOL. Revisão de 23/09/2026 (achado do
 * invariante de preview): antes, o custo de `llm_calls` sempre passava pelo
 * catálogo HTTP (`precoDoCatalogoOuNull`, `lib/ai/runtime/cost.ts`), que abre
 * `fetch` para o PostgREST (`createAdminClient`). `runAgentPreview` (o ensaio
 * do agente) exige ZERO `fetch`, e este seam já recebe um `pg.Pool` (`db`)
 * para tudo o mais. O resolvedor abaixo lê `ai_models` pelo MESMO `db`, com o
 * mesmo cache de 5 min, o mesmo prazo de 2s e o mesmo backoff de 60s da leitura
 * HTTP (a lógica é compartilhada, `criarResolvedorDeCatalogo`; só a FONTE
 * muda).
 *
 * `WeakMap<pg.Pool, …>` em vez de uma variável de módulo única: cada `db`
 * (normalmente um único `pg.Pool` por processo, ver `lib/agent-engine/db/pool.ts`)
 * ganha seu PRÓPRIO cache. Dois `Pool` diferentes (produção vs. um teste que
 * cria um pool novo) nunca compartilham nem vazam estado entre si, e um pool
 * finalizado libera o resolvedor sozinho (`WeakMap` não retém).
 *
 * A consulta usa `Promise.race` (dentro de `criarResolvedorDeCatalogo`) para o
 * prazo de 2s, não `SET LOCAL statement_timeout`, de propósito: `SET LOCAL`
 * só vale dentro de uma transação, e fora dela vira `SET` de sessão, que uma
 * conexão do pool levaria para a PRÓXIMA consulta de outro chamador. Sem
 * transação aqui (é um único `select`), `Promise.race` dá o mesmo prazo sem
 * abrir esse risco.
 */
const resolvedoresDeCatalogoPorPool = new WeakMap<
  pg.Pool,
  ReturnType<typeof criarResolvedorDeCatalogo>
>();

function resolvedorDeCatalogoPeloDb(db: pg.Pool) {
  const existente = resolvedoresDeCatalogoPorPool.get(db);
  if (existente) return existente;
  const resolvedor = criarResolvedorDeCatalogo(async () => {
    const { rows } = await db.query<ModelPricingRow>(
      `select provider, model_id, input_price_per_million_cents, output_price_per_million_cents, deprecated_at
         from ai_models`,
    );
    return rows;
  });
  resolvedoresDeCatalogoPorPool.set(db, resolvedor);
  return resolvedor;
}

/**
 * A CAUDA DO LAÇO DE TOOLS TAMBÉM VAI PARA O CACHE (só Anthropic, só laço).
 *
 * O prefixo estável (tools + system) já tem breakpoints de 1 h. Mas numa resposta
 * com laço de tools cada passo reenvia a abertura (checkpoint, contexto do lead,
 * histórico, mensagem) e os resultados dos passos anteriores — e isso ficava
 * DEPOIS do último breakpoint, cobrado a preço cheio em todo passo. Medido numa
 * instalação real (27/09/2026): ~3,5 passos por resposta, ~12 mil tokens sem
 * cache por passo, 46% do custo da resposta.
 *
 * `cache_control` no nível do pedido põe um breakpoint automático no fim da
 * conversa: o passo 2 em diante lê do cache o que o passo anterior já mandou. TTL
 * de 5 min: os passos de uma resposta são segundos, e 5 min custa menos para
 * escrever que 1 h. É o 3º de 4 breakpoints, e o de 1 h vem antes do de 5 min,
 * como a API exige. Fora do laço (um passo só) não entra: escrever sem reler
 * só encarece.
 */
export function cacheDaCauda(
  provider: string,
  maxSteps: number | undefined,
): { providerOptions?: { anthropic: { cacheControl: { type: 'ephemeral'; ttl: '5m' } } } } {
  if (provider !== 'anthropic' || maxSteps === undefined || maxSteps <= 1) return {};
  return { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } } } };
}

export async function runModelCall(db: pg.Pool, cfg: LlmEdgeConfig, input: RunModelCallInput, deps: RunModelCallDeps = {}) {
  // O knob do raciocínio da DeepSeek entra pela fábrica: `deepseekThinking` só é
  // lido pela fábrica `deepseek`, então os outros provedores não têm como mudar.
  const registry = deps.registry ?? createDefaultRegistry({ deepseekThinking: cfg.deepseekThinking });
  const purpose = input.purpose ?? 'agent_turn';

  // A config da org é lida ANTES da decisão porque o resolvedor precisa dela
  // como último degrau da precedência (o padrão, quando ninguém mais opinou).
  const padrao = await resolveOrgLlmConfig(db, cfg, input.tenantId, input.llmOverride);

  // M2 (D-091): organização suspensa ou arquivada não gasta IA, nem em job que já estava na fila.
  // O status veio da leitura da config acima (zero consulta a mais). Só um status explícito diferente
  // de 'active' barra; leitura que falha NÃO chega aqui, ela lança lá em cima (fecha). Vale para
  // todo propósito, inclusive os isentos de orçamento: sem resposta ao lead, não há o que proteger.
  if (typeof padrao.statusDaOrg === 'string' && padrao.statusDaOrg !== 'active') {
    deps.log?.warn('llm: chamada recusada: organização não está ativa (D-091)', {
      organization_id: input.tenantId,
      purpose,
      status: padrao.statusDaOrg,
    });
    throw new LlmOrganizacaoInativaError(padrao.statusDaOrg);
  }

  // O painel de provedores entra AQUI, e é o que faz `purpose` deixar de ser
  // só um rótulo de custo e virar decisão. Sem binding configurado, `decisao`
  // reproduz exatamente o comportamento anterior — a origem volta como
  // 'variavel_de_ambiente' ou 'padrao_da_organizacao'.
  const decisao = await decidirParaOSeam(db, {
    organizationId: input.tenantId,
    purpose,
    modeloDoCallSite: input.model,
    overrideDoAgente:
      input.llmOverride === undefined
        ? null
        : {
            provider: input.llmOverride.provider ?? padrao.provider,
            credentialId: input.llmOverride.credentialId ?? null,
            model: input.model,
          },
    padraoDaOrganizacao: { provider: padrao.provider, defaultModel: padrao.defaultModel },
    modelosHabilitados: padrao.enabledModels,
  }, deps.log ? { log: deps.log } : {});

  // Só re-resolve a credencial quando a decisão aponta para OUTRA que não a já
  // carregada — decifrar duas vezes a mesma chave é custo puro no caminho
  // quente, e cada decifragem é mais um instante com plaintext em memória.
  //
  // A condição olha para o QUE FOI DECIDIDO, nunca para o rótulo da origem. Ela
  // já foi `decisao.origem === 'binding' && (…)`, e amarrar a correção a um
  // rótulo é o que permite decisão e execução divergirem: qualquer ramo que
  // devolvesse um provider fora do já resolvido saía com a chave do outro —
  // silenciosamente, porque `factory` usa `config.provider` e não
  // `decisao.provider`. `padrao` foi resolvido com `input.llmOverride`, então
  // comparar contra ele é comparar contra o que de fato está carregado.
  const credencialJaCarregada = input.llmOverride?.credentialId ?? null;
  const precisaOutraCredencial =
    decisao.provider !== padrao.provider ||
    (decisao.credentialId !== null && decisao.credentialId !== credencialJaCarregada);

  let config = precisaOutraCredencial
    ? await resolveOrgLlmConfig(db, cfg, input.tenantId, {
        provider: decisao.provider,
        credentialId: decisao.credentialId,
      })
    : padrao;

  const modeloDecidido = decisao.modelId;
  if (modeloDecidido === null || modeloDecidido === undefined) {
    throw new Error(
      'modelo LLM não definido — configure o ponto no painel de provedores, ' +
        'organizations.settings.llm.default_model, ou passe input.model',
    );
  }
  // `model`/`origem` podem mudar UMA vez: quando o modelo econômico do
  // classificador é recusado, a chamada se repete no modelo de antes (abaixo).
  let model: string = modeloDecidido;
  let origem = decisao.origem;
  if (config.enabledModels.length > 0 && !config.enabledModels.includes(modeloDecidido)) {
    throw new LlmModelNotEnabledError(modeloDecidido);
  }

  // ═══ FREIO DE CUSTO DA CHAVE DA INSTALAÇÃO (decisão do dono, 16/10/2026) ═══
  //
  // A chave da instalação paga a conta de todas as empresas e debita os tokens do
  // plano; só os modelos de `MODELOS_DA_INSTALACAO` rodam nela. Fora da lista, o
  // turno SEGUE com o primeiro da lista (o padrão) — nunca falha. Chave PRÓPRIA da
  // organização (BYOK) passa intacta e nem lê a configuração. É este o ponto único
  // do motor: toda chamada (turno, resumo, classificador, operador) passa por aqui,
  // com a origem da chave já decidida por `resolveOrgLlmConfig`.
  if (config.origemDaChave === 'chave_da_instalacao') {
    const lista = await modelosDaInstalacaoPeloDb(db);
    // A chave da instalação sai SEMPRE pela OpenRouter (`config.provider`), que só entende o id
    // com fabricante (`openai/gpt-6-luna`). Id puro do catálogo de um provedor direto
    // (`claude-sonnet-5`, pedido ao `anthropic`) ganha o prefixo do provedor que foi pedido.
    const pedidoNaRota = idNaRotaDaInstalacao(config.providerPedido, modeloDecidido);
    const guarda = decidirModeloDaChave({
      lista,
      origemDaChave: config.origemDaChave,
      provedor: config.provider,
      modelId: pedidoNaRota,
    });
    if (guarda.trocado || guarda.semTraducao) {
      if (primeiraVezDoModelo(input.tenantId, modeloDecidido)) {
        deps.log?.warn(
          guarda.trocado
            ? 'llm: modelo fora de MODELOS_DA_INSTALACAO na chave da instalação — usando o padrão'
            : 'llm: modelo fora de MODELOS_DA_INSTALACAO e o provedor não executa o padrão — mantido',
          {
            organization_id: input.tenantId,
            purpose,
            provider: config.provider,
            pedido: modeloDecidido,
            usado: guarda.modelId,
          },
        );
      }
    }
    model = guarda.modelId;
  }

  // ═══ O PAR (PROVEDOR, MODELO) ANTES DE QUALQUER BYTE ═══
  //
  // `config.provider` é quem de fato recebe a requisição (`registry` é lido por
  // ele, não por `decisao.provider`), e é contra ele que o modelo é conferido.
  // Sem esta linha, um `settings.llm` legado mandava `claude-sonnet-5` para o
  // endpoint da OpenAI e o primeiro aviso era o 400 do provedor — dentro do
  // try, na fila, com retry (issue #2377). Aqui a recusa é anterior a tudo: o
  // log sai com provedor, modelo, propósito e origem da configuração, e o erro
  // carrega o motivo pronto para a tela de Execuções.
  const par = validarParProvedorModelo(config.provider, model);
  if (!par.valido) {
    deps.log?.error('llm: par provedor+modelo recusado antes de sair byte', {
      organization_id: input.tenantId,
      purpose,
      provider: config.provider,
      model,
      origem_da_escolha: decisao.origem,
      motivo: par.motivo,
    });
    throw new ParProvedorModeloInvalidoError(config.provider, model, par.motivo, purpose);
  }
  const factory = registry[config.provider];
  if (factory === undefined) {
    throw new LlmProviderUnknownError(config.provider);
  }
  const parsedParams = paramsSchema.safeParse(config.params);
  if (!parsedParams.success) {
    throw new Error('params inválidos em organizations.settings.llm.params — corrija a config da org');
  }
  const { temperature, topP, topK, maxOutputTokens } = parsedParams.data;

  // ═══ A CHAVE DA INSTALAÇÃO NÃO VAI PARA O ENDEREÇO DA EMPRESA ═══
  //
  // `decisao.baseUrl` só existe quando o ponto tem endereço próprio, e ele vem
  // de `ai_purpose_bindings` — tabela POR ORGANIZAÇÃO, editada por quem a
  // administra. `config.origemDaChave` diz se a chave carregada é dela ou é o
  // `.env` que paga a conta de todas as empresas do servidor. Juntos, os dois
  // mandariam a chave da instalação para um endereço que UMA empresa escolheu.
  // Decisão 22-a do dono do produto: endereço próprio exige chave própria.
  //
  // A condição olha para o que foi DECIDIDO e CARREGADO, nunca para o rótulo
  // `decisao.origem` — mesma regra de `precisaOutraCredencial` acima. E vem
  // antes do teto: é recusa de configuração, e consultar gasto para uma chamada
  // que não vai sair seria custo à toa. O mesmo corte vale no worker de mídia
  // (`workers/media-derive-worker.ts`), pela mesma fonte.
  //
  // ═══ EM DOIS TEMPOS, E O SEGUNDO ENTRA SOZINHO ═══
  //
  // Recusar no instante da atualização obrigaria quem opera a agir ANTES de
  // atualizar — o que, pela régua de versionamento, é major, e major só sai
  // quando o dono do produto pede (decisão dele, 19/09/2026, doc 40). Então
  // até `RECUSA_A_PARTIR_DE` a chamada SEGUE e o aviso na Central traz a DATA;
  // a partir dela, a recusa entra sem ninguém precisar reabrir o assunto.
  // A regra e o relógio injetável moram em `./prazo-do-endereco-proprio.ts`.
  if (decisao.baseUrl && config.origemDaChave === 'chave_da_instalacao') {
    const erroOuNulo = await registrarRecusaDeEnderecoSemChave({
      db,
      input,
      purpose,
      provider: config.provider,
      model,
      origem: decisao.origem,
      origemDaChave: config.origemDaChave,
      baseUrl: decisao.baseUrl,
      degrau: degrauDoEnderecoProprio(deps.agora ?? new Date()),
      ...(deps.log ? { log: deps.log } : {}),
    });
    if (erroOuNulo) throw erroOuNulo;
  }

  // ═══ O TETO, LOGO ANTES DE SAIR BYTE ═══
  //
  // Fica DEPOIS da resolução de modelo/provider, e não antes como o
  // `assertBudget` de origem, por uma razão de informação: a recusa agora vira
  // linha em `llm_calls`, e aquela tabela tem `model text not null`. Chamado no
  // ponto antigo, o gate teria de inventar um nome de modelo para gravar — e um
  // valor inventado numa tabela de auditoria é pior que a linha faltando.
  // Continua ANTES de qualquer byte ao provedor, que é a propriedade que
  // importa: bloqueio custa zero token.
  // O mesmo gate, para QUALQUER provedor que vá falar nesta chamada —
  // inclusive a reserva que a assinatura pode acionar mais abaixo (mesma
  // organização, mesmo purpose, mesmo teto: recusar na assinatura e deixar a
  // reserva passar seria o mesmo furo de antes, com outro nome).
  //
  // Na ordem: orçamento em dólar → assinatura suspensa (modo leitura, fase F4)
  // → carteira de tokens (fase F3). Os três são vetos INDEPENDENTES e todos
  // antes de qualquer byte ao provedor; a reserva passa pelos mesmos três.
  const gateDeOrcamento = async (cfgUsada: OrgLlmConfig): Promise<void> => {
    await aplicarOrcamento({
      db,
      organizationId: input.tenantId,
      orcamentoDaConfig: cfgUsada.orcamento,
      orcamentoIndisponivelPorque: cfgUsada.orcamentoIndisponivelPorque,
      // A chave EFETIVA da instalação: a linha escrita na tela de admin vence, e
      // o valor do `.env` (que veio na config) é o PISO. A leitura é feita AQUI,
      // a cada chamada, porque é aqui que a decisão acontece — um snapshot no
      // boot faria o kill switch da tela só valer depois de reiniciar o worker
      // (issue #1034). Sem banco lido nesta vida do processo, isto é o de hoje.
      chave: chaveDeOrcamentoDaInstalacao(cfg.budgetEnforcement ?? 'on'),
      // Teto do PLANO só vale para a chave da instalação (PR 2 da cobrança): a de cada uso decide.
      origemDaChave: cfgUsada.origemDaChave,
      purpose,
      provider: cfgUsada.provider,
      model,
      origem: decisao.origem,
      input,
      ...(deps.log ? { log: deps.log } : {}),
    });

    // ═══ A ASSINATURA SUSPENSA (MODO LEITURA), ANTES DA CARTEIRA ═══
    //
    // Decisões 5 e 6 da fase F4 (`hiperbold/planos/fase-F4-tarefas.md`, Tarefa
    // 6): veto de NEGÓCIO diferente e ANTERIOR ao da carteira — uma conta que
    // não paga a mensalidade não tem carteira nem orçamento que a salve. Mesma
    // chave `PLANOS_BLOQUEIO` (`cfg.bloqueioDePlanos`) da carteira, e pelo mesmo
    // motivo dela: `billing_settings.modo` (não a chave sozinha) é quem de fato
    // manda, lido dentro de `aplicarAssinatura` (mesmo cache, 60s por pool).
    await aplicarAssinatura({
      db,
      organizationId: input.tenantId,
      chave: cfg.bloqueioDePlanos ?? 'on',
      purpose,
      provider: cfgUsada.provider,
      model,
      origem: decisao.origem,
      origemDaChave: cfgUsada.origemDaChave,
      input,
      ...(deps.log ? { log: deps.log } : {}),
    });

    // ═══ A CARTEIRA DE TOKENS, LOGO EM SEGUIDA ═══
    //
    // Mesmo ponto (antes de qualquer byte ao provedor), mesma razão. É um veto
    // INDEPENDENTE do orçamento em dólar acima (decisões 6 e 7 da fase F3, ver o
    // cabeçalho de `./carteira.ts`): uma organização pode estourar só um dos dois, e
    // os dois precisam poder recusar sem que um mascare o outro no log nem na Central.
    //
    // `cfg.bloqueioDePlanos` NÃO passa por `lib/instalacao/comportamento.ts` (ao
    // contrário da chave de orçamento, que tem override por `platform_settings`):
    // a decisão 1 da fase declara `PLANOS_BLOQUEIO` uma chave só de `.env`, sem linha
    // de banco própria: o modo que de fato manda é `billing_settings.modo`, lido
    // dentro de `aplicarCarteira` (cacheado, 60s por pool).
    await aplicarCarteira({
      db,
      organizationId: input.tenantId,
      chave: cfg.bloqueioDePlanos ?? 'on',
      purpose,
      provider: cfgUsada.provider,
      model,
      origem: decisao.origem,
      origemDaChave: cfgUsada.origemDaChave,
      input,
      ...(deps.log ? { log: deps.log } : {}),
    });
  };
  await gateDeOrcamento(config);

  // Disciplina de cache: o prefixo estável org-wide (system do playbook + tools
  // em ordem determinística) ganha os breakpoints AQUI, no seam — call sites
  // passam system/tools crus. Tudo por-lead vive em input.messages, DEPOIS do
  // breakpoint. TTL: knob LLM_CACHE_TTL; '1h' é a doutrina.
  const prefix = buildStablePrefix({
    system: input.system,
    tools: input.tools,
    cacheTtl: cfg.cacheTtl ?? '1h',
  });

  let startedAt = Date.now();
  // O que os passos JÁ CONCLUÍDOS custaram ao provedor (D-156). Num laço de
  // ferramentas, uma falha no passo 3 não desfaz o que os passos 1 e 2 gastaram:
  // sem esta soma a linha de falha saía com zero token, e llm_calls, carteira e
  // orçamento deixavam de contar dinheiro já pago (e o job, ao tentar de novo,
  // repetia o gasto sem que ninguém o visse).
  const pagos = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let result: Awaited<ReturnType<typeof generateText>>;

  // A MESMA chamada, em qualquer config: separar em função é o que permite a
  // assinatura ser refeita com a reserva SEM copiar o corpo (duas cópias do
  // `generateText` são duas cópias que um dia divergem — e a divergência seria
  // invisível, porque só uma delas rodaria).
  const chamarCom = async (cfgUsada: OrgLlmConfig, fabrica: (typeof factory)) => {
    const opcoesBase = {
      // `decisao.baseUrl` só é preenchido quando o painel apontou um endpoint
      // (gateway OpenAI-compatível, ou modelo local). Providers canônicos
      // ignoram o terceiro argumento e vão ao endpoint intrínseco.
      // `config.baseUrl` é o da PRÓPRIA credencial e só o provedor personalizado
      // (#1642) tem um: o endereço nasce junto da chave, então o agente
      // publicado nele alcança o mesmo gateway que a tela testou ao salvar.
      model: fabrica(cfgUsada.apiKey, model, decisao.baseUrl ?? cfgUsada.baseUrl ?? undefined),
      system: prefix.system,
      messages: input.messages,
      abortSignal: input.abortSignal,
      tools: guardServiceTools(prefix.tools),
      stopWhen:
        input.maxSteps === undefined
          ? undefined
          : input.pararQuando === undefined
            ? stepCountIs(input.maxSteps)
            : [stepCountIs(input.maxSteps), input.pararQuando],
      onStepFinish: (passo) => {
        pagos.inputTokens += passo.usage?.inputTokens ?? 0;
        pagos.outputTokens += passo.usage?.outputTokens ?? 0;
        pagos.cacheReadTokens += passo.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
        pagos.cacheWriteTokens += passo.usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
      },
      ...cacheDaCauda(cfgUsada.provider, input.maxSteps),
    };

    if (cfgUsada.provider === PROVEDOR_POR_ASSINATURA) {
      // SIWC exige Responses API em streaming e store:false. A assinatura
      // também não aceita opções de amostragem/teto de saída que generateText
      // adiciona ao payload. Consumimos o stream completo aqui para preservar
      // o contrato síncrono do motor e capturar responseMessages dos tool calls.
      // O AI SDK devolve um `NoOutputGeneratedError` genérico quando o stream
      // só contém um erro. Guardamos o evento original para preservar status e
      // mensagem do provedor — a classificação e a reserva precisam reconhecer
      // 401/429, e a tela de Execuções precisa explicar a falha real.
      let erroOriginalDoStream: unknown = null;
      const streamed = streamText({
        ...opcoesBase,
        providerOptions: { openai: { store: false } },
        onError: ({ error }) => {
          erroOriginalDoStream = error;
        },
      });
      let text: string;
      let usage: Awaited<typeof streamed.usage>;
      let response: Awaited<typeof streamed.response>;
      let steps: Awaited<typeof streamed.steps>;
      let responseMessages: Awaited<typeof streamed.responseMessages>;
      let toolCalls: Awaited<typeof streamed.toolCalls>;
      // `finishReason` ('stop' | 'length' | 'tool-calls' | ...). O
      // ramo da assinatura monta o resultado à mão, então sem ele aqui o campo
      // FALTARIA no runtime (generateText devolve sozinho) e a detecção de
      // saída truncada ('length') cegaria exatamente no provedor de assinatura.
      let finishReason: Awaited<typeof streamed.finishReason>;
      try {
        [text, usage, response, steps, responseMessages, toolCalls, finishReason] = await Promise.all([
          streamed.text,
          streamed.usage,
          streamed.response,
          streamed.steps,
          streamed.responseMessages,
          // Lido por quem pede UMA ferramenta (propostas, valor da conversa).
          streamed.toolCalls,
          streamed.finishReason,
        ]);
      } catch (erroDoSdk) {
        throw erroOriginalDoStream ?? erroDoSdk;
      }
      // `responseMessages` NO NÍVEL DE CIMA, e não só dentro de `response`
      // (#2657): o motor lê o campo em inbound-turn.ts
      // (`turn.result.responseMessages`) e é ele que a chamada de fechamento
      // re-serializa. Sem ele o turno quebrava com `e is not iterable` 100 ms
      // DEPOIS de a resposta já ter saído — o modelo respondia, o cliente não
      // recebia. O satisfies é a régua: o compilador passa a cobrir cada campo
      // que o motor consome, que é o que o cast anterior escondia.
      const resultadoDoStream = {
        text,
        usage,
        response: { ...response, messages: responseMessages },
        responseMessages,
        steps,
        toolCalls,
        finishReason,
      } satisfies ResultadoDoModeloDoSeam;
      return resultadoDoStream as unknown as Awaited<ReturnType<typeof generateText>>;
    }

    return generateText({
      ...opcoesBase,
      temperature,
      topP,
      topK,
      maxOutputTokens: tetoDeSaida(maxOutputTokens, input.maxOutputTokens),
      // Só onde o `'none'` foi aceito pela API real (#2904). Nos de Chat Completions
      // (OpenRouter, Requesty, personalizado) o SDK manda `reasoning_effort` para
      // qualquer modelo; no Gemini 2.5 Pro vira `thinkingBudget: 0`, que o Google
      // documenta como recusado, e no 3.x Pro, `thinkingLevel: "minimal"`. Uma recusa
      // derrubaria a classificação em todo turno. Entram com a medição deles.
      ...(input.reasoning !== undefined && PROVEDORES_COM_RACIOCINIO_NENHUM_MEDIDO.has(cfgUsada.provider)
        ? { reasoning: input.reasoning }
        : {}),
    });
  };

  /**
   * O 401 DO TURNO RENOVE ANTES DE CAIR (#3371, fatia 4).
   *
   * `chamarComRetryUnicoEm401` existia em `lib/ai/pontos/renovacao-da-assinatura.ts`
   * e **não tinha chamador de produção** — só os testes dele. Consequência medida
   * em produção (cliente Obralivre): o access_token vencia, todo turno recebia
   * `401 · Provided authentication token is expired`, a chamada caía na política
   * de reserva e o cliente ficou ~26 h sem resposta, com cota sobrando.
   *
   * Agora, no caminho REAL do provedor de assinatura: um 401 → renova UMA vez pelo
   * mesmo caminho do botão de revalidar (`renovarAssinaturaNoTurno`, com a trava
   * de banco) → tenta UMA vez. Segundo 401 é devolvido como está e cai na política
   * de reserva que já existe — nada de laço aqui: o único lugar onde este seam
   * insiste é o degrau econômico do classificador, que é outro assunto.
   *
   * `recusaDaRenovacao` guarda o PORQUÊ da recusa (fatia 3): é ele que vira o
   * aviso único na Central (fatia 2) quando a conta precisa ser reconectada.
   */
  // Objeto e não `let`: o valor é escrito dentro do callback da renovação e lido
  // depois, no catch — e é a leitura DEPOIS que decide o aviso da Central.
  const renovacaoDoTurno: { recusa: string | null } = { recusa: null };
  // O par tentativa/resposta do seam. Anotado porque o genérico de
  // `chamarComRetryUnicoEm401` inferiria só o ramo de SUCESSO e recusaria o de
  // erro — o tipo é o mesmo objeto, o retry único é que é o contrato.
  type TentativaDaAssinatura =
    | { ok: true; resultado: Awaited<ReturnType<typeof generateText>> }
    | { ok: false; erro: unknown };
  const chamarComRenovacaoNo401 = async (
    cfgUsada: OrgLlmConfig,
    fabrica: typeof factory,
  ): Promise<Awaited<ReturnType<typeof generateText>>> => {
    const { corpo, tentativas } = await chamarComRetryUnicoEm401<TentativaDaAssinatura>({
      tentar: async () => {
        try {
          return {
            status: 200,
            corpo: { ok: true as const, resultado: await chamarCom(cfgUsada, fabrica) },
          };
        } catch (erro) {
          // O status do provedor, e não uma classe de erro: é o 401 que decide.
          return { status: normalizarErro(erro).http_status ?? 0, corpo: { ok: false as const, erro } };
        }
      },
      renovarApos401: async () => {
        const r = await renovarAssinaturaNoTurno({
          admin: createAdminClient(),
          orgId: input.tenantId,
        });
        if (r.ok) {
          deps.log?.warn('llm: a assinatura respondeu 401 — login renovado no meio do turno', {
            organization_id: input.tenantId,
            purpose,
            provider: cfgUsada.provider,
            model,
          });
          return;
        }
        const motivo = r.motivoDetalhe ? `${r.motivo}:${r.motivoDetalhe}` : r.motivo;
        // Só recusa de LOGIN vira aviso de conta desconectada. `em_curso` (outro
        // processo renovando dentro da trava) e `modulo_desligado` não dizem nada
        // sobre a conta — anunciá-la desconectada mandaria reconectar uma conta boa.
        if (r.motivo === 'falha' || r.motivo === 'nao_encontrada') {
          renovacaoDoTurno.recusa = motivo;
        }
        deps.log?.error('llm: a assinatura respondeu 401 e a renovação foi RECUSADA', {
          organization_id: input.tenantId,
          purpose,
          provider: cfgUsada.provider,
          model,
          motivo,
        });
      },
    });
    if (corpo.ok) {
      if (tentativas > 1) {
        deps.log?.warn('llm: a chamada seguiu depois de renovar o login da assinatura', {
          organization_id: input.tenantId,
          purpose,
          tentativas,
        });
      }
      return corpo.resultado;
    }
    throw corpo.erro;
  };

  /**
   * A QUEDA DA ASSINATURA (#1639, item 3) — a metade que faltava da política.
   *
   * `decidirQuedaDoProvedor` já existe e é pura; o que faltava era respondê-lo:
   * `temChaveDeReserva` pergunta à MESMA escada de resolução se a chave `openai`
   * da empresa existe. Devolve a config da reserva quando a política manda cair,
   * e `null` quando o desfecho é o de sempre — o erro ORIGINAL é relançado, sem
   * um erro novo inventado no lugar dele.
   */
  const reservaParaAFalha = async (falha: unknown): Promise<OrgLlmConfig | null> => {
    // O freio do provedor está DENTRO de decidirQuedaDoProvedor: nativo que
    // falhou continua falhando como sempre. Aqui só evitamos a pergunta ao
    // banco quando ela não vai ser ouvida.
    if (config.provider !== PROVEDOR_POR_ASSINATURA) return null;
    // Abort não é recusa de credencial: a pessoa cancelou, ou o worker parou.
    if (input.abortSignal?.aborted) return null;
    // `error_message` já vem redigida (chaves/Bearer fora) — e é só ela que a
    // classificação usa, para separar "token expirado" de "sem autorização".
    const { http_status: status, error_message: detalhe } = normalizarErro(falha);
    const temReserva = await temChaveDeReserva(db, cfg, input.tenantId);
    const decisaoDaQueda = decidirQuedaDoProvedor({
      provider: config.provider,
      status,
      detalhe,
      temChaveDeReserva: temReserva,
    });
    if (decisaoDaQueda === null || decisaoDaQueda.acao !== 'tentar_reserva') return null;
    try {
      return await resolveOrgLlmConfig(db, cfg, input.tenantId, {
        provider: decisaoDaQueda.provedorDeReserva,
        credentialId: null,
      });
    } catch {
      // A reserva existia na pergunta e sumiu na resolução (revogou no meio da
      // chamada). Errar com o erro ORIGINAL é dizer a verdade ao operador.
      return null;
    }
  };

  try {
    input.abortSignal?.throwIfAborted();
    // `system` aceita SystemModelMessage (com providerOptions de cache) — igual
    // em v6 e v7 (smoke prova que o cacheControl continua virando cache_control).
    try {
      result =
        config.provider === PROVEDOR_POR_ASSINATURA
          ? await chamarComRenovacaoNo401(config, factory)
          : await chamarCom(config, factory);
    } catch (falhaDaAssinatura) {
      const reserva = await reservaParaAFalha(falhaDaAssinatura);
      if (reserva === null) throw falhaDaAssinatura;
      const fabricaDaReserva = registry[reserva.provider];
      // Sem fábrica para a reserva (registry de teste, provedor removido):
      // o erro original é o que interessa, e ele não muda de mão.
      if (fabricaDaReserva === undefined) throw falhaDaAssinatura;
      // A troca ANTES da nova tentativa: se a reserva também falhar, a linha de
      // `llm_calls` grava o provedor que de fato falhou por último, e não o que
      // a chamada começou a falar.
      config = reserva;
      await gateDeOrcamento(reserva);
      deps.log?.warn('llm: assinatura indisponível — chamada caiu na reserva', {
        organization_id: input.tenantId,
        purpose,
        provider: reserva.provider,
        model,
        origem_da_escolha: decisao.origem,
      });
      result = await chamarCom(reserva, fabricaDaReserva);
    }
  } catch (err) {
    err = identificarConteudoBloqueado(err) ?? err;
    // ─── A LINHA QUE FALTAVA ────────────────────────────────────────────────
    //
    // Provedor recusou a chave, modelo não existe, conta sem saldo? A falha
    // vira linha em llm_calls ANTES de subir — a tabela que deveria explicar
    // não pode ficar vazia justo no caso que precisa de explicação. Grava e
    // RELANÇA: quem chama continua decidindo o que fazer com a falha.
    //
    // Grava e RELANÇA: quem chama continua decidindo o que fazer com a falha
    // (o worker reagenda, o dry-run mostra na tela). Engolir aqui trocaria uma
    // falha invisível por uma silenciosa, que é pior.
    const jaPagou = pagos.inputTokens + pagos.outputTokens > 0;
    // A reserva do MODELO (degrau econômico do classificador): recusado o
    // econômico, repete UMA vez no modelo que valia antes dele. Só para a
    // recusa que é do MODELO — não existe para esta chave (404) ou o acesso
    // foi negado (403). Instabilidade (5xx, 429) não troca de modelo: o
    // classificador já degrada sozinho. Orçamento nunca se repete. Resposta
    // fora do formato não é coberta — por isso só entram no degrau econômico
    // pontos que degradam sem repetir o turno. A falha coberta vira linha com
    // origem própria e em `warn`: o erro de verdade só existe se a reserva
    // também cair.
    const reservaDoModelo = decisao.reserva;
    const { error_code: codigoDaFalha, http_status: statusDaFalha } = normalizarErro(err);
    const fabricaAtual = registry[config.provider];
    const vaiParaAReservaDoModelo =
      reservaDoModelo !== undefined &&
      fabricaAtual !== undefined &&
      (codigoDaFalha === 'modelo_inexistente' || statusDaFalha === 403) &&
      !(err instanceof LlmBudgetExceededError) &&
      input.abortSignal?.aborted !== true &&
      (config.enabledModels.length === 0 || config.enabledModels.includes(reservaDoModelo.modelId));
    const origemDaFalha = vaiParaAReservaDoModelo ? 'economico_coberto_pela_reserva' : origem;
    await registrarFalha(db, {
      input,
      purpose,
      provider: config.provider,
      model,
      origem: origemDaFalha,
      origemDaChave: config.origemDaChave,
      latencyMs: Date.now() - startedAt,
      erro: err,
      ...(jaPagou
        ? {
            usoParcial: {
              ...pagos,
              // Preço desconhecido continua nulo, nunca zero; a falha em calcular não
              // pode impedir a gravação da linha.
              custoCents: await custoCentsComCatalogo(
                config.provider,
                model,
                pagos,
                cfg.cacheTtl ?? '1h',
                deps.log,
                resolvedorDeCatalogoPeloDb(db).precoDoCatalogoOuNull,
              ).catch(() => null),
            },
          }
        : {}),
    }).catch(() => {
      // O log da falha não pode causar uma segunda falha.
    });
    // ─── O AVISO QUE A CENTRAL NÃO TINHA (#3371, fatia 2) ─────────────────────
    //
    // 401 com sinal de expiração + renovação RECUSADA = a conta desconectou e
    // ninguém vai saber. Foi assim que o cliente Obralivre passou ~26 h com 107
    // turnos recusados e a Central de avisos VAZIA. Um item por incidente (a
    // regra pura + o índice único da migration 9027), aberto aqui e fechado
    // sozinho pela rota do login novo. Best-effort: o turno já falhou, o aviso
    // não pode virar uma segunda falha.
    if (
      config.provider === PROVEDOR_POR_ASSINATURA &&
      statusDaFalha === 401 &&
      renovacaoDoTurno.recusa !== null
    ) {
      await sincronizarAvisoDaAssinatura(createAdminClient(), {
        organizationId: input.tenantId,
        conectada: false,
        recusa: renovacaoDoTurno.recusa,
      }).catch(() => 'falhou');
    }
    const camposDaFalha = {
      organization_id: input.tenantId,
      purpose,
      provider: config.provider,
      model,
      origem_da_escolha: origemDaFalha,
      ...normalizarErro(err),
    };
    if (!vaiParaAReservaDoModelo || reservaDoModelo === undefined || fabricaAtual === undefined) {
      deps.log?.error('llm: chamada falhou', camposDaFalha);
      throw err;
    }
    deps.log?.warn('llm: chamada falhou', camposDaFalha);
    // Os próximos turnos desta organização param de tentar este econômico por
    // um tempo — senão cada classificação pagaria a recusa antes da reserva.
    marcarEconomicoQueFalhou(input.tenantId, config.provider, model, Date.now());
    deps.log?.warn('llm: o modelo econômico falhou — repetindo no modelo de antes', {
      organization_id: input.tenantId,
      purpose,
      modelo_economico: model,
      modelo_de_reserva: reservaDoModelo.modelId,
    });
    model = reservaDoModelo.modelId;
    origem = reservaDoModelo.origem;
    startedAt = Date.now();
    try {
      result = await chamarCom(config, fabricaAtual);
    } catch (errDaReserva) {
      errDaReserva = identificarConteudoBloqueado(errDaReserva) ?? errDaReserva;
      await registrarFalha(db, {
        input,
        purpose,
        provider: config.provider,
        model,
        origem,
        origemDaChave: config.origemDaChave,
        latencyMs: Date.now() - startedAt,
        erro: errDaReserva,
      }).catch(() => {});
      deps.log?.error('llm: chamada falhou', {
        organization_id: input.tenantId,
        purpose,
        provider: config.provider,
        model,
        origem_da_escolha: origem,
        ...normalizarErro(errDaReserva),
      });
      throw errDaReserva;
    }
  }
  const latencyMs = Date.now() - startedAt;

  const cacheWriteTokens = result.usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const cacheWrite1hTokens = gravacaoDeUmaHora(usosCrusDosPassos(result), cacheWriteTokens);
  const usage = {
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens ?? 0,
    cacheWriteTokens,
    ...(cacheWrite1hTokens !== undefined ? { cacheWrite1hTokens } : {}),
  };
  // A gravação de cache custa 1.25× a entrada em 5m e 2× em 1h. Quando o provedor
  // diz quanto foi de cada (`cache_creation` da Anthropic), cada parcela vai pela
  // sua tarifa; senão, vale o TTL que gravou o prefixo estável acima. Cobrar tudo
  // a 1h superfaturava ~16% do mês (medido contra a fatura em 17/10/2026).
  //
  // A tabela estática do motor é a PRIMEIRA verdade. Quando ela não conhece o id
  // — o caso do provedor PERSONALIZADO, que serve qualquer modelo de qualquer
  // preço (#3013: 180 chamadas de `openai/gpt-oss-120b` no Groq, custo nulo) —, o
  // preço da linha sai do catálogo da INSTALAÇÃO (`ai_models`/`ai_pricing`, as
  // mesmas tabelas que `lib/ai/cost.ts` e `lib/ai/runtime/cost.ts` já consultam).
  // Sem preço em nenhum dos dois o custo continua `null` — mas com aviso no log,
  // nunca calado, e nunca um 0 inventado. O caminho dos modelos que já têm linha
  // na tabela estática não muda uma vírgula: `costCents` segue sendo chamado
  // primeiro, e só o `null` dele chega aqui.
  let cost = custoTerraPorPassos(model, result) ?? costCents(model, usage, cfg.cacheTtl ?? '1h');
  let origemDoCusto: 'catalogo_da_instalacao' | undefined;
  if (cost === null) {
    cost = await custoDoModeloForaDoMotor(db, {
      model,
      provider: config.provider,
      usage,
      log: deps.log,
    });
    if (cost !== null) origemDoCusto = 'catalogo_da_instalacao';
  }

  const { rows } = await db.query<{ id: string }>(
    `insert into llm_calls
       (organization_id, contact_id, job_id, variant_id, purpose, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, latency_ms,
        status, origem_da_escolha, agent_id, origem_da_chave)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'ok', $14, $15, $16)
     returning id`,
    [
      input.tenantId,
      input.leadId ?? null,
      input.jobId ?? null,
      input.variantId ?? null,
      purpose,
      config.provider,
      model,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      cost,
      latencyMs,
      origem,
      input.agentId ?? null,
      // 0906 (carteira de tokens): de quem é a chave desta chamada bem-sucedida.
      config.origemDaChave,
    ],
  );

  // Só métricas — nunca conteúdo de mensagem (PII) nem chave.
  deps.log?.info('llm: chamada concluída', {
    organization_id: input.tenantId,
    provider: config.provider,
    model,
    purpose,
    // POR QUE este modelo, e não só QUAL: é a diferença entre um log que
    // confirma o que aconteceu e um que explica uma configuração que não
    // pegou. Vira coluna em llm_calls na frente de logs.
    origem_da_escolha: origem,
    ...usage,
    cost_cents: cost,
    // Só quando o preço NÃO veio da tabela estática do motor: diz de qual caminho
    // saiu o número gravado, e é o que um operador procura quando pergunta "de
    // onde saiu este custo?". Modelo sem preço em lugar nenhum não traz o campo —
    // o `cost_cents: null` acima somado ao aviso de sem-preço é a marca.
    ...(origemDoCusto !== undefined ? { custo_origem: origemDoCusto } : {}),
    latency_ms: latencyMs,
  });
  for (const aviso of decisao.avisos) {
    deps.log?.warn('llm: configuração do ponto tem incoerência', {
      organization_id: input.tenantId,
      purpose,
      aviso,
    });
  }

  return {
    result,
    callId: rows[0]?.id ?? null,
    provider: config.provider,
    model,
    usage,
    costCents: cost,
    latencyMs,
    /** De onde veio a escolha — o painel lê isto para explicar cada ponto. */
    origem,
    avisos: decisao.avisos,
  };
}

/**
 * Classifica o erro do provedor num vocabulário nosso.
 *
 * Existe porque provedores diferentes relatam o MESMO problema de formas
 * diferentes: a mesma chave inválida vira `AI_APICallError` num, `401
 * Unauthorized` noutro e `authentication_error` num terceiro. Sem normalizar, a
 * tela de execuções mostraria três textos distintos e o operador não saberia
 * que os três são a mesma conversa — "a chave está errada".
 *
 * Os baldes são escolhidos pela AÇÃO que cada um exige de quem instalou:
 * trocar a chave, escolher outro modelo, esperar/pagar, ou aguardar o provedor.
 */
/**
 * Exportada para o diagnóstico da instalação usar a MESMA régua. Sem isto,
 * "por que o funcionário não responde" teria uma classificação própria, e as
 * duas telas dariam nomes diferentes ao mesmo erro do provedor.
 */
export function normalizarErro(err: unknown): {
  error_code: string;
  error_message: string;
  http_status: number | null;
} {
  const bloqueio = identificarConteudoBloqueado(err);
  if (bloqueio) return { error_code: 'conteudo_bloqueado', error_message: bloqueio.message, http_status: bloqueio.statusCode ?? null };
  const bruto = err instanceof Error ? err.message : String(err);
  const status =
    (err as { statusCode?: number; status?: number })?.statusCode ??
    (err as { statusCode?: number; status?: number })?.status ??
    null;

  // O único erro deste seam que NÃO vem do provedor: a recusa é NOSSA, e é
  // deliberada. Casada pela CLASSE e não por regex, porque aqui não há três
  // grafias de fornecedor para reconciliar — há um objeto que nós mesmos
  // construímos. Sem este ramo a tela de Execuções mostraria "Não conseguimos
  // classificar esta falha" no caso mais bem explicado do produto.
  // A subclasse ANTES da mãe: `LlmCarteiraEsgotadaError extends
  // LlmBudgetExceededError` (decisão 7 da fase F3): sem este ramo primeiro, o
  // `instanceof` de baixo casaria as duas e a carteira esgotada gravaria em
  // `llm_calls.error_code` o MESMO código do orçamento em dólar, apontando quem lê
  // para o campo errado (Uso de IA › Orçamento em vez de Plano e uso).
  if (err instanceof LlmCarteiraEsgotadaError) {
    return {
      error_code: 'carteira_de_tokens_esgotada',
      error_message: redigirMensagemDoProvedor(bruto),
      http_status: null,
    };
  }
  // Mesma doutrina do ramo acima, IRMÃ (não mãe/filha) de `LlmCarteiraEsgotadaError`:
  // as duas estendem `LlmBudgetExceededError` diretamente, então o `instanceof`
  // de uma nunca casa a outra — mas as duas precisam vir ANTES do ramo genérico
  // logo abaixo, senão a assinatura suspensa gravaria em `llm_calls.error_code`
  // o código do orçamento em dólar (fase F4, decisão 6, Tarefa 6).
  if (err instanceof LlmAssinaturaSuspensaError) {
    return {
      error_code: 'assinatura_suspensa',
      error_message: redigirMensagemDoProvedor(bruto),
      http_status: null,
    };
  }
  if (err instanceof LlmBudgetExceededError) {
    return { error_code: 'orcamento_esgotado', error_message: redigirMensagemDoProvedor(bruto), http_status: null };
  }
  // A outra recusa nossa: endereço da empresa com a chave da instalação.
  if (err instanceof LlmEnderecoExigeChaveDaEmpresaError) {
    return {
      error_code: 'endereco_exige_chave_da_empresa',
      error_message: redigirMensagemDoProvedor(bruto),
      http_status: null,
    };
  }

  let codigo = 'erro_desconhecido';
  if (status === 401 || status === 403 || /unauthor|invalid.*api.?key|authentication|incorrect api key/i.test(bruto)) {
    codigo = 'credencial_recusada';
  } else if (status === 404 || /model.*not.*found|does not exist/i.test(bruto)) {
    codigo = 'modelo_inexistente';
  } else if (status === 429 || /rate.?limit|quota|insufficient.*credit|credit balance is too low|no credits remaining/i.test(bruto)) {
    // A Anthropic diz "sem crédito" com 400 ("Your credit balance is too low…"),
    // o mesmo status de um pedido malformado — só a frase distingue. Sem ela a
    // tela de Execuções mostrava "erro desconhecido" no caso mais fácil de
    // resolver (recarregar). A espera pela recarga é da fila: `espera-de-saldo.ts`.
    codigo = 'limite_ou_saldo';
  } else if ((status !== null && status >= 500) || /timeout|ECONNREFUSED|fetch failed|network/i.test(bruto)) {
    codigo = 'provedor_indisponivel';
  } else if (/tool|function.?call/i.test(bruto)) {
    codigo = 'modelo_sem_ferramentas';
  }

  return {
    error_code: codigo,
    // Redigida E truncada. O comentário anterior dizia "sem
    // prompt/resposta/chave" e o único tratamento era o `slice` — a garantia
    // estava escrita e não existia, que é pior que não existir e ninguém
    // achar que existe.
    //
    // A mensagem crua do provedor vai para `llm_calls.error_message`, sai no
    // JSON de `GET /api/v1/ai/runs` e é renderizada na tela de Execuções para
    // qualquer `manager` da organização. Um endpoint OpenAI-compatível
    // apontado por `base_url` — caminho que o painel de provedores abre — pode
    // ecoar no corpo de erro o header de autorização ou o prompt recebido.
    error_message: redigirMensagemDoProvedor(bruto),
    http_status: typeof status === 'number' ? status : null,
  };
}

/**
 * Tira da mensagem do provedor o que não pode aparecer numa tela: segredo e
 * dado do titular. Trunca DEPOIS de redigir — cortar antes deixaria meia chave
 * passar, e meia chave ainda identifica de quem ela é.
 *
 * Os padrões de chave (`sk-…`, `Bearer …`) vêm daqui e não do
 * `lib/sentry/scrub.ts` porque lá o alvo é PII de titular; os dois se somam.
 */
export function redigirMensagemDoProvedor(bruto: string): string {
  const semSegredo = bruto
    // Chaves de API dos provedores que este produto fala: `sk-ant-…`,
    // `sk-or-v1-…`, `sk-proj-…`, `sk-…`, e as do Google (`AIza…`).
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[CHAVE]')
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, '[CHAVE]')
    // A do Jev (`apikey_<hex>_<hex>`), que não tem `sk-` e aparece solta.
    .replace(/\bapikey_[A-Za-z0-9_]{16,}/g, '[CHAVE]')
    // O header inteiro, em qualquer caixa, com ou sem `Authorization:` na
    // frente — é assim que ele costuma aparecer ecoado num corpo de erro.
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [CHAVE]')
    .replace(/\b(x-api-key|api[-_]?key|authorization)\b\s*[:=]\s*\S+/gi, '$1: [CHAVE]');
  return scrubMessage(semSegredo).slice(0, 500);
}

/**
 * Grava a chamada que FALHOU, na MESMA tabela do sucesso.
 *
 * Mesma tabela de propósito: a tela de execuções conta a história de um ponto em
 * ordem, e separar erros noutra tabela faria a leitura precisar de dois lugares
 * — que é exatamente como um dos dois para de ser olhado.
 *
 * Tokens ficam em zero e o custo em NULL: a chamada não consumiu nada, e `null`
 * é "não sei", nunca "de graça" — mesma doutrina da coluna `cost_cents`.
 */
async function registrarFalha(
  db: pg.Pool,
  d: {
    input: RastroDaChamada;
    purpose: string;
    provider: string;
    model: string;
    origem: string;
    /** 0906 (carteira de tokens): de quem é a chave desta chamada que falhou. */
    origemDaChave: OrigemDaChaveLlm;
    latencyMs: number;
    erro: unknown;
    /**
     * O que os passos concluídos antes da falha já custaram (D-156). Ausente em
     * toda recusa nossa (orçamento, carteira, assinatura): nelas nada saiu para o
     * provedor e os tokens ficam em zero.
     */
    usoParcial?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      custoCents: number | null;
    };
  },
): Promise<void> {
  const { error_code, error_message, http_status } = normalizarErro(d.erro);
  if (d.usoParcial) {
    const u = d.usoParcial;
    await db.query(
      `insert into llm_calls
         (organization_id, contact_id, job_id, variant_id, purpose, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, latency_ms,
          status, error_code, error_message, http_status, origem_da_escolha, agent_id, origem_da_chave)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'erro', $14, $15, $16, $17, $18, $19)`,
      [
        d.input.tenantId,
        d.input.leadId ?? null,
        d.input.jobId ?? null,
        d.input.variantId ?? null,
        d.purpose,
        d.provider,
        d.model,
        u.inputTokens,
        u.outputTokens,
        u.cacheReadTokens,
        u.cacheWriteTokens,
        u.custoCents,
        d.latencyMs,
        error_code,
        error_message,
        http_status,
        d.origem,
        d.input.agentId ?? null,
        d.origemDaChave,
      ],
    );
    return;
  }
  await db.query(
    `insert into llm_calls
       (organization_id, contact_id, job_id, variant_id, purpose, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, latency_ms,
        status, error_code, error_message, http_status, origem_da_escolha, agent_id, origem_da_chave)
     values ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, 0, null, $8, 'erro', $9, $10, $11, $12, $13, $14)`,
    [
      d.input.tenantId,
      d.input.leadId ?? null,
      d.input.jobId ?? null,
      d.input.variantId ?? null,
      d.purpose,
      d.provider,
      d.model,
      d.latencyMs,
      error_code,
      error_message,
      http_status,
      d.origem,
      d.input.agentId ?? null,
      d.origemDaChave,
    ],
  );
}
