/**
 * O QUADRO: organização do funil e o recorte de cargo/empresa do cartão ("Editar cartão").
 *
 * Exercita a ROTA com o dublê que aplica os filtros (`stages-db-double`):
 *  1. funil de OUTRA organização do mesmo usuário responde 404 — o papel aplicado é o da
 *     organização ativa, e sem essa conferência o quadro de B sairia recortado como admin de A;
 *  2. a chave restrita declarada em OUTRO funil da organização recorta o cargo do contato para
 *     quem não é administrador (as chaves vêm da organização, não só do funil lido).
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" })),
}));

import { createClient } from "@/lib/supabase/server";
import { OUTRA_ORG, PIPE, authOk, funilRow, makeDb, negocio } from "@/tests/helpers/stages-db-double";

const CONTATO = "66666666-6666-4666-8666-666666666666";

function db(opts: { orgDoFunil?: string; outroFunilRestringe?: boolean; chavesFalham?: boolean } = {}) {
  const registro = comContato({
    pipelines: [
      funilRow({
        id: PIPE,
        name: "Pedidos",
        ...(opts.orgDoFunil ? { organization_id: opts.orgDoFunil } : {}),
        settings: { card_lines: ["cargo", "empresa", "telefone"] },
      } as never),
      funilRow({
        id: "outro-funil",
        name: "Outro",
        settings: {
          fields: opts.outroFunilRestringe ? [{ key: "cargo", label: "Cargo", type: "text", publico: false }] : [],
        },
      } as never),
    ],
    leads: [negocio("l1", "e1", { contact_id: CONTATO, status: "open", position_in_stage: 1 } as never)],
    contacts: [
      {
        id: CONTATO,
        organization_id: "22222222-2222-4222-8222-222222222222",
        tags: [],
        phone_number: "+5511999998888",
        email: null,
        custom_fields: { cargo: "Diretora", empresa: "Loja Azul" },
        is_anonymized: false,
      },
    ],
  });
  // O dublê não implementa `.not()` (a etapa da próxima ação o usa quando há contato). Aqui ele
  // é neutro: a próxima ação não é o que este arquivo mede.
  const de = registro.client.from as (t: string) => Record<string, unknown>;
  const client = {
    ...registro.client,
    from: (t: string) => {
      if (opts.chavesFalham && t === "custom_field_definitions") {
        const falha: Record<string, unknown> = {
          select: () => falha,
          eq: () => falha,
          then: (r: (v: unknown) => unknown) => r({ data: null, error: { message: "fora do ar" } }),
        };
        return falha;
      }
      const b = de(t);
      if (!b.not) b.not = () => b;
      return b;
    },
  };
  vi.mocked(createClient).mockResolvedValue(client as never);
  return registro;
}

const comContato = makeDb;

async function lerQuadro(role: "manager" | "admin") {
  authOk(role);
  const { GET } = await import("./route");
  const res = await GET(new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/board`), {
    params: Promise.resolve({ id: PIPE }),
  });
  const body = (await res.json()) as { data?: { leads: Array<Record<string, unknown>> } };
  return { status: res.status, lead: body.data?.leads[0] };
}

describe("GET /board — organização do funil", () => {
  it("⭐ funil de OUTRA organização (de que o usuário também é membro) responde 404", async () => {
    db({ orgDoFunil: OUTRA_ORG });
    const { status, lead } = await lerQuadro("admin");
    expect(status).toBe(404);
    expect(lead).toBeUndefined();
  });

  it("controle: funil da organização ativa abre", async () => {
    db();
    expect((await lerQuadro("manager")).status).toBe(200);
  });
});

describe("GET /board — cargo e empresa do cartão", () => {
  it("sem restrição: o gerente recebe cargo e empresa do contato", async () => {
    db();
    const { lead } = await lerQuadro("manager");
    expect(lead).toMatchObject({ contact_cargo: "Diretora", contact_empresa: "Loja Azul" });
  });

  it("⭐ chave `cargo` restrita em OUTRO funil: o gerente não recebe o cargo", async () => {
    db({ outroFunilRestringe: true });
    const { status, lead } = await lerQuadro("manager");
    expect(status).toBe(200);
    expect(lead).not.toHaveProperty("contact_cargo");
    expect(lead).toMatchObject({ contact_empresa: "Loja Azul" });
  });

  it("⭐ chaves restritas ilegíveis: 500 (fail-closed), nunca o cargo sem recorte", async () => {
    db({ chavesFalham: true });
    const { status, lead } = await lerQuadro("manager");
    expect(status).toBe(500);
    expect(lead).toBeUndefined();
  });

  it("…e o administrador recebe", async () => {
    db({ outroFunilRestringe: true });
    const { lead } = await lerQuadro("admin");
    expect(lead).toMatchObject({ contact_cargo: "Diretora" });
  });
});
