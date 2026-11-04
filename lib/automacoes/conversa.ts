/**
 * Blocos de CONVERSA das automações (lote 2) — a parte PURA: o estado da
 * espera de resposta lido dos eventos, a conferência da resposta de uma
 * pergunta e a chave em que a resposta fica nas variáveis da execução.
 *
 * Quem decide o caminho é `node-handlers.ts` (DECISORES.message/question/wait);
 * quem envia e grava é `lib/automacoes/efeitos` (`enviarMensagemDoBloco`).
 *
 * ─── A resposta nas variáveis ──────────────────────────────────────────────
 *
 * A resposta aceita fica em `vars.resposta.<chave do nó>` e os blocos seguintes
 * a leem como `{{resposta.<chave do nó>}}` (texto) e pela variável
 * `resposta.<chave do nó>` (condição). A chave é o id do nó com tudo que não é
 * letra, número ou `_` trocado por `_` (`question-3` → `question_3`), porque o
 * `{{...}}` só aceita `[\w.]`. No bloco de mensagem com opções guarda-se o
 * RÓTULO da opção, e o id em `resposta.<chave>_opcao`.
 *
 * O CPF não fica nas variáveis (só no campo escolhido): variável aparece em
 * texto de mensagem e de aviso, e CPF não sai em texto (D-216).
 *
 * As variáveis são apagadas quando o contato é anonimizado
 * (`fn_contato_anonimizado_limpa_automacoes`, `vars = '{}'`), e os eventos da
 * execução NUNCA guardam o texto da resposta — só o id da opção e o nome do
 * campo. O motor tira o namespace `resposta` de `vars` antes de gravar o
 * `effect_done` (`varsParaOEvento`) e, num replay, recalcula-o da decisão
 * (`varsDaResposta`), que é determinística: as mesmas mensagens desde o mesmo
 * piso dão a mesma resposta aceita.
 *
 * A espera "até responder" não guarda texto nenhum: nem no campo (não tem
 * destino), nem nas variáveis, nem no evento.
 */
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { isValidCpf } from "@/lib/legal/perfil-do-pais";
import type { EnrollmentEventRef } from "@/lib/followup/node-handlers";
import type { FlowNode, QuestionValidation } from "@/lib/followup/graph-schema";

import { EMAIL_RX, coagirPeloTipo, dataIso } from "./campos";

/** Namespace das respostas em `vars` (e em `{{...}}`). */
export const NAMESPACE_DA_RESPOSTA = "resposta";

/** A chave do nó nas variáveis: `question-3` → `question_3`. */
export function chaveDaResposta(nodeId: string): string {
  return nodeId.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * As variáveis que a resposta aceita deixa na execução: `{ resposta: {...} }`,
 * somando às respostas anteriores. CPF e a espera "até responder" não guardam
 * o valor; a opção guarda o id em `<chave>_opcao`. Pura: é o mesmo cálculo no
 * efeito e no replay do motor.
 */
export function varsDaResposta(
  node: Pick<FlowNode, "id" | "type" | "config">,
  acao: { valor: string; opcao_id?: string },
  varsAnteriores: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const chave = chaveDaResposta(node.id);
  const guardaValor =
    node.type !== "wait" &&
    !(node.type === "question" && (node.config as { validation?: string }).validation === "cpf");
  const bruto = varsAnteriores?.[NAMESPACE_DA_RESPOSTA];
  const anteriores =
    bruto && typeof bruto === "object" && !Array.isArray(bruto)
      ? (bruto as Record<string, unknown>)
      : {};
  return {
    [NAMESPACE_DA_RESPOSTA]: {
      ...anteriores,
      ...(guardaValor ? { [chave]: acao.valor } : {}),
      ...(acao.opcao_id ? { [`${chave}_opcao`]: acao.opcao_id } : {}),
    },
  };
}

/**
 * O pedaço de `vars` que pode ir ao payload de um evento: tudo menos o
 * namespace `resposta` (texto do contato). `undefined` quando não sobra nada.
 */
export function varsParaOEvento(
  vars: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!vars) return undefined;
  const { [NAMESPACE_DA_RESPOSTA]: _fora, ...resto } = vars;
  return Object.keys(resto).length > 0 ? resto : undefined;
}

/** Teto do texto de resposta guardado (campo e variável). */
export const MAX_TEXTO_DA_RESPOSTA = 2000;

export type ConferenciaDaResposta = { ok: true; valor: string } | { ok: false };

/**
 * A resposta de uma pergunta serve para o tipo pedido? Devolve o valor já
 * normalizado (telefone canônico com `+`, CPF só dígitos, data AAAA-MM-DD,
 * número como o contato escreveu, sem espaços).
 */
