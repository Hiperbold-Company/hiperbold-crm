/**
 * O `.or("...")` do PostgREST para os dublês de banco em memória.
 *
 * Cobre só o que o código usa hoje: termos `coluna.op.valor` com `gte`, `gt`,
 * `lte`, `lt`, `eq` e `is.null`, e o agrupamento `and(...)`. Operador fora disso
 * lança: um dublê que ignorasse o filtro deixaria o teste verde com ou sem ele.
 * Datas ISO comparam como texto, igual comparam em ordem.
 */
type Linha = Record<string, unknown>;

function partesNoTopo(expr: string): string[] {
  const partes: string[] = [];
  let nivel = 0;
  let atual = "";
  for (const ch of expr) {
    if (ch === "(") nivel++;
    if (ch === ")") nivel--;
    if (ch === "," && nivel === 0) {
      partes.push(atual);
      atual = "";
    } else {
      atual += ch;
    }
  }
  if (atual) partes.push(atual);
  return partes;
}

function termoAceita(linha: Linha, termo: string): boolean {
  if (termo.startsWith("and(") && termo.endsWith(")")) {
    return partesNoTopo(termo.slice(4, -1)).every((t) => termoAceita(linha, t));
  }
  const [coluna = "", op, ...resto] = termo.split(".");
  const valor = resto.join(".");
  const atual = linha[coluna] ?? null;
  if (op === "is" && valor === "null") return atual === null;
  if (atual === null) return false;
  const a = String(atual);
  switch (op) {
    case "gte": return a >= valor;
    case "gt": return a > valor;
    case "lte": return a <= valor;
    case "lt": return a < valor;
    case "eq": return a === valor;
    default: throw new Error(`operador não suportado no dublê: ${op}`);
  }
}

export function filtraOr<T extends Linha>(linhas: T[], expr: string): T[] {
  const termos = partesNoTopo(expr);
  return linhas.filter((l) => termos.some((t) => termoAceita(l, t)));
}
