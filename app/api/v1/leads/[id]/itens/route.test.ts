import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import {
  clienteDeItens,
  criarBancoDeItens,
  type BancoDeItens,
} from "@/tests/unit/helpers/banco-de-itens-em-memoria";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));

const USER = "11111111-1111-4111-8111-111111111111";
const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";
const LEAD_A = "44444444-4444-4444-8444-444444444444";
const LEAD_A2 = "44444444-4444-4444-8444-444444444445";
const LEAD_B = "55555555-5555-4555-8555-555555555555";
const P_FIXO = "66666666-6666-4666-8666-666666666661";
const P_VARIAVEL = "66666666-6666-4666-8666-666666666662";
const P_INATIVO = "66666666-6666-4666-8666-666666666663";
const P_DA_OUTRA_ORG = "66666666-6666-4666-8666-666666666664";
const P_CARO = "66666666-6666-4666-8666-666666666665";

let banco: BancoDeItens;

function umBanco(): BancoDeItens {
  return criarBancoDeItens({
    crm_leads: [
      { id: LEAD_A, organization_id: ORG_A, contact_id: null, value_cents: null },
      { id: LEAD_A2, organization_id: ORG_A, contact_id: null, value_cents: null },
      { id: LEAD_B, organization_id: ORG_B, contact_id: null, value_cents: null },
    ],
    catalog_products: [
      { id: P_FIXO, organization_id: ORG_A, nome: "Consulta", ativo: true, tipo_de_preco: "fixo", preco_cents: 15000, moeda: "BRL" },
      { id: P_VARIAVEL, organization_id: ORG_A, nome: "Projeto sob medida", ativo: true, tipo_de_preco: "variavel", preco_cents: null, moeda: "BRL" },
      { id: P_INATIVO, organization_id: ORG_A, nome: "Antigo", ativo: false, tipo_de_preco: "fixo", preco_cents: 100, moeda: "BRL" },
      { id: P_CARO, organization_id: ORG_A, nome: "Caríssimo", ativo: true, tipo_de_preco: "fixo", preco_cents: 100000000000, moeda: "BRL" },
      { id: P_DA_OUTRA_ORG, organization_id: ORG_B, nome: "Do vizinho", ativo: true, tipo_de_preco: "fixo", preco_cents: 999, moeda: "BRL" },
    ],
    crm_lead_itens: [],
    crm_lead_activities: [],
  });
}

function pedido(metodo: string, corpo?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/leads/x/itens", {
    method: metodo,
    ...(corpo === undefined
      ? {}
      : { body: JSON.stringify(corpo), headers: { "content-type": "application/json" } }),
  });
}

const ctxLead = (id: string) => ({ params: Promise.resolve({ id }) });
const ctxItem = (id: string, itemId: string) => ({ params: Promise.resolve({ id, itemId }) });

beforeEach(() => {
  vi.clearAllMocks();
  banco = umBanco();
  vi.mocked(createClient).mockResolvedValue(clienteDeItens(banco));
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG_A },
  } as never);
});