export function conferirRespostaDaPergunta(
  validacao: QuestionValidation,
  bruto: string,
): ConferenciaDaResposta {
  const texto = bruto.trim();
  if (!texto) return { ok: false };
  switch (validacao) {
    case "text":
      return { ok: true, valor: texto.slice(0, MAX_TEXTO_DA_RESPOSTA) };
    case "email":
      return EMAIL_RX.test(texto) ? { ok: true, valor: texto.toLowerCase() } : { ok: false };
    case "number": {
      const r = coagirPeloTipo({ type: "number" }, texto);
      return r.ok ? { ok: true, valor: String(r.valor) } : { ok: false };
    }
    case "date": {
      const d = dataIso(texto);
      return d ? { ok: true, valor: d } : { ok: false };
    }
    case "cpf": {
      const digitos = texto.replace(/\D/g, "");
      // Só dígitos e pontuação de CPF: "meu cpf é 123..." não é a resposta.
      if (!/^[\d.\-\s/]+$/.test(texto)) return { ok: false };
      return isValidCpf(digitos) ? { ok: true, valor: digitos } : { ok: false };
    }
    case "phone": {
      if (!/^[\d()+.\-\s]+$/.test(texto)) return { ok: false };
      const digitos = texto.replace(/\D/g, "");
      // Sem DDI: 10 ou 11 dígitos são número brasileiro com DDD.
      const comDdi = digitos.length === 10 || digitos.length === 11 ? `55${digitos}` : digitos;
      if (comDdi.length < 12 || comDdi.length > 15) return { ok: false };
      return { ok: true, valor: canonicalPhoneBR(`+${comDdi}`) };
    }
  }
}

/**
 * Começo da marca que a ingestão do oficial grava no lugar de um tipo que o
 * CRM não sabe mostrar (`marcaDeNaoSuportado`, `lib/channels/meta/webhook.ts`).
 * Repetido aqui porque este módulo vai ao navegador (o editor) e o webhook
 * importa `node:crypto`; `conversa.test.ts` confere que os dois batem.
 */
export const PREFIXO_DA_MARCA_DE_NAO_SUPORTADO = "[tipo de mensagem não suportado:";

/**
 * A mensagem do contato conta como resposta de um bloco de conversa? Reação
 * (👍 numa mensagem) não é resposta, nem a marca de tipo não suportado — as
 * duas são gravadas como inbound mas o contato não respondeu nada. Mídia sem
 * texto (áudio, imagem) CONTA: acorda a espera "até responder" e, na pergunta
 * ou nas opções, é resposta inválida.
 */
export function inboundContaComoResposta(m: {
  type?: string | null;
  body?: string | null;
}): boolean {
  if (m.type === "reaction") return false;
  if (
    typeof m.body === "string" &&
    m.body.trimStart().startsWith(PREFIXO_DA_MARCA_DE_NAO_SUPORTADO)
  )
    return false;
  return true;
}

/** Uma mensagem do contato chegada depois do início da espera. */
export interface RespostaRecebida {
  texto: string;
  /** Id da opção tocada (resposta nativa: `messages.metadata.reply.id`). */
  replyId: string | null;
}

/**
 * O que um bloco que espera resposta já fez NESTA estadia, lido dos eventos.
 *
 * A estadia é a sequência final de eventos do nó (parando no último
 * `node_advanced` dele, para que voltar ao mesmo bloco comece do zero).
 */
export interface EstadoDaEspera {
  /** Já estacionou esperando resposta nesta estadia. */
  aguardando: boolean;
  /** Prazo da espera em curso (ISO), ou `null` quando ainda não estacionou. */
  prazo: string | null;
  /** Novas tentativas já enviadas depois de resposta inválida. */
  novasTentativas: number;
}

/** O envio que um bloco de conversa grava no detalhe do efeito (lido de volta aqui). */
export const ENVIO_NOVA_TENTATIVA = "nova_tentativa";

export function estadoDaEspera(
  events: readonly EnrollmentEventRef[],
  nodeId: string,
): EstadoDaEspera {
  let prazo: string | null = null;
  let aguardando = false;
  let novasTentativas = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.node_id !== nodeId) break;
    if (e.event_type === "node_advanced") break;
    if (e.event_type === "wait_started") {
      aguardando = true;
      const next = e.payload?.next_eval_at;
      if (prazo === null && typeof next === "string") prazo = next;
    }
    if (e.event_type === "effect_done" || e.event_type === "effect_failed") {
      const detalhes = e.payload?.detalhes;
      const primeiro = Array.isArray(detalhes)
        ? (detalhes[0] as Record<string, unknown> | undefined)
        : undefined;
      if (primeiro?.envio === ENVIO_NOVA_TENTATIVA) novasTentativas++;
    }
  }
  return { aguardando, prazo, novasTentativas };
}

