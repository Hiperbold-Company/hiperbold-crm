import { z } from "zod";

/**
 * OS PRODUTOS DE UM NEGÓCIO (`crm_lead_itens`, migration 0972).
 *
 * Um contrato só, lido pelas rotas E pela ficha do negócio. O valor do negócio
 * (`crm_leads.value_cents`) é a SOMA destes itens quando há algum — a regra mora
 * no banco (gatilho), e `somaDosItens` abaixo é o espelho dela para a tela
 * mostrar o total antes de a resposta chegar.
 */

/** Teto de uma quantidade e de um valor unitário: o mesmo dos CHECKs do banco. */
export const QUANTIDADE_MAXIMA_DO_ITEM = 1_000_000;
export const VALOR_UNITARIO_MAXIMO_CENTS = 100_000_000_000;

/** Quantos produtos cabem num negócio. Um teto de sanidade, não de plano (o banco também confere). */
export const MAXIMO_DE_ITENS_POR_NEGOCIO = 100;

/**
 * Teto do SUBTOTAL de uma linha, em centavos (CHECK `crm_lead_itens_subtotal_teto`). Com no máximo 100
 * itens por negócio a soma fica em 9e15, abaixo de `Number.MAX_SAFE_INTEGER` (9,007e15): a soma que a tela
 * faz em JavaScript nunca diverge da do banco. Quantidade e valor unitário isolados passariam de 1e17.
 */
export const SUBTOTAL_MAXIMO_CENTS = 90_000_000_000_000;

export const MENSAGEM_DO_TETO_DO_SUBTOTAL = "o total desta linha passa do limite permitido";

const quantidade = z
  .number()
  .positive("a quantidade precisa ser maior que zero")
  .max(QUANTIDADE_MAXIMA_DO_ITEM)
  // Até 3 casas: "1,5 hora". Mais que isso é digitação, não quantidade.
  .refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6, "no máximo 3 casas decimais");

const valorUnitario = z
  .number()
  .int()
  .min(0, "o valor não pode ser negativo")
  .max(VALOR_UNITARIO_MAXIMO_CENTS);

/**
 * Adicionar um produto do catálogo ao negócio.
 *
 * `valor_unitario_cents` é opcional só para produto de valor FIXO (a rota usa o
 * preço do catálogo). Para produto variável ele é obrigatório — a rota recusa
 * com 422, porque o valor do negócio não pode nascer de um número que ninguém
 * digitou.
 */
export const itemDoNegocioCreateSchema = z
  .object({
    product_id: z.uuid(),
    quantidade: quantidade.default(1),
    valor_unitario_cents: valorUnitario.optional(),
  })
  .refine(
    (v) => v.valor_unitario_cents === undefined || subtotalDoItem({ quantidade: v.quantidade, valor_unitario_cents: v.valor_unitario_cents }) <= SUBTOTAL_MAXIMO_CENTS,
    { path: ["valor_unitario_cents"], message: MENSAGEM_DO_TETO_DO_SUBTOTAL },
  );

/** Alterar quantidade e/ou valor unitário. O produto de um item não muda: remove-se e adiciona-se outro. */
export const itemDoNegocioPatchSchema = z
  .object({
    quantidade: quantidade.optional(),
    valor_unitario_cents: valorUnitario.optional(),
  })
  .refine((v) => v.quantidade !== undefined || v.valor_unitario_cents !== undefined, "nada para alterar")
  // Com os dois no corpo dá para conferir aqui; com um só, quem confere é o CHECK do banco (a rota o traduz em 422).
  .refine(
    (v) =>
      v.quantidade === undefined ||
      v.valor_unitario_cents === undefined ||
      subtotalDoItem({ quantidade: v.quantidade, valor_unitario_cents: v.valor_unitario_cents }) <= SUBTOTAL_MAXIMO_CENTS,
    { path: ["valor_unitario_cents"], message: MENSAGEM_DO_TETO_DO_SUBTOTAL },
  );

export type ItemDoNegocioCreate = z.infer<typeof itemDoNegocioCreateSchema>;
export type ItemDoNegocioPatch = z.infer<typeof itemDoNegocioPatchSchema>;

/** O item como a rota o devolve e a ficha o lê. */
export interface ItemDoNegocio {
  id: string;
  lead_id: string;
  product_id: string | null;
  nome_snapshot: string;
  quantidade: number;
  valor_unitario_cents: number;
  created_at: string;
  updated_at: string;
}

/** As colunas que a rota lê e devolve — uma lista, não duas. */
export const COLUNAS_DO_ITEM_DO_NEGOCIO =
  "id, lead_id, product_id, nome_snapshot, quantidade, valor_unitario_cents, created_at, updated_at";

/**
 * O subtotal de UMA linha, em centavos inteiros. É o mesmo `round(quantidade *
 * valor_unitario_cents)` do gatilho do banco: a soma dos subtotais que a tela
 * mostra TEM de ser o valor que o banco guarda no negócio.
 */
export function subtotalDoItem(item: Pick<ItemDoNegocio, "quantidade" | "valor_unitario_cents">): number {
  // Aritmética inteira (milésimos × centavos, em BigInt): `0.001 * 500` em ponto
  // flutuante pode cair em 0,4999… e arredondar diferente do `numeric` do banco.
  const milesimos = BigInt(Math.round(item.quantidade * 1000));
  const bruto = milesimos * BigInt(item.valor_unitario_cents);
  return Number((bruto + 500n) / 1000n);
}

/** A soma dos subtotais — o valor do negócio quando ele tem itens. */
export function somaDosItens(itens: ReadonlyArray<Pick<ItemDoNegocio, "quantidade" | "valor_unitario_cents">>): number {
  return itens.reduce((acc, i) => acc + subtotalDoItem(i), 0);
}
