import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { carregarOpcoesDeAbertura } from "@/lib/inbox/opcoes-de-abertura";
import { fail } from "@/lib/api/wrappers";

import { GET } from "./route";

/**
 * GET …/open-with-contact/opcoes — o que a rota decide: quem pode perguntar,
 * de QUAL organização a resposta sai (a da sessão, nunca da query) e que a
 * visibilidade vai junto (o cliente da sessão). A regra e o recorte por RLS
 * estão medidos em `lib/inbox/conexao-ao-abrir.test.ts`.
 */
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/inbox/opcoes-de-abertura", () => ({ carregarOpcoesDeAbertura: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ papel: "admin" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ papel: "sessao" }) }));

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA_ORG = "bbbbbbbb-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-3333-4000-8000-000000000003";
const CONTATO = "aaaaaaaa-5555-4000-8000-000000000009";

const mRole = vi.mocked(requireRole);
const mCarregar = vi.mocked(carregarOpcoesDeAbertura);

function pedido(qs: string) {
  return new NextRequest(`http://localhost/api/v1/conversations/open-with-contact/opcoes${qs}`);
}

function sessaoDe(role: "agent" | "viewer") {
  return {
    ok: true as const,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mCarregar.mockResolvedValue({ modo: "choose" } as never);
});

describe("GET opcoes", () => {
  it("viewer (abaixo de atendente) é recusado e nada é lido", async () => {
    mRole.mockResolvedValue({ ok: false, response: fail("forbidden", "x", 403) } as never);
    const res = await GET(pedido(`?contact_id=${CONTATO}`));
    expect(res.status).toBe(403);
    expect(mRole).toHaveBeenCalledWith("agent", expect.anything());
    expect(mCarregar).not.toHaveBeenCalled();
  });

  it("⭐ a organização é a da SESSÃO: um organization_id na query não muda nada", async () => {
    mRole.mockResolvedValue(sessaoDe("agent"));
    const res = await GET(pedido(`?contact_id=${CONTATO}&organization_id=${OUTRA_ORG}`));
    expect(res.status).toBe(200);
    expect(mCarregar).toHaveBeenCalledWith(
      expect.objectContaining({ papel: "admin" }),
      expect.objectContaining({ organizationId: ORG, userId: USER, role: "agent", contactId: CONTATO }),
    );
  });

  it("leva o cliente da sessão para o recorte de visibilidade", async () => {
    mRole.mockResolvedValue(sessaoDe("agent"));
    await GET(pedido(`?contact_id=${CONTATO}`));
    expect(mCarregar.mock.calls[0]?.[1]).toMatchObject({ sessao: { papel: "sessao" } });
  });

  it("só telefone: procura o contato pelo telefone", async () => {
    mRole.mockResolvedValue(sessaoDe("agent"));
    await GET(pedido(`?phone=%2B5581999999999`));
    expect(mCarregar.mock.calls[0]?.[1]).toMatchObject({ contactId: null, phone: "+5581999999999" });
  });

  it("id malformado → 422, sem leitura", async () => {
    mRole.mockResolvedValue(sessaoDe("agent"));
    const res = await GET(pedido(`?contact_id=nao-e-uuid`));
    expect(res.status).toBe(422);
    expect(mCarregar).not.toHaveBeenCalled();
  });
});
