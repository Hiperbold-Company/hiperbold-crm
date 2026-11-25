/**
 * Opções nativas na instância UAZAPI: o corpo de `POST /send/menu` e a leitura
 * do clique que volta pelo webhook. Puro, sem I/O.
 *
 * Formato documentado (docs.uazapi.com, "Enviar menu interativo"):
 *  - botão: `type: "button"`, `choices: ["Título|id", ...]`;
 *  - lista: `type: "list"`, `listButton` (o botão que abre a lista) e
 *    `choices: ["Título|id|descrição", ...]`.
 *
 * O separador é `|` e `[Texto]` abre seção na lista: um rótulo com `|`,
 * quebra de linha ou `[` no começo quebraria o formato e o contato veria outra
 * opção. Nesses casos a função devolve `null` e quem envia manda o texto
 * numerado — nunca um menu torto.
 */
import type { OutboundInteractive } from "../types";

export interface CorpoDoMenuUazapi {
  number: string;
  type: "button" | "list";
  text: string;
  choices: string[];
  listButton?: string;
  replyid?: string;
}

function pedacoSeguro(s: string): boolean {
  return !/[|\r\n]/.test(s) && !s.trimStart().startsWith("[");
}

/** O corpo do `/send/menu`, ou `null` quando as opções não cabem no formato. */
export function corpoDoMenuUazapi(
  numero: string,
  texto: string,
  opcoes: OutboundInteractive,
  citacao?: string | null,
): CorpoDoMenuUazapi | null {
  const partes = opcoes.items.flatMap((i) => [i.id, i.label, ...("description" in i && i.description ? [i.description] : [])]);
  if (!partes.every(pedacoSeguro)) return null;
  const base = { number: numero, text: texto, ...(citacao ? { replyid: citacao } : {}) };
  if (opcoes.kind === "buttons") {
    return { ...base, type: "button", choices: opcoes.items.map((i) => `${i.label}|${i.id}`) };
  }
  if (!pedacoSeguro(opcoes.button_label)) return null;
  return {
    ...base,
    type: "list",
    listButton: opcoes.button_label,
    choices: opcoes.items.map((i) => (i.description ? `${i.label}|${i.id}|${i.description}` : `${i.label}|${i.id}`)),
  };
}

/** A opção tocada, na forma que todo canal grava em `messages.metadata.reply`. */
export interface RespostaDeOpcaoUazapi {
  id: string | null;
  title: string;
  kind: "button_reply" | "list_reply";
}

type Bruto = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
const obj = (v: unknown): Bruto | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Bruto) : null);

/**
 * O clique num botão ou item de lista, ou `null` quando a mensagem não é um.
 *
 * O servidor marca o id escolhido em `buttonOrListid`; o título é o `text` da
 * mensagem. O payload real do clique NÃO está documentado, então também se lê
 * a forma do WhatsApp dentro de `content` (`selectedDisplayText`,
 * `selectedButtonId`, `singleSelectReply.selectedRowId`, `title`). Sem título
 * legível, não é tratado como clique: o casamento depende do texto.
 */
export function respostaDeOpcaoUazapi(
  m: { buttonOrListid?: unknown; text?: unknown; messageType?: unknown; content?: unknown },
): RespostaDeOpcaoUazapi | null {
  const c = obj(m.content);
  const unica = obj(c?.singleSelectReply);
  const id = str(m.buttonOrListid) ?? str(c?.selectedButtonId) ?? str(unica?.selectedRowId) ?? str(c?.selectedId);
  const tipo = (str(m.messageType) ?? "").toLowerCase();
  const pareceClique = id !== null || tipo.includes("buttonsresponse") || tipo.includes("listresponse") || tipo.includes("templatebuttonreply");
  if (!pareceClique) return null;
  const title = str(m.text) ?? str(c?.selectedDisplayText) ?? str(c?.title) ?? str(c?.text);
  if (!title) return null;
  return { id, title, kind: tipo.includes("list") || unica ? "list_reply" : "button_reply" };
}
