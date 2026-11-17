/**
 * MENSAGEM AGENDADA NO CHAT — as regras puras (migration 1017).
 *
 * Duas perguntas, e as duas usam a MESMA régua de janela que a tela e a porta de
 * envio já usam (`estadoDaJanela`, `lib/channels/janela.ts`). Uma terceira régua
 * aqui seria a forma mais fácil de o agendamento prometer um envio que a porta
 * recusa na hora.
 *
 *   1. No ato de agendar: a janela de 24h estará aberta no horário escolhido?
 *      Se não, e o canal tem modelo aprovado (WhatsApp oficial e parceiro), a
 *      tela exige um modelo. Canal sem modelo (Instagram, Messenger) agenda, mas
 *      avisa: se o cliente não escrever antes, nada sai.
 *   2. Na hora do envio: janela aberta manda o TEXTO; fechada manda o MODELO;
 *      fechada sem modelo não manda nada e vira falha com motivo legível.
 *
 * O que fica de fora daqui, de propósito: opt-out, organização parada, janela de
 * horário do canal e throttle. Esses são da cadeia de envio e do worker, que já
 * os conhecem.
 */
import { estadoDaJanela, type EstadoDaJanela } from "@/lib/channels/janela";
import { fonteDeTemplates } from "@/lib/channels/templates-fonte";

/** O vocabulário do CHECK `scheduled_messages_status_check`. A ordem não importa. */
export const STATUS_DA_AGENDADA = ["agendada", "enviando", "enviada", "cancelada", "falhou"] as const;
export type StatusDaAgendada = (typeof STATUS_DA_AGENDADA)[number];

/** Até quando se pode agendar. Mais longe que isso a conversa e o canal já não são os mesmos. */
export const PRAZO_MAXIMO_DIAS = 90;

/**
 * Linha `enviando` cujo lease (`reservada_em`) é mais velho que isto ficou presa
 * (o worker caiu no meio). O worker RENOVA o lease logo antes de cada envio e
 * para de enviar depois de `PRAZO_DA_RODADA_MS`, então uma linha que a rodada
 * ainda está enviando nunca tem lease mais velho que o tempo de UM envio — bem
 * abaixo destes 10 minutos. Ver `lib/mensagens-agendadas/worker.ts`.
 */
export const PRESA_APOS_MS = 10 * 60 * 1000;

/**
 * Até quando a rodada começa envios novos. Passado isto, o que ela reservou e
 * ainda não enviou volta para `agendada` (a próxima rodada pega). Metade de
 * `PRESA_APOS_MS`: o lease renovado no começo do envio nunca envelhece até lá.
 */
export const PRAZO_DA_RODADA_MS = 5 * 60 * 1000;

/**
 * Tetos de agendadas PENDENTES (`agendada` ou `enviando`). Acima deles a criação
 * é recusada com 422: uma conversa com dezenas de mensagens marcadas é engano
 * ou abuso, e uma pessoa com centenas ocuparia a fila de envio da instalação.
 * A conta é feita antes do insert, sem trava no banco: duas criações
 * simultâneas podem passar o teto por uma — é um teto de uso, não de segurança.
 */
export const MAX_PENDENTES_POR_CONVERSA = 20;
export const MAX_PENDENTES_POR_USUARIO = 200;

/** O que a tela escolhe: o servidor confere contra o espelho e monta o resto. */
export interface ModeloEscolhido {
  name: string;
  language: string;
  values: Record<string, string>;
}

/** O modelo escolhido no agendamento, guardado em `scheduled_messages.template`. */
export interface ModeloDaAgendada {
  name: string;
  language: string;
  values: Record<string, string>;
  /**
   * O texto do corpo do modelo: é o `body` do envio e o que a conversa mostra.
   * Sai SEMPRE da definição guardada no espelho (`meta_templates`), nunca do
   * que o navegador mandou.
   */
  body: string;
}

/** Lê a janela sem lançar: provider desconhecido não pode derrubar o agendamento. */
function janelaEm(provider: string | null | undefined, lastInboundAt: string | null, quando: Date): EstadoDaJanela {
  try {
    return estadoDaJanela(provider, lastInboundAt, quando);
  } catch {
    return { tipo: "sem_restricao" };
  }
}