describe("POST /api/v1/leads/:id/itens", () => {
  it("produto de valor FIXO entra com o preço do catálogo, o nome copiado e a organização da sessão", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      // `organization_id` no corpo é descartado: corpo não decide escopo.
      pedido("POST", { product_id: P_FIXO, quantidade: 2, organization_id: ORG_B }),
      ctxLead(LEAD_A),
    );

    expect(res.status).toBe(201);
    expect(banco.inseridos["crm_lead_itens"]).toHaveLength(1);
    expect(banco.inseridos["crm_lead_itens"]![0]).toMatchObject({
      organization_id: ORG_A,
      lead_id: LEAD_A,
      product_id: P_FIXO,
      nome_snapshot: "Consulta",
      quantidade: 2,
      valor_unitario_cents: 15000,
    });
    expect(requireRole).toHaveBeenCalledWith("agent", expect.anything());
  });

  it("produto de valor FIXO aceita o valor editado pelo atendente", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      pedido("POST", { product_id: P_FIXO, valor_unitario_cents: 12000 }),
      ctxLead(LEAD_A),
    );
    expect(res.status).toBe(201);
    expect(banco.inseridos["crm_lead_itens"]![0]).toMatchObject({ valor_unitario_cents: 12000, quantidade: 1 });
  });

  it("produto de valor VARIÁVEL sem valor é recusado e nada é gravado", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", { product_id: P_VARIAVEL }), ctxLead(LEAD_A));

    expect(res.status).toBe(422);
    expect(banco.inseridos["crm_lead_itens"]).toBeUndefined();
    expect(banco.inseridos["crm_lead_activities"]).toBeUndefined();
  });

  it("produto de valor VARIÁVEL entra com o valor que o atendente digitou", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      pedido("POST", { product_id: P_VARIAVEL, valor_unitario_cents: 480000 }),
      ctxLead(LEAD_A),
    );
    expect(res.status).toBe(201);
    expect(banco.inseridos["crm_lead_itens"]![0]).toMatchObject({
      nome_snapshot: "Projeto sob medida",
      valor_unitario_cents: 480000,
    });
  });

  it("registra 'Produto adicionado' na linha do tempo (sem o valor em dinheiro) e audita", async () => {
    const { POST } = await import("./route");
    await POST(pedido("POST", { product_id: P_FIXO, quantidade: 2 }), ctxLead(LEAD_A));

    const atividade = banco.inseridos["crm_lead_activities"]?.[0];
    expect(atividade).toMatchObject({
      organization_id: ORG_A,
      lead_id: LEAD_A,
      type: "lead_product_added",
      performed_by_user_id: USER,
    });
    expect(String(atividade!.reason)).toBe("Adicionou 2 × Consulta");
    expect(String(atividade!.reason)).not.toMatch(/\d{2,}[.,]\d{2}|R\$/);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "lead.product_added", organizationId: ORG_A, resourceId: LEAD_A }),
    );
  });

  it("produto de OUTRA organização é 404 — e nada é gravado", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", { product_id: P_DA_OUTRA_ORG }), ctxLead(LEAD_A));

    expect(res.status).toBe(404);
    expect(banco.inseridos["crm_lead_itens"]).toBeUndefined();
  });

  it("negócio de OUTRA organização é 404 — e nada é gravado", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", { product_id: P_FIXO }), ctxLead(LEAD_B));

    expect(res.status).toBe(404);
    expect(banco.inseridos["crm_lead_itens"]).toBeUndefined();
  });

  it("produto desativado no catálogo não entra no negócio", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", { product_id: P_INATIVO }), ctxLead(LEAD_A));
    expect(res.status).toBe(422);
    expect(banco.inseridos["crm_lead_itens"]).toBeUndefined();
  });

  it.each([{ quantidade: 0 }, { quantidade: -1 }, { quantidade: 1.0001 }, { valor_unitario_cents: -5 }])(
    "recusa corpo inválido %j",
    async (extra) => {
      const { POST } = await import("./route");
      const res = await POST(pedido("POST", { product_id: P_FIXO, ...extra }), ctxLead(LEAD_A));
      expect(res.status).toBe(422);
      expect(banco.inseridos["crm_lead_itens"]).toBeUndefined();
    },
  );

  it("o subtotal acima do teto (9e13 centavos) é 422 — com o preço do catálogo ou com o valor do corpo", async () => {
    const { POST } = await import("./route");
    // 901 × 1e11 = 9,01e13 > 9e13, preço vindo do catálogo (não passa pelo Zod).
    const doCatalogo = await POST(pedido("POST", { product_id: P_CARO, quantidade: 901 }), ctxLead(LEAD_A));
    expect(doCatalogo.status).toBe(422);
    // O mesmo, com o valor no corpo (o Zod recusa).
    const doCorpo = await POST(
      pedido("POST", { product_id: P_FIXO, quantidade: 901, valor_unitario_cents: 100000000000 }),
      ctxLead(LEAD_A),
    );
    expect(doCorpo.status).toBe(422);
    expect(banco.inseridos["crm_lead_itens"]).toBeUndefined();

    // No teto exato passa.
    const noTeto = await POST(pedido("POST", { product_id: P_CARO, quantidade: 900 }), ctxLead(LEAD_A));
    expect(noTeto.status).toBe(201);
  });

  it("id de negócio que não é UUID é 404, não 500", async () => {
    const { POST } = await import("./route");
    const res = await POST(pedido("POST", { product_id: P_FIXO }), ctxLead("nao-e-uuid"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/leads/:id/itens", () => {
  it("lista só os itens da organização da sessão", async () => {
    banco.tabelas["crm_lead_itens"] = [
      { id: "i1", organization_id: ORG_A, lead_id: LEAD_A, nome_snapshot: "Consulta", quantidade: 1, valor_unitario_cents: 100 },
      // Mesmo lead_id, outra organização: uma consulta sem `organization_id` o traria.
      { id: "i2", organization_id: ORG_B, lead_id: LEAD_A, nome_snapshot: "Vazado", quantidade: 1, valor_unitario_cents: 100 },
    ];
    const { GET } = await import("./route");
    const res = await GET(pedido("GET"), ctxLead(LEAD_A));
    const corpo = (await res.json()) as { data: Array<{ id: string }> };

    expect(res.status).toBe(200);
    expect(corpo.data.map((i) => i.id)).toEqual(["i1"]);
    expect(requireRole).toHaveBeenCalledWith("viewer", expect.anything());
  });
});

describe("PATCH e DELETE /api/v1/leads/:id/itens/:itemId", () => {
  const ITEM_A = "77777777-7777-4777-8777-777777777771";
  const ITEM_DO_OUTRO_LEAD = "77777777-7777-4777-8777-777777777772";
  const ITEM_B = "77777777-7777-4777-8777-777777777773";

  beforeEach(() => {
    banco.tabelas["crm_lead_itens"] = [
      { id: ITEM_A, organization_id: ORG_A, lead_id: LEAD_A, product_id: P_FIXO, nome_snapshot: "Consulta", quantidade: 1, valor_unitario_cents: 15000 },
      { id: ITEM_DO_OUTRO_LEAD, organization_id: ORG_A, lead_id: LEAD_A2, product_id: P_FIXO, nome_snapshot: "Consulta", quantidade: 1, valor_unitario_cents: 15000 },
      { id: ITEM_B, organization_id: ORG_B, lead_id: LEAD_B, product_id: P_DA_OUTRA_ORG, nome_snapshot: "Do vizinho", quantidade: 1, valor_unitario_cents: 999 },
    ];
  });

  it("PATCH altera quantidade e valor do item", async () => {
    const { PATCH } = await import("./[itemId]/route");
    const res = await PATCH(
      pedido("PATCH", { quantidade: 3, valor_unitario_cents: 14000 }),
      ctxItem(LEAD_A, ITEM_A),
    );
    expect(res.status).toBe(200);
    expect(banco.tabelas["crm_lead_itens"]![0]).toMatchObject({ quantidade: 3, valor_unitario_cents: 14000 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "lead.product_updated" }));
  });

  it("PATCH de item de OUTRA organização é 404 e não altera nada", async () => {
    const { PATCH } = await import("./[itemId]/route");
    const res = await PATCH(pedido("PATCH", { quantidade: 99 }), ctxItem(LEAD_B, ITEM_B));
    expect(res.status).toBe(404);
    expect(banco.tabelas["crm_lead_itens"]![2]).toMatchObject({ quantidade: 1 });
  });

  it("PATCH com o id de item de OUTRO negócio da mesma organização é 404", async () => {
    const { PATCH } = await import("./[itemId]/route");
    const res = await PATCH(pedido("PATCH", { quantidade: 99 }), ctxItem(LEAD_A, ITEM_DO_OUTRO_LEAD));
    expect(res.status).toBe(404);
    expect(banco.tabelas["crm_lead_itens"]![1]).toMatchObject({ quantidade: 1 });
  });

  it("PATCH sem nada para alterar é 422", async () => {
    const { PATCH } = await import("./[itemId]/route");
    const res = await PATCH(pedido("PATCH", {}), ctxItem(LEAD_A, ITEM_A));
    expect(res.status).toBe(422);
  });

  it("DELETE tira o produto, registra 'Produto removido' e audita", async () => {
    const { DELETE } = await import("./[itemId]/route");
    const res = await DELETE(pedido("DELETE"), ctxItem(LEAD_A, ITEM_A));

    expect(res.status).toBe(200);
    expect(banco.tabelas["crm_lead_itens"]!.map((i) => i.id)).not.toContain(ITEM_A);
    expect(banco.inseridos["crm_lead_activities"]?.[0]).toMatchObject({
      type: "lead_product_removed",
      lead_id: LEAD_A,
      organization_id: ORG_A,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "lead.product_removed", resourceId: LEAD_A }),
    );
  });

  it("DELETE de item de OUTRA organização é 404: o item continua e nada é auditado", async () => {
    const { DELETE } = await import("./[itemId]/route");
    const res = await DELETE(pedido("DELETE"), ctxItem(LEAD_B, ITEM_B));

    expect(res.status).toBe(404);
    expect(banco.tabelas["crm_lead_itens"]!.map((i) => i.id)).toContain(ITEM_B);
    expect(audit).not.toHaveBeenCalled();
    expect(banco.inseridos["crm_lead_activities"]).toBeUndefined();
  });
});
