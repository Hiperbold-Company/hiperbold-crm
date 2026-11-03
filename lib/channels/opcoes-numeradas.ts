/**
 * Mensagem com opções (botões ou lista): a validação, a conversão para texto
 * numerado e o casamento da resposta com a opção.
 *
 * ─── Por que texto numerado ────────────────────────────────────────────────
 *
 * Só o WhatsApp oficial desenha botões e lista (`interactive: "native"` na
 * matriz de capabilities). Nos outros canais o contato recebe o MESMO conteúdo
 * como texto ("1) Moradia\n2) Investimento") e responde digitando o número ou
 * o rótulo. As duas pontas moram aqui, juntas, para que a forma de escrever e a
 * forma de ler não divirjam: o número que `textoComOpcoesNumeradas` imprime é o
 * que `casarRespostaComOpcao` aceita.
 *
 * ─── Por que o casamento é estrito ─────────────────────────────────────────
 *
 * Errar para "não casou" custa uma nova pergunta; errar para "casou" leva o
 * contato por um caminho que ele não escolheu. Por isso o rótulo só casa por
 * IGUALDADE (depois de normalizar), nunca por "contém": "não quero moradia"
 * não é a opção "Moradia".
 */
import { z } from "zod";

import type { OutboundInteractive } from "./types";

export const MAX_BOTOES = 3;
export const MAX_ITENS_DA_LISTA = 10;
export const MAX_ROTULO_DO_BOTAO = 20;
export const MAX_ROTULO_DA_LISTA = 24;
export const MAX_DESCRICAO_DA_LISTA = 72;
/** Teto do texto do corpo de uma mensagem com opções nativas na plataforma oficial. */
export const MAX_CORPO_COM_OPCOES = 1024;
/** Teto do id de uma opção na plataforma oficial. */
const MAX_ID_DA_OPCAO = 256;

const idDaOpcao = z.string().trim().min(1).max(MAX_ID_DA_OPCAO);

function idsUnicos(items: { id: string }[]): boolean {
  return new Set(items.map((i) => i.id)).size === items.length;
}

export const interactiveSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("buttons"),
    items: z
      .array(z.object({ id: idDaOpcao, label: z.string().trim().min(1).max(MAX_ROTULO_DO_BOTAO) }))
      .min(1)
      .max(MAX_BOTOES)
      .refine(idsUnicos, { message: "ids das opções repetidos" }),
  }),
  z.object({
    kind: z.literal("list"),
    button_label: z.string().trim().min(1).max(MAX_ROTULO_DO_BOTAO),
    items: z
      .array(
        z.object({
          id: idDaOpcao,
          label: z.string().trim().min(1).max(MAX_ROTULO_DA_LISTA),
          description: z.string().trim().min(1).max(MAX_DESCRICAO_DA_LISTA).optional(),
        }),
      )
      .min(1)
      .max(MAX_ITENS_DA_LISTA)
      .refine(idsUnicos, { message: "ids das opções repetidos" }),
  }),
]) satisfies z.ZodType<OutboundInteractive>;

/** Como as opções chegaram ao contato — gravado em `messages.metadata.interactive.entrega`. */
export type EntregaDasOpcoes = "nativa" | "texto_numerado";

/** O que a linha de `messages` guarda em `metadata.interactive`. */
export type OpcoesGravadas = OutboundInteractive & { entrega: EntregaDasOpcoes };

/**
 * O corpo seguido das opções numeradas, uma por linha: `1) Moradia`.
 *
 * Na lista, a descrição vai depois do rótulo (`1) Moradia - até 2 quartos`):
 * sem ela o contato perderia a informação que a lista nativa mostraria.
 */
export function textoComOpcoesNumeradas(corpo: string, interactive: OutboundInteractive): string {
  const linhas = interactive.items.map((item, i) => {
    const descricao = "description" in item && item.description ? ` - ${item.description}` : "";
    return `${i + 1}) ${item.label}${descricao}`;
  });
  const cabeca = corpo.trim();
  return cabeca ? `${cabeca}\n\n${linhas.join("\n")}` : linhas.join("\n");
}

/** Sem acento, minúsculas, espaços colapsados e aparados. */
export function normalizarRotulo(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Número da opção escrito pelo contato: "2", "2)", "2.", "2 -", "opção 2",
 * "opcao 2", "op 2", "nº 2", "#2" (com espaços em volta). Fora disso, `null`.
 */
function numeroEscrito(normalizado: string): number | null {
  const m = /^(?:(?:opcao|opc|op|numero|n[oº°]?|#)\s*[.:]?\s*)?(\d{1,2})\s*[).:\-]?$/u.exec(normalizado);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * O id da opção que a resposta escolhe, ou `null` quando não dá para saber.
 *
 * Ordem: (1) `replyId` da resposta nativa, quando é de uma das opções; (2) o
 * número da opção (1 a N); (3) o rótulo normalizado, por igualdade exata.
 * Número fora da faixa, texto livre e rótulo no meio de uma frase dão `null`.
 */
export function casarRespostaComOpcao(
  resposta: { texto: string | null | undefined; replyId?: string | null },
  items: readonly { id: string; label: string }[],
): string | null {
  if (items.length === 0) return null;

  if (resposta.replyId) {
    const porId = items.find((i) => i.id === resposta.replyId);
    if (porId) return porId.id;
  }

  const normalizado = normalizarRotulo(resposta.texto ?? "");
  if (!normalizado) return null;

  const numero = numeroEscrito(normalizado);
  if (numero !== null) {
    return numero >= 1 && numero <= items.length ? items[numero - 1]!.id : null;
  }

  const porRotulo = items.filter((i) => normalizarRotulo(i.label) === normalizado);
  // Dois rótulos iguais depois de normalizar ("Sim" e "sim"): ambíguo, não casa.
  return porRotulo.length === 1 ? porRotulo[0]!.id : null;
}

/**
 * As opções NATIVAS gravadas numa linha de `messages`, para a conversa do
 * Inbox desenhar abaixo do texto. Texto numerado devolve `null`: as opções já
 * estão no próprio corpo, e repeti-las embaixo duplicaria a leitura.
 */
export function opcoesNativasDaMensagem(
  metadata: Record<string, unknown> | null | undefined,
): OutboundInteractive | null {
  const bruto = metadata?.interactive as Record<string, unknown> | undefined;
  if (!bruto || bruto.entrega !== "nativa") return null;
  const lido = interactiveSchema.safeParse(bruto);
  return lido.success ? lido.data : null;
}
