// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { mfaEmDividaEstrita } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * As rotas de administração dos relatos. O portão real (`requirePlatformAdmin` e
 * `requirePlatformAdminEscrita`) roda: só a sessão e a linha de `platform_admins` vêm do dublê
 * (molde de `app/api/v1/admin/incidents/[id]/resolve/route.test.ts`). Quem não é platform admin
 * tem `platform_admins` vazio, o `redirect` real lança, e a rota responde 403.
 */
const sessao = vi.hoisted(() => ({ ehAdmin: true, scope: "full" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const consulta: Record<string, unknown> = {};
    consulta.select = () => consulta;
    consulta.eq = () => consulta;
    consulta.is = () => consulta;
    consulta.maybeSingle = async () => ({
      data: sessao.ehAdmin
        ? { user_id: ADMIN_ID, scope: sessao.scope, mfa_required: false, revoked_at: null }
        : null,
      error: null,
    });
    return {
      auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID, factors: [] } } }) },
      from: () => consulta,
    };
  },
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDividaEstrita: vi.fn(async () => false) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const RELATO_ID = "44444444-4444-4444-8444-444444444444";

const espiao = { updates: [] as Record<string, unknown>[], assinadas: [] as Array<{ caminho: string; seg: number }> };

function adminStub() {
  const linha = {
    id: RELATO_ID,
    organization_id: ORG_ID,
    user_id: null,
    description: "Descrição longa o bastante",
    page_url: "/app/inbox",
    context: {},
    screenshot_path: `${ORG_ID}/${RELATO_ID}.webp`,
    status: "novo",
    admin_note: null,
    created_at: "2026-11-17T10:00:00.000Z",
    updated_at: "2026-11-17T10:00:00.000Z",
    organizations: { display_name: "Empresa A" },
  };
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.order = () => builder;
  builder.limit = async () => ({ data: [linha], error: null });
  builder.maybeSingle = async () => ({ data: linha, error: null });
  builder.update = (v: Record<string, unknown>) => {
    espiao.updates.push(v);
    return { eq: async () => ({ error: null }) };
  };
  return {
    from: () => builder,
    auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
    storage: {
      from: () => ({
        createSignedUrl: async (caminho: string, seg: number) => {
          espiao.assinadas.push({ caminho, seg });
          return { data: { signedUrl: "https://assinada.test/x" }, error: null };
        },
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessao.ehAdmin = true;
  sessao.scope = "full";
  espiao.updates = [];
  espiao.assinadas = [];
  vi.mocked(mfaEmDividaEstrita).mockResolvedValue(false);
  vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
});

const params = { params: Promise.resolve({ id: RELATO_ID }) };
const patch = (corpo: unknown) =>
  new NextRequest(`http://localhost/api/v1/admin/bug-reports/${RELATO_ID}`, {
    method: "PATCH",
    body: JSON.stringify(corpo),
  });

describe("admin dos relatos de problema", () => {
  it("quem não é platform admin recebe 403 na lista, no detalhe e na troca de status", async () => {
    sessao.ehAdmin = false;
    const lista = await import("./route");
    const detalhe = await import("./[id]/route");
    expect((await lista.GET(new NextRequest("http://localhost/api/v1/admin/bug-reports"))).status).toBe(403);
    expect((await detalhe.GET(new NextRequest("http://localhost/x"), params)).status).toBe(403);
    expect((await detalhe.PATCH(patch({ status: "resolvido" }), params)).status).toBe(403);
    expect(espiao.updates).toEqual([]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("support_readonly lê mas não troca status", async () => {
    sessao.scope = "support_readonly";
    const detalhe = await import("./[id]/route");
    expect((await detalhe.GET(new NextRequest("http://localhost/x"), params)).status).toBe(200);
    expect((await detalhe.PATCH(patch({ status: "resolvido" }), params)).status).toBe(403);
    expect(espiao.updates).toEqual([]);
  });

  it("a lista devolve empresa e se tem print", async () => {
    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/v1/admin/bug-reports?status=novo"));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ empresa: string; tem_print: boolean }> };
    expect(data[0]).toMatchObject({ empresa: "Empresa A", tem_print: true });
  });

  it("o detalhe assina o print por 5 minutos", async () => {
    const { GET } = await import("./[id]/route");
    const res = await GET(new NextRequest("http://localhost/x"), params);
    const { data } = (await res.json()) as { data: { print_url: string } };
    expect(data.print_url).toBe("https://assinada.test/x");
    expect(espiao.assinadas).toEqual([{ caminho: `${ORG_ID}/${RELATO_ID}.webp`, seg: 300 }]);
  });

  it("a troca de status grava e audita bug_report.status_changed", async () => {
    const { PATCH } = await import("./[id]/route");
    const res = await PATCH(patch({ status: "em_andamento", admin_note: "olhando" }), params);
    expect(res.status).toBe(200);
    expect(espiao.updates[0]).toMatchObject({ status: "em_andamento", admin_note: "olhando" });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bug_report.status_changed",
        organizationId: ORG_ID,
        resourceId: RELATO_ID,
        metadata: { de: "novo", para: "em_andamento" },
      }),
    );
  });

  it("status fora do vocabulário dá 400", async () => {
    const { PATCH } = await import("./[id]/route");
    expect((await PATCH(patch({ status: "fechado" }), params)).status).toBe(400);
    expect(espiao.updates).toEqual([]);
  });
});