/** O canal tem modelo aprovado para oferecer (a mesma pergunta que o seletor da tela faz). */
export function canalTemModelo(provider: string | null | undefined): boolean {
  return fonteDeTemplates(provider) !== null;
}

export type ExigenciaAoAgendar =
  /** A janela estará aberta (ou o canal não tem janela): só o texto basta. */
  | { tipo: "livre" }
  /** A janela estará fechada e o canal tem modelo: escolher um é obrigatório. */
  | { tipo: "modelo_obrigatorio" }
  /** A janela estará fechada e o canal não tem modelo: agenda, mas só sai se o cliente escrever antes. */
  | { tipo: "sem_saida_fora_da_janela" };

/**
 * O que o agendamento exige, olhando a janela NO HORÁRIO ESCOLHIDO.
 *
 * "Já fechada" e "fecha antes do horário" são a mesma resposta: a janela medida
 * em `sendAt` está fechada. A conta é sobre a última mensagem do cliente que
 * existe agora; se ele escrever depois, a janela reabre e o texto sai.
 */
export function exigenciaAoAgendar(
  provider: string | null | undefined,
  lastInboundAt: string | null,
  sendAt: Date,
): ExigenciaAoAgendar {
  if (janelaEm(provider, lastInboundAt, sendAt).tipo !== "fechada") return { tipo: "livre" };
  return canalTemModelo(provider) ? { tipo: "modelo_obrigatorio" } : { tipo: "sem_saida_fora_da_janela" };
}

export type DecisaoDoEnvio =
  | { tipo: "texto" }
  | { tipo: "modelo" }
  | { tipo: "falha"; codigo: "janela_fechada_sem_modelo" | "janela_fechada"; motivo: string };

/** Frases da falha. Chaves do dicionário (pt-BR é a chave; es e en ao lado). */
export const MOTIVO_SEM_MODELO =
  "A janela de 24 horas fechou e nenhum modelo aprovado foi escolhido. Nada foi enviado.";
export const MOTIVO_CANAL_SEM_MODELO =
  "A janela de 24 horas deste canal fechou antes do horário, e ele não aceita mensagem fora dela. Nada foi enviado.";

/** Na hora do envio: texto, modelo ou falha. */
export function decidirEnvioAgendado(entrada: {
  provider: string | null | undefined;
  lastInboundAt: string | null;
  agora: Date;
  temModelo: boolean;
}): DecisaoDoEnvio {
  if (janelaEm(entrada.provider, entrada.lastInboundAt, entrada.agora).tipo !== "fechada") {
    return { tipo: "texto" };
  }
  if (canalTemModelo(entrada.provider)) {
    return entrada.temModelo
      ? { tipo: "modelo" }
      : { tipo: "falha", codigo: "janela_fechada_sem_modelo", motivo: MOTIVO_SEM_MODELO };
  }
  return { tipo: "falha", codigo: "janela_fechada", motivo: MOTIVO_CANAL_SEM_MODELO };
}

/** Lê o jsonb da coluna `template` sem confiar na forma. `null` = sem modelo utilizável. */
export function lerModelo(valor: unknown): ModeloDaAgendada | null {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return null;
  const v = valor as Record<string, unknown>;
  if (typeof v.name !== "string" || !v.name || typeof v.language !== "string" || !v.language) return null;
  const values: Record<string, string> = {};
  if (v.values && typeof v.values === "object" && !Array.isArray(v.values)) {
    for (const [chave, texto] of Object.entries(v.values as Record<string, unknown>)) {
      if (typeof texto === "string") values[chave] = texto;
    }
  }
  const body = typeof v.body === "string" && v.body.trim() ? v.body : v.name;
  return { name: v.name, language: v.language, values, body };
}

/** O horário é aceitável: no futuro e dentro do prazo máximo. */
export function horarioValido(sendAt: Date, agora: Date): boolean {
  const t = sendAt.getTime();
  if (Number.isNaN(t)) return false;
  return t > agora.getTime() && t <= agora.getTime() + PRAZO_MAXIMO_DIAS * 24 * 60 * 60 * 1000;
}
