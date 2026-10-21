/**
 * PERMISSÕES POR PERFIL nas ROTAS — o portão vale no servidor, não só no botão.
 *
 * Para cada rota: o padrão é o de antes; tirar a capacidade do gerente dá 403
 * `forbidden_permission` SEM efeito; liberar para o atendente faz ele passar
 * (onde o catálogo deixa). `requireRole` é simulado como o banco o resolveria
 * (papel efetivo + permissões que `loadAuthUser` leu); o resto da rota roda de
 * verdade sobre o banco em memória.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import type { Role } from "@/lib/auth/types";
import { resolverPermissoes } from "@/lib/permissoes/resolver";
import { createClient } from "@/lib/supabase/server";

import { clienteEmMemoria, criarBanco, type BancoEmMemoria } from "./helpers/supabase-em-memoria";
import { ORG_ID, funilRow, makeDb, PIPE } from "@/tests/helpers/stages-db-double";

const auditSpy = vi.fn(async (_e: unknown) => undefined);
vi.mock("@/lib/audit", () => ({
  audit: (e: unknown) => auditSpy(e),
  isServiceRoleConfigured: () => false,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  devolverRateLimit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/contacts/cpf-do-contato", () => ({
  idsPorHashDeCpf: vi.fn(async () => ({ ids: [], error: null })),
  idsComCpf: vi.fn(async () => ({ ids: new Set<string>(), error: null })),
}));

const USER = "99999999-9999-4999-8999-999999999999";
const uid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** O que `requireRole` devolveria: papel efetivo do banco + permissões resolvidas da organização. */
function sessao(role: Role, permissoes?: Record<string, string[]>, orgId = ORG_ID) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USER,
      email: "x@exemplo.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR",
      organizations: [],
    },
    org: {
      orgId,
      name: "Org",
      role,
      ...(permissoes ? { permissoes: resolverPermissoes(permissoes) } : {}),
    },
  });
}

function post(url: string, corpo: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

async function codigo(res: Response): Promise<string | undefined> {
  const corpo = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: { code?: string } } | null;
  return corpo?.error?.code;
}

let banco: BancoEmMemoria;
function popular(): BancoEmMemoria {
  const contato = (n: number) => ({
    id: uid(n),
    organization_id: ORG_ID,
    display_name: `Contato ${n}`,
    email: `c${n}@exemplo.com`,
    phone_number: `+5535999900${n}`,
    tags: [],
    source: "manual",
    is_merged_into: null,
    is_anonymized: false,
    created_at: "2026-10-10T12:00:00Z",
    last_activity_at: "2026-10-10T12:00:00Z",
    custom_fields: {},
    leads: [],
  });
  return criarBanco({
    contacts: [contato(1), contato(2)],
    messages: [],
    conversations: [],
    calendar_appointments: [],
    crm_leads: [],
    crm_pipelines: [],
    crm_stages: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  banco = popular();
  vi.mocked(createClient).mockResolvedValue(clienteEmMemoria(banco) as never);
});

describe("POST /api/v1/contacts/export (contatos.exportar)", () => {
  const exportar = async () => {
    const { POST } = await import("@/app/api/v1/contacts/export/route");
    return POST(post("/api/v1/contacts/export", { ids: [uid(1)] }));
  };

  it("pede o piso da capacidade (viewer) ao requireRole", async () => {
    sessao("manager");
    await exportar();
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("viewer");
  });

  it("padrão = o de antes: gerente exporta, atendente e leitor levam 403", async () => {
    sessao("manager");
    expect((await exportar()).status).toBe(200);
    for (const role of ["agent", "viewer"] as const) {
      sessao(role);
      const res = await exportar();
      expect(res.status).toBe(403);
      expect(await codigo(res)).toBe("forbidden_permission");
    }
  });

  it("tirar do gerente → 403 para o gerente, com audit authz.denied reason=permission", async () => {
    sessao("manager", { "contatos.exportar": [] });
    const res = await exportar();
    expect(res.status).toBe(403);
    expect(await codigo(res)).toBe("forbidden_permission");
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "authz.denied",
        metadata: expect.objectContaining({
          reason: "permission",
          permission: "contatos.exportar",
        }),
      }),
    );
    expect(auditSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "contacts.exported" }),
    );
  });

  it("liberar para o atendente → atendente exporta; admin exporta mesmo com tudo desligado", async () => {
    sessao("agent", { "contatos.exportar": ["manager", "agent"] });
    const res = await exportar();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("c1@exemplo.com");
    sessao("admin", { "contatos.exportar": [] });
    expect((await exportar()).status).toBe(200);
  });
});

describe("POST /api/v1/contacts/bulk-delete (contatos.excluir_em_lote)", () => {
  const excluir = async () => {
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    return POST(post("/api/v1/contacts/bulk-delete", { ids: [uid(1)] }));
  };
  const ids = () => (banco.tabelas.contacts ?? []).map((c) => c.id);

  it("padrão: gerente apaga", async () => {
    sessao("manager");
    expect((await excluir()).status).toBe(200);
    expect(ids()).toEqual([uid(2)]);
  });

  it("tirar do gerente → 403 e NADA apagado", async () => {
    sessao("manager", { "contatos.excluir_em_lote": [] });
    const res = await excluir();
    expect(res.status).toBe(403);
    expect(await codigo(res)).toBe("forbidden_permission");
    expect(ids()).toEqual([uid(1), uid(2)]);
  });

  it("não desce do gerente: a função do banco exige manager, então o piso continua manager", async () => {
    sessao("manager");
    await excluir();
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });
});

describe("POST /api/v1/pipelines (funis.editar)", () => {
  const criar = async () => {
    const { POST } = await import("@/app/api/v1/pipelines/route");
    return POST(post("/api/v1/pipelines", { name: "Clínica" }));
  };

  it("padrão: gerente cria", async () => {
    const db = makeDb({
      pipelines: [funilRow({ id: PIPE, name: "Pedidos", slug: "pedidos", is_default: true })],
    });
    sessao("manager");
    expect((await criar()).status).toBe(201);
    expect(db.escritas.some((e) => e.table === "crm_pipelines")).toBe(true);
  });

  it("tirar do gerente → 403 e nenhuma escrita", async () => {
    const db = makeDb({ pipelines: [] });
    sessao("manager", { "funis.editar": [] });
    const res = await criar();
    expect(res.status).toBe(403);
    expect(await codigo(res)).toBe("forbidden_permission");
    expect(db.escritas).toEqual([]);
  });
});

describe("POST /api/v1/leads/[id]/move (negocios.mover) — caminho de sessão", () => {
  const mover = async () => {
    const { POST } = await import("@/app/api/v1/leads/[id]/move/route");
    return POST(post(`/api/v1/leads/${uid(9)}/move`, {}), {
      params: Promise.resolve({ id: uid(9) }),
    });
  };

  it("padrão: atendente passa do portão (o corpo vazio cai na validação, não no 403)", async () => {
    sessao("agent");
    const res = await mover();
    expect(res.status).toBe(422);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("agent");
  });

  it("tirar do atendente → 403 forbidden_permission para o atendente; gerente segue", async () => {
    sessao("agent", { "negocios.mover": ["manager"] });
    const res = await mover();
    expect(res.status).toBe(403);
    expect(await codigo(res)).toBe("forbidden_permission");
    sessao("manager", { "negocios.mover": ["manager"] });
    expect((await mover()).status).toBe(422);
  });
});
