/**
 * As guardas da porta `/api/v1/custom-fields`: suporte em modo leitura não grava (antes do efeito),
 * papel abaixo de gerente não passa, corpo fora do schema é 422 — e nada disso chega ao núcleo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ suporte: null as Response | null, papel: null as Response | null }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => estado.suporte) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () =>
    estado.papel
      ? { ok: false, response: estado.papel }
      : { ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId: "org-da-sessao", role: "manager" } },
  ),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
const nucleo = vi.hoisted(() => ({ criar: vi.fn(async (deps: unknown, d: unknown) => ({ deps, d })), listar: vi.fn(async () => []) }));
vi.mock("@/lib/campos/administracao", () => ({ criarDefinicao: nucleo.criar, listarDefinicoes: nucleo.listar }));

import { NextRequest } from "next/server";

import { GET, POST } from "./route";

const post = (corpo: unknown) =>
  POST(new NextRequest("http://x/api/v1/custom-fields", { method: "POST", body: JSON.stringify(corpo) }));

beforeEach(() => {
  estado.suporte = null;
  estado.papel = null;
  nucleo.criar.mockClear();
});

describe("POST /api/v1/custom-fields", () => {
  it("suporte só-leitura é barrado ANTES do efeito", async () => {
    estado.suporte = new Response(null, { status: 403 });
    expect((await post({ entidade: "negocio", key: "x", label: "X", type: "text" })).status).toBe(403);
    expect(nucleo.criar).not.toHaveBeenCalled();
  });

  it("papel abaixo de gerente recebe a recusa do requireRole", async () => {
    estado.papel = new Response(null, { status: 403 });
    expect((await post({ entidade: "negocio", key: "x", label: "X", type: "text" })).status).toBe(403);
    expect(nucleo.criar).not.toHaveBeenCalled();
  });

  it("organization_id no corpo é 422 (strict) — a organização é SÓ a da sessão", async () => {
    const r = await post({ entidade: "negocio", key: "x", label: "X", type: "text", organization_id: "outra" });
    expect(r.status).toBe(422);
    expect(nucleo.criar).not.toHaveBeenCalled();
  });

  it("corpo válido cria com a organização da sessão (201)", async () => {
    const r = await post({ entidade: "contato", key: "cpf", label: "CPF", type: "text" });
    expect(r.status).toBe(201);
    expect((nucleo.criar.mock.calls[0]?.[0] as { organizationId: string }).organizationId).toBe("org-da-sessao");
  });
});

describe("GET /api/v1/custom-fields", () => {
  it("entidade fora da lista é 400", async () => {
    expect((await GET(new NextRequest("http://x/api/v1/custom-fields?entidade=lead"))).status).toBe(400);
  });
});
