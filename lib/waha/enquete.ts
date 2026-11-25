/**
 * Opções nativas no canal por QR (WAHA): ENQUETE (`POST /api/sendPoll`) na
 * ida, e o voto (`poll.vote`) na volta. Puro, sem I/O.
 *
 * `sendButtons` do WAHA está depreciado e não é usado. A enquete é a única
 * forma estável de opção tocável num aparelho pareado, e o voto chega pelo
 * NOME da opção (`selectedOptions`), não por id — por isso o nome que sai e o
 * que se procura na volta saem da MESMA função (`nomeDaOpcaoNaEnquete`).
 *
 * Limites: o WhatsApp corta a pergunta de enquete em 255 caracteres e aceita
 * até 12 opções. Pergunta maior, rótulos repetidos (depois de normalizar) ou
 * nome vazio devolvem `null`, e quem envia manda o texto numerado.
 */
import { normalizarRotulo } from "@/lib/channels/opcoes-numeradas";
import type { OutboundInteractive } from "@/lib/channels/types";

export const MAX_PERGUNTA_DA_ENQUETE = 255;
export const MAX_OPCOES_DA_ENQUETE = 12;

/** O nome com que a opção aparece na enquete — e com que o voto volta. */
export function nomeDaOpcaoNaEnquete(item: { label: string }): string {
  return item.label.trim();
}

export interface CorpoDaEnqueteWaha {
  session: string;
  chatId: string;
  poll: { name: string; options: string[]; multipleAnswers: false };
  reply_to?: string;
}

/** O corpo do `sendPoll`, ou `null` quando as opções não cabem numa enquete. */
export function corpoDaEnqueteWaha(
  session: string,
  chatId: string,
  texto: string,
  opcoes: OutboundInteractive,
  citacao?: string | null,
): CorpoDaEnqueteWaha | null {
  const name = texto.trim();
  if (!name || name.length > MAX_PERGUNTA_DA_ENQUETE) return null;
  if (opcoes.items.length < 2 || opcoes.items.length > MAX_OPCOES_DA_ENQUETE) return null;
  const options = opcoes.items.map(nomeDaOpcaoNaEnquete);
  if (options.some((o) => !o)) return null;
  if (new Set(options.map(normalizarRotulo)).size !== options.length) return null;
  return { session, chatId, poll: { name, options, multipleAnswers: false }, ...(citacao ? { reply_to: citacao } : {}) };
}

/** O voto lido do evento `poll.vote`. */
export interface VotoDaEnquete {
  /** Id do voto (mensagem de atualização da enquete). */
  voteId: string;
  /** Id da enquete votada, como o WAHA o escreve (`true_<chat>_<id>`). */
  pollId: string;
  /** Quem votou. */
  from: string;
  /** A opção escolhida: a primeira de `selectedOptions` (a enquete sai com uma escolha só). */
  opcao: string;
  /** Segundos (ou ms) do voto, como veio. */
  timestamp: number | null;
}

type Bruto = Record<string, unknown>;
const obj = (v: unknown): Bruto | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

/**
 * Lê o payload de `poll.vote`. `null` quando não é voto de cliente: voto nosso
 * (`fromMe`), voto retirado (`selectedOptions` vazio — é também a forma do
 * `poll.vote.failed`) ou payload sem identificador.
 */
export function lerVotoDaEnquete(payload: unknown): VotoDaEnquete | null {
  const p = obj(payload);
  const vote = obj(p?.vote);
  const poll = obj(p?.poll);
  if (!vote || !poll) return null;
  if (vote.fromMe === true) return null;
  const voteId = str(vote.id);
  const pollId = str(poll.id);
  const from = str(vote.from);
  const opcoes = Array.isArray(vote.selectedOptions) ? vote.selectedOptions.map(str).filter((o): o is string => !!o) : [];
  if (!voteId || !pollId || !from || opcoes.length === 0) return null;
  const ts = typeof vote.timestamp === "number" && Number.isFinite(vote.timestamp) ? vote.timestamp : null;
  return { voteId, pollId, from, opcao: opcoes[0]!, timestamp: ts };
}

/**
 * O `external_id` da linha que o voto vira. Determinístico: a reentrega do
 * mesmo evento bate no unique `(organization_id, external_id)` e não grava em
 * dobro. O carimbo entra porque o WhatsApp deixa TROCAR o voto, e cada troca é
 * uma resposta nova do cliente (o WAHA manda um `poll.vote` por clique).
 */
export function externalIdDoVoto(v: VotoDaEnquete): string {
  return `poll_vote:${v.voteId}:${v.timestamp ?? 0}`;
}

/** A opção oferecida que o voto escolheu, pelo mesmo nome que saiu na enquete. */
export function opcaoDoVoto(
  opcao: string,
  oferecidas: OutboundInteractive | null,
): { id: string; label: string } | null {
  if (!oferecidas) return null;
  const alvo = normalizarRotulo(opcao);
  const achadas = oferecidas.items.filter((i) => normalizarRotulo(nomeDaOpcaoNaEnquete(i)) === alvo);
  return achadas.length === 1 ? { id: achadas[0]!.id, label: achadas[0]!.label } : null;
}
