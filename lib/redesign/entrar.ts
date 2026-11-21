import { useRedesign } from "@/lib/redesign/contexto";

/**
 * AS PEÇAS DAS TELAS DE ENTRADA QUE O REDESIGN PINTA.
 *
 * Entrar, criar conta, convite, recuperar senha, verificação em duas etapas e o
 * primeiro acesso (onboarding). Mesmo desenho de `lib/redesign/conexoes.ts`: com
 * a chave ligada cada peça ganha `data-rd-entrar="<peça>"`, e o bloco
 * `/* redesign: entrar *\/` de `app/globals.css` (todo ele sob
 * `[data-redesign="ligado"]`) a desenha como o protótipo v49. Desligada, o
 * valor é `undefined` e o React não escreve atributo nenhum: DOM idêntico.
 *
 * Só as CASCAS (layouts de servidor) são marcadas; formulários, campos e botões
 * são pintados por descendência a partir delas, sem tocar em handler, action,
 * validação ou Turnstile.
 *
 * Este arquivo NUNCA importa `lib/redesign/chave.ts` (server-only). O layout,
 * que é de servidor, lê `redesignLigado()` e passa o booleano a `marcaDeEntrar`.
 */
export type PecaDeEntrar =
  | "pagina"
  | "cartao"
  | "logo"
  | "cabecalho"
  | "conteudo"
  | "painel";

export type MarcaDeEntrar = (peca: PecaDeEntrar) => PecaDeEntrar | undefined;

/** A regra pura, usável em layout de servidor: ligada devolve a peça, desligada `undefined`. */
export function marcaDeEntrar(ligado: boolean): MarcaDeEntrar {
  return (peca) => (ligado ? peca : undefined);
}

export function useMarcaDeEntrar(): MarcaDeEntrar {
  return marcaDeEntrar(useRedesign());
}
