/**
 * O identificador da versão que ESTE processo serve — o build id do Next.
 *
 * Por que o build id e não o `APP_VERSION` do health: `APP_VERSION` vem de um
 * ARG da imagem (número da release ou SHA curto) e vale `dev` em qualquer build
 * que não passe pelo CI — dois deploys seguidos com o mesmo valor são possíveis.
 * O build id é sorteado pelo `next build` a cada build (sem `generateBuildId` no
 * `next.config.ts`, o Next usa `nanoid`), gravado em `.next/BUILD_ID` e levado
 * para o `standalone` como arquivo obrigatório do servidor. Imagem nova = build
 * novo = id novo.
 *
 * Só servidor (lê disco). NUNCA lança: ausente ou ilegível (ex.: `next dev`)
 * devolve `null`, e quem compara trata `null` como "não sei" — o aviso de versão
 * nova só aparece com certeza de diferença.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let memo: { valor: string | null } | undefined;

export function identificadorDaVersao(): string | null {
  if (memo) return memo.valor;
  let valor: string | null = null;
  try {
    const lido = readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
    valor = lido.length > 0 && lido.length <= 200 ? lido : null;
  } catch {
    valor = null;
  }
  memo = { valor };
  return valor;
}

/** Só para teste: esquece o valor memorizado. */
export function esquecerIdentificadorDaVersao(): void {
  memo = undefined;
}
