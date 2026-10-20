import { describe, expect, it } from "vitest";

import { crmSearchProducts } from "./comercio";
import type { McpContext } from "../types";

/**
 * PRODUTO DE VALOR VARIÁVEL: o agente de IA NÃO cita preço (migration 0972).
 *
 * O valor desse produto é definido pelo atendente dentro de cada negócio. Se a
 * ferramenta devolvesse um número, o agente o diria ao cliente — promessa que a
 * loja teria de cumprir ou desfazer.
 */

function ctxCom(produtos: Array<Record<string, unknown>>): McpContext {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    range: async () => ({ data: produtos, error: null, count: produtos.length }),
  };
  return {
    organizationId: "22222222-2222-4222-8222-222222222222",
    role: "agent",
    actor: { type: "ai_agent", id: "run-1", agent_id: "agent-1" },
    apiTokenId: "33333333-3333-4333-8333-333333333333",
    requestId: "44444444-4444-4444-8444-444444444444",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from: () => query } as any,
  } as McpContext;
}

const BASE = {
  descricao: null,
  marca: null,
  categoria: null,
  moeda: "BRL",
  controla_estoque: false,
  quantidade: 0,
  ativo: true,
};
const VARIAVEL = {
  ...BASE,
  id: "11111111-1111-4111-8111-111111111112",
  codigo: "SRV1",
  nome: "Projeto sob medida",
  tipo_de_preco: "variavel",
  preco_cents: null,
};
const FIXO = {
  ...BASE,
  id: "11111111-1111-4111-8111-111111111111",
  codigo: "IP15",
  nome: "iPhone 15",
  tipo_de_preco: "fixo",
  preco_cents: 24990,
};

interface Resposta {
  produtos: Array<Record<string, unknown>>;
  mensagem?: string;
}

const buscar = (termo: string, produtos: Array<Record<string, unknown>>) =>
  crmSearchProducts.handler(
    { termo, limite: 8, somente_disponiveis: true },
    ctxCom(produtos),
  ) as Promise<Resposta>;

describe("crm_search_products — valor variável", () => {
  it("não devolve preco nem preco_cents e diz que o valor é definido no atendimento", async () => {
    const r = await buscar("projeto", [VARIAVEL]);

    expect(r.produtos).toHaveLength(1);
    const p = r.produtos[0]!;
    expect(p).not.toHaveProperty("preco");
    expect(p).not.toHaveProperty("preco_cents");
    expect(p).toMatchObject({ codigo: "SRV1", valor_variavel: true, valor: "definido no atendimento" });
    expect(r.mensagem).toContain("NÃO cite preço");
  });

  it("mesmo com um número gravado por fora no preço de um produto variável, o agente não o cita", async () => {
    const r = await buscar("projeto", [{ ...VARIAVEL, preco_cents: 123456 }]);

    expect(JSON.stringify(r)).not.toContain("123456");
    expect(JSON.stringify(r)).not.toMatch(/1\.234,56/);
  });

  it("o produto de valor fixo continua cotado e sem o aviso", async () => {
    const r = await buscar("iphone", [FIXO]);

    expect(r.produtos[0]).toMatchObject({ preco_cents: 24990 });
    expect(r.produtos[0]).not.toHaveProperty("valor_variavel");
    expect(r.mensagem ?? "").not.toContain("NÃO cite preço");
  });

  it("a descrição da ferramenta ensina o agente a não cotar o variável", () => {
    expect(crmSearchProducts.description).toContain("valor_variavel");
  });
});
