import { describe, expect, it } from "vitest";

import { precoDoCatalogoParaValorDoNegocio } from "@/lib/money";
import {
  SUBTOTAL_MAXIMO_CENTS,
  itemDoNegocioCreateSchema,
  itemDoNegocioPatchSchema,
  somaDosItens,
  subtotalDoItem,
} from "@/lib/schemas/lead-itens";
import { produtoCreateSchema, produtoPatchSchema } from "@/lib/schemas/produtos";

const BASE = { codigo: "SRV1", nome: "Projeto sob medida" };

describe("produtoCreateSchema — valor fixo ou variável", () => {
  it("sem tipo, o produto é de valor fixo e exige preço", () => {
    expect(produtoCreateSchema.safeParse(BASE).success).toBe(false);
    const ok = produtoCreateSchema.safeParse({ ...BASE, preco_cents: 15000 });
    expect(ok.success).toBe(true);
    expect(ok.data).toMatchObject({ tipo_de_preco: "fixo", preco_cents: 15000 });
  });

  it("valor variável não precisa de preço e grava preço nulo", () => {
    const r = produtoCreateSchema.safeParse({ ...BASE, tipo_de_preco: "variavel" });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ tipo_de_preco: "variavel", preco_cents: null });
  });

  it("valor variável descarta o preço que vier no corpo", () => {
    const r = produtoCreateSchema.safeParse({ ...BASE, tipo_de_preco: "variavel", preco_cents: 999 });
    expect(r.data).toMatchObject({ preco_cents: null });
  });

  it("recusa tipo fora do vocabulário", () => {
    expect(produtoCreateSchema.safeParse({ ...BASE, tipo_de_preco: "gratis", preco_cents: 1 }).success).toBe(false);
  });
});

describe("produtoPatchSchema", () => {
  it("não injeta o tipo nem o preço quando o PATCH não os menciona", () => {
    const r = produtoPatchSchema.safeParse({ nome: "Novo nome" });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty("tipo_de_preco");
    expect(r.data).not.toHaveProperty("preco_cents");
  });

  it("trocar para variável apaga o preço de tabela", () => {
    const r = produtoPatchSchema.safeParse({ tipo_de_preco: "variavel" });
    expect(r.data).toMatchObject({ tipo_de_preco: "variavel", preco_cents: null });
  });

  it("trocar para fixo exige o preço junto", () => {
    expect(produtoPatchSchema.safeParse({ tipo_de_preco: "fixo" }).success).toBe(false);
    expect(produtoPatchSchema.safeParse({ tipo_de_preco: "fixo", preco_cents: 500 }).success).toBe(true);
  });
});

describe("itens do negócio — contrato", () => {
  const ID = "66666666-6666-4666-8666-666666666661";

  it("quantidade padrão é 1 e o valor unitário é opcional (fixo usa o do catálogo)", () => {
    expect(itemDoNegocioCreateSchema.parse({ product_id: ID })).toEqual({ product_id: ID, quantidade: 1 });
  });

  it.each([0, -2, 1_000_001, 1.0001])("recusa quantidade %s", (q) => {
    expect(itemDoNegocioCreateSchema.safeParse({ product_id: ID, quantidade: q }).success).toBe(false);
  });

  it("aceita quantidade fracionada com até 3 casas", () => {
    expect(itemDoNegocioCreateSchema.safeParse({ product_id: ID, quantidade: 1.5 }).success).toBe(true);
  });

  it("recusa valor negativo ou fracionado em centavos", () => {
    expect(itemDoNegocioCreateSchema.safeParse({ product_id: ID, valor_unitario_cents: -1 }).success).toBe(false);
    expect(itemDoNegocioCreateSchema.safeParse({ product_id: ID, valor_unitario_cents: 10.5 }).success).toBe(false);
  });

  it("teto do subtotal da linha: 9e13 centavos passa, acima é recusado (create e patch com os dois campos)", () => {
    expect(SUBTOTAL_MAXIMO_CENTS * 100).toBeLessThan(Number.MAX_SAFE_INTEGER);
    const noTeto = { quantidade: 900, valor_unitario_cents: 100_000_000_000 };
    const acima = { quantidade: 901, valor_unitario_cents: 100_000_000_000 };
    expect(itemDoNegocioCreateSchema.safeParse({ product_id: ID, ...noTeto }).success).toBe(true);
    expect(itemDoNegocioCreateSchema.safeParse({ product_id: ID, ...acima }).success).toBe(false);
    expect(itemDoNegocioPatchSchema.safeParse(noTeto).success).toBe(true);
    expect(itemDoNegocioPatchSchema.safeParse(acima).success).toBe(false);
  });

  it("PATCH exige ao menos um campo", () => {
    expect(itemDoNegocioPatchSchema.safeParse({}).success).toBe(false);
    expect(itemDoNegocioPatchSchema.safeParse({ quantidade: 2 }).success).toBe(true);
  });
});

describe("a soma dos itens — o valor do negócio", () => {
  it("soma quantidade × valor unitário de cada linha", () => {
    // 2 × R$ 150,00 + 1 × R$ 4.800,00 = R$ 5.100,00
    expect(
      somaDosItens([
        { quantidade: 2, valor_unitario_cents: 15000 },
        { quantidade: 1, valor_unitario_cents: 480000 },
      ]),
    ).toBe(510000);
  });

  it("arredonda por linha, como o gatilho do banco: a soma dos subtotais mostrados é o total", () => {
    // 1,5 × R$ 3,33 = 499,5 centavos -> 500; duas linhas iguais somam 1000, não 999.
    const linha = { quantidade: 1.5, valor_unitario_cents: 333 };
    expect(subtotalDoItem(linha)).toBe(500);
    expect(somaDosItens([linha, linha])).toBe(1000);
  });

  it("não perde centavo em ponto flutuante (0,001 × 500 = 0,5 -> 1)", () => {
    expect(subtotalDoItem({ quantidade: 0.001, valor_unitario_cents: 500 })).toBe(1);
  });

  it("sem itens, soma zero", () => {
    expect(somaDosItens([])).toBe(0);
  });
});

describe("preço do catálogo na régua do negócio", () => {
  it("em moeda de duas casas é o mesmo número", () => {
    expect(precoDoCatalogoParaValorDoNegocio(15000, "BRL")).toBe(15000);
  });
  it("em moeda sem centavos o negócio guarda ×100", () => {
    expect(precoDoCatalogoParaValorDoNegocio(125000, "PYG")).toBe(12500000);
  });
});
