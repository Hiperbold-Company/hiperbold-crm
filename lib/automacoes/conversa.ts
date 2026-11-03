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
 * execução NUNCA guardam o texto da resposta — só o tamanho e o id da opção.
 */
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { isValidCpf } from "@/lib/legal/perfil-do-pais";
import type { EnrollmentEventRef } from "@/lib/followup/node-handlers";
import type { QuestionValidation } from "@/lib/followup/graph-schema";

import { EMAIL_RX, coagirPeloTipo, dataIso } from "./campos";

/** Namespace das respostas em `vars` (e em `{{...}}`). */
export const NAMESPACE_DA_RESPOSTA = "resposta";

/** A chave do nó nas variáveis: `question-3` → `question_3`. */
export function chaveDaResposta(nodeId: string): string {
  return nodeId.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Teto do texto de resposta guardado (campo e variável). */
export const MAX_TEXTO_DA_RESPOSTA = 2000;

export type ConferenciaDaResposta = { ok: true; valor: string } | { ok: false };

/**
 * A resposta de uma pergunta serve para o tipo pedido? Devolve o valor já
 * normalizado (telefone canônico com `+`, CPF só dígitos, data AAAA-MM-DD,
 * número como o contato escreveu, sem espaços).
 */
export function conferirRespostaDaPergunta(validacao: QuestionValidation, bruto: string): ConferenciaDaResposta {
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

export function estadoDaEspera(events: readonly EnrollmentEventRef[], nodeId: string): EstadoDaEspera {
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
      const primeiro = Array.isArray(detalhes) ? (detalhes[0] as Record<string, unknown> | undefined) : undefined;
      if (primeiro?.envio === ENVIO_NOVA_TENTATIVA) novasTentativas++;
    }
  }
  return { aguardando, prazo, novasTentativas };
}

/**
 * Piso das respostas que contam para a espera em curso: o instante em que ela
 * começou (prazo − tempo limite). A resposta anterior ao envio (ou à nova
 * tentativa) nunca responde a esta pergunta.
 */
export function pisoDaEspera(prazo: string | null, timeoutMs: number, fallback: string): string {
  if (!prazo) return fallback;
  const t = Date.parse(prazo) - timeoutMs;
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}
