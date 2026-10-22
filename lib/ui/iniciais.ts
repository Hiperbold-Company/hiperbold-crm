/**
 * AS INICIAIS DE UM NOME, NUM LUGAR SÓ — por letra, nunca por unidade UTF-16.
 *
 * Cada avatar do app montava as suas com `slice(0, 2)` ou `[0]`, que cortam por
 * unidade UTF-16. Um emoji ocupa duas: "Rejeane 🧡" virava "R" + metade do
 * coração, e o círculo mostrava "R�". Aqui a inicial é o primeiro GRAFEMA de cada
 * palavra que seja letra ou número (Unicode, `\p{L}\p{N}`, com os acentos que o
 * acompanham): emoji, símbolo e pontuação nunca viram inicial.
 *
 * Regra: primeira + última palavra ("Maria da Silva" → "MS"). Palavra única dá
 * uma letra (`palavraUnica: 1`, o padrão) ou as duas primeiras (`2`, o badge do
 * responsável no quadro). Nome sem nenhuma letra ("🧡🧡") devolve `null`: quem
 * chama decide o fallback que já tinha ("?", telefone, e-mail).
 */

const segmentador: Intl.Segmenter | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function grafemas(texto: string): string[] {
  if (segmentador) return Array.from(segmentador.segment(texto), (s) => s.segment);
  return Array.from(texto);
}

/** Letra ou número, com as marcas que a acompanham ("É" decomposto inclusive). */
const LETRA = /^[\p{L}\p{N}]\p{M}*$/u;
/** Seletor de variação e moldura de tecla: "1️⃣" começa por número e é emoji. */
const EMOJI = /[️⃣]/u;

function ehLetra(g: string): boolean {
  return LETRA.test(g) && !EMOJI.test(g);
}

/** As letras de uma palavra, na ordem, ignorando o que não é letra nem número. */
function letrasDa(palavra: string): string[] {
  return grafemas(palavra).filter(ehLetra);
}

export function iniciaisDoNome(
  nome: string | null | undefined,
  opcoes: { palavraUnica?: 1 | 2 } = {},
): string | null {
  const palavras = (nome ?? "")
    .trim()
    .split(/\s+/)
    .map(letrasDa)
    .filter((letras) => letras.length > 0);
  const primeira = palavras[0];
  if (!primeira) return null;
  const ultima = palavras[palavras.length - 1];
  if (palavras.length === 1 || !ultima) {
    return primeira.slice(0, opcoes.palavraUnica ?? 1).join("").toUpperCase();
  }
  return `${primeira[0]}${ultima[0]}`.toUpperCase();
}

/** Uma letra só (o círculo pequeno da chamada de voz). */
export function inicialDoNome(nome: string | null | undefined): string | null {
  const iniciais = iniciaisDoNome(nome);
  return iniciais ? (grafemas(iniciais)[0] ?? null) : null;
}