/**
 * Folga de 5 s no piso, só no relógio do PROVEDOR: o `sent_at` do inbound vem
 * do aparelho/da Meta (segundos, às vezes atrás do nosso), e o contato que
 * responde no mesmo instante do envio não pode ficar de fora. A folga nunca
 * vale para o NOSSO relógio: a mensagem também precisa ter CHEGADO
 * (`created_at`) depois do início da espera. Sem essa segunda régua, a folga
 * leria como resposta a mensagem que disparou a automação (o "Oi" que criou o
 * negócio segundos antes da pergunta) ou a resposta inválida que acabou de
 * provocar a nova tentativa.
 */
export const MARGEM_DO_PISO_MS = 5_000;

/** A mensagem entra na espera que começou em `piso`? As duas réguas de `MARGEM_DO_PISO_MS`. */
export function inboundDentroDaEspera(
  m: { sent_at?: string | null; created_at?: string | null },
  piso: string,
): boolean {
  const p = Date.parse(piso);
  const enviada = Date.parse(m.sent_at ?? "");
  const chegou = Date.parse(m.created_at ?? m.sent_at ?? "");
  if (!Number.isFinite(p) || !Number.isFinite(enviada) || !Number.isFinite(chegou)) return false;
  return chegou >= p && enviada >= p - MARGEM_DO_PISO_MS;
}

/**
 * Piso das respostas que contam para a espera em curso: o instante em que ela
 * começou (prazo − tempo limite). A resposta anterior ao envio (ou à nova
 * tentativa) nunca responde a esta pergunta (ver `inboundDentroDaEspera`).
 */
export function pisoDaEspera(prazo: string | null, timeoutMs: number, fallback: string): string {
  if (!prazo) return fallback;
  const t = Date.parse(prazo) - timeoutMs;
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

/** O envio que o registro de uma resposta grava no detalhe do efeito (`efeitos/conversa.ts`). */
export const ENVIO_RESPOSTA = "resposta";

/**
 * Piso da PRIMEIRA leitura de uma espera numa execução que começou por
 * comentário (Direct). Quem pede a resposta privada não espera nada: ela sai
 * pelo cron do canal, e o "quero" pode chegar antes de a execução estacionar no
 * "Aguardar". Pela régua de sempre (o instante da espera) esse "quero" nunca
 * contaria, e a execução esperaria por uma resposta que já veio.
 *
 * O piso é o mais novo entre:
 *  - o início da execução (`started_at`);
 *  - o evento mais antigo que se leu dela (a lista pode vir cortada: nada antes
 *    do que foi lido pode ser afirmado como "ainda não consumido");
 *  - o último registro de resposta (`effect_done` com `envio = "resposta"`) de
 *    OUTRA estadia: a mensagem que respondeu ao bloco anterior não responde a
 *    este.
 *
 * `null` quando não dá para afirmar nada (evento sem `created_at`, início
 * ilegível) ou quando o bloco ENVIOU nesta estadia (Mensagem com opções,
 * Pergunta: a resposta só vale depois da mensagem dele) — quem chama fica com
 * o piso de sempre. A nova tentativa não passa
 * por aqui (o motor só chama com `novasTentativas === 0`): depois da primeira
 * leitura, o piso é o da espera em curso, e a resposta lida não é relida.
 */
export function pisoDaRespostaNoDirect(
  events: readonly EnrollmentEventRef[],
  nodeId: string,
  inicioDaExecucao: string | null | undefined,
): string | null {
  const inicio = Date.parse(inicioDaExecucao ?? "");
  if (!Number.isFinite(inicio)) return null;
  // A estadia atual: a sequência final de eventos deste nó (como `estadoDaEspera`).
  let fimDasAnteriores = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.node_id !== nodeId || e.event_type === "node_advanced") break;
    fimDasAnteriores = i;
    // Bloco que ENVIOU nesta estadia (Mensagem com opções, Pergunta): a
    // resposta é à mensagem dele, e só conta depois do envio — o piso de
    // sempre. O recuo é só da espera que não manda nada ("até responder").
    if (e.event_type === "effect_done" || e.event_type === "effect_failed") {
      const d = e.payload?.detalhes;
      const envio = Array.isArray(d) ? (d[0] as Record<string, unknown> | undefined)?.envio : undefined;
      if (typeof envio === "string" && envio !== ENVIO_RESPOSTA) return null;
    }
  }
  let piso = inicio;
  if (events.length > 0) {
    const primeiro = Date.parse(events[0]!.created_at ?? "");
    if (!Number.isFinite(primeiro)) return null;
    piso = Math.max(piso, primeiro);
  }
  for (let i = 0; i < fimDasAnteriores; i++) {
    const e = events[i]!;
    if (e.event_type !== "effect_done") continue;
    const detalhes = e.payload?.detalhes;
    const primeiro = Array.isArray(detalhes) ? (detalhes[0] as Record<string, unknown> | undefined) : undefined;
    if (primeiro?.envio !== ENVIO_RESPOSTA) continue;
    const t = Date.parse(e.created_at ?? "");
    if (!Number.isFinite(t)) return null;
    piso = Math.max(piso, t);
  }
  return new Date(piso).toISOString();
}
