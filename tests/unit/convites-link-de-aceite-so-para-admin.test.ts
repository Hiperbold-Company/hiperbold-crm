/**
 * Auditoria de 17/10/2026, achado baixo 6: `GET /api/v1/team/invites` (piso de
 * gerente) devolvia o `accept_url` de todo convite em aberto a qualquer sessão que
 * lesse a lista. O link é uma credencial de entrada na organização: quem o tem
 * aceita o convite com o papel que ele carrega. Agora só a SESSÃO de um ADMIN o
 * recebe; o gerente vê o convite sem o link, e o token de servidor também não.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { validateBearerToken } from "@/lib/mcp/auth";
import type { Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mcp/auth")>();
  return { ...real, validateBearerToken: vi.fn() };
});

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const futuro = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
const passado = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

function convite(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: ORG,
    email: `${id}@example.com`,
    role: "agent",
    interface_settings: {},
    invited_by: USER,
    inviter_name: "Alguém",
    email_dispatched: true,
    created_at: passado,
    last_sent_at: passado,
    resend_count: 0,
    expires_at: futuro,
    accepted_at: null,
    revoked_at: null,
    ...extra,
  };
}

const LINHAS = [
  convite("aberto"),
  convite("aceito", { accepted_at: passado }),
  convite("revogado", { revoked_at: passado }),
];

function bancoDeConvites() {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) chain[m] = () => chain;
  chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: LINHAS, error: null }).then(ok);
  return { from: () => chain };
}

function comoSessao(papel: Role) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: papel },
  } as never);
  vi.mocked(createClient).mockResolvedValue(bancoDeConvites() as never);
}

function comoToken() {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG,
    role: "admin",
    actor: { type: "api_token", id: TOKEN_ID, role: "admin" },
    apiTokenId: TOKEN_ID,
    scopes: ["mcp:read", "role:admin"],
    createdBy: USER,
  });
  vi.mocked(createAdminClient).mockReturnValue(bancoDeConvites() as never);
}

async function lista(bearer: boolean) {
  const { GET } = await import("@/app/api/v1/team/invites/route");
  const res = await GET(
    new NextRequest("http://localhost/api/v1/team/invites", {
      headers: bearer ? { authorization: "Bearer dsk_teste_segredo" } : {},
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Array<{ id: string; status: string; accept_url: string | null }> }).data;
}

beforeEach(() => vi.clearAllMocks());

describe("accept_url na lista de convites", () => {
  it("⭐ sessão de ADMIN recebe o link do convite em aberto (controle positivo)", async () => {
    comoSessao("admin");
    const dados = await lista(false);

    const aberto = dados.find((c) => c.id === "aberto");
    expect(aberto?.accept_url, "o admin deixou de receber o link: os casos abaixo seriam vacuidade").toMatch(
      /\/team\/accept-invite\/.+/,
    );
    // Convite já aceito ou revogado nunca leva link.
    expect(dados.find((c) => c.id === "aceito")?.accept_url).toBeNull();
    expect(dados.find((c) => c.id === "revogado")?.accept_url).toBeNull();
  });

  it("⭐ sessão de GERENTE lê a lista, mas sem nenhum link", async () => {
    comoSessao("manager");
    const dados = await lista(false);

    expect(dados.map((c) => c.id).sort()).toEqual(["aberto", "aceito", "revogado"]);
    expect(dados.every((c) => c.accept_url === null), "o gerente recebeu um link de aceite").toBe(true);
  });

  it("token de servidor (mesmo role:admin) não recebe o link", async () => {
    comoToken();
    const dados = await lista(true);
    expect(dados).toHaveLength(3);
    expect(dados.every((c) => c.accept_url === null)).toBe(true);
  });
});
