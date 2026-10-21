/**
 * PERMISSÕES POR PERFIL — catálogo, resolvedor, validação, portão de rota e a
 * action que grava. As rotas que o portão guarda estão em
 * `permissoes-por-perfil-rotas.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import {
  CAPACIDADES,
  PAPEIS_CONFIGURAVEIS,
  SO_ADMINISTRADOR,
  motivoDaTrava,
  pisoDaPermissao,
  MOTIVO_EXIGE_BANCO,
} from "@/lib/permissoes/catalogo";
import {
  diferencasDoPadrao,
  papelPode,
  permissoesEntradaSchema,
  permissoesPadrao,
  resolverPermissoes,
} from "@/lib/permissoes/resolver";

const auditSpy = vi.fn(async (_e: unknown) => undefined);
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));

const requireRoleMock = vi.fn();
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...a),
}));

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "99999999-9999-4999-8999-999999999999";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("catálogo", () => {
  it("chaves únicas", () => {
    const chaves = CAPACIDADES.map((c) => c.chave);
    expect(new Set(chaves).size).toBe(chaves.length);
  });

  it("padrão ⊆ liberável, e admin nunca aparece (é implícito)", () => {
    for (const c of CAPACIDADES) {
      for (const p of c.padrao) expect(c.liberavel as readonly string[]).toContain(p);
      expect([...c.padrao, ...c.liberavel]).not.toContain("admin");
      for (const p of c.liberavel) expect(PAPEIS_CONFIGURAVEIS as readonly string[]).toContain(p);
    }
  });

  it("o padrão reproduz os pisos de antes desta feature", () => {
    const padrao = permissoesPadrao();
    expect(padrao["contatos.exportar"]).toEqual(["manager"]);
    expect(padrao["contatos.excluir_em_lote"]).toEqual(["manager"]);
    expect(padrao["contatos.importar"]).toEqual(["manager", "agent"]);
    expect(padrao["negocios.mover"]).toEqual(["manager", "agent"]);
    expect(padrao["funis.editar"]).toEqual(["manager"]);
    expect(padrao["chat.responder"]).toEqual(["manager", "agent"]);
    expect(padrao["automacoes.gerenciar"]).toEqual(["manager"]);
  });

  it("o piso da rota é o menor papel liberável", () => {
    expect(pisoDaPermissao("contatos.exportar")).toBe("viewer");
    expect(pisoDaPermissao("contatos.importar")).toBe("agent");
    expect(pisoDaPermissao("relatorios.perdas")).toBe("agent");
    expect(pisoDaPermissao("funis.editar")).toBe("manager");
    // Excluir em lote: a função do banco exige gerente, então não desce.
    expect(pisoDaPermissao("contatos.excluir_em_lote")).toBe("manager");
  });

  it("toda célula travada tem motivo, e há lista do que é só do administrador", () => {
    for (const c of CAPACIDADES) {
      for (const p of PAPEIS_CONFIGURAVEIS) {
        if (!(c.liberavel as readonly string[]).includes(p))
          expect(motivoDaTrava(c.chave, p)).toBeTruthy();
      }
    }
    expect(motivoDaTrava("funis.editar", "agent")).toBe(MOTIVO_EXIGE_BANCO);
    expect(SO_ADMINISTRADOR.length).toBeGreaterThan(0);
  });
});

describe("resolvedor", () => {
  it("ausente, nulo ou lixo → padrão (nunca lança)", () => {
    for (const cru of [undefined, null, 42, "x", [], { "contatos.exportar": "manager" }]) {
      expect(resolverPermissoes(cru)).toEqual(permissoesPadrao());
    }
  });

  it("chave desconhecida é ignorada; papel fora do liberável invalida só aquela capacidade", () => {
    const r = resolverPermissoes({
      "inventada.coisa": ["viewer"],
      "funis.editar": ["agent"],
      "contatos.exportar": ["viewer", "agent"],
    });
    expect(r["funis.editar"]).toEqual(["manager"]);
    expect(r["contatos.exportar"]).toEqual(["agent", "viewer"]);
    expect(Object.keys(r)).not.toContain("inventada.coisa");
  });

  it("lista vazia é escolha válida: ninguém além do admin", () => {
    const r = resolverPermissoes({ "contatos.exportar": [] });
    expect(papelPode("manager", "contatos.exportar", r)).toBe(false);
    expect(papelPode("admin", "contatos.exportar", r)).toBe(true);
  });

  it("admin sempre; ai_operator e papel desconhecido nunca; sem mapa vale o padrão", () => {
    expect(papelPode("admin", "funis.editar", resolverPermissoes({ "funis.editar": [] }))).toBe(
      true,
    );
    expect(papelPode("ai_operator", "chat.responder")).toBe(false);
    expect(papelPode(null, "chat.responder")).toBe(false);
    expect(papelPode("agent", "chat.responder")).toBe(true);
    expect(papelPode("viewer", "chat.responder")).toBe(false);
  });

  it("grava só o que difere do padrão", () => {
    expect(diferencasDoPadrao(permissoesPadrao())).toEqual({});
    const r = resolverPermissoes({ "contatos.exportar": ["manager", "agent"] });
    expect(diferencasDoPadrao(r)).toEqual({ "contatos.exportar": ["manager", "agent"] });
  });
});

describe("validação da entrada", () => {
  it("recusa chave desconhecida", () => {
    expect(permissoesEntradaSchema.safeParse({ "inventada.coisa": ["manager"] }).success).toBe(
      false,
    );
  });

  it("recusa papel fora do liberável e papel que não existe", () => {
    expect(permissoesEntradaSchema.safeParse({ "funis.editar": ["agent"] }).success).toBe(false);
    expect(
      permissoesEntradaSchema.safeParse({ "contatos.excluir_em_lote": ["agent"] }).success,
    ).toBe(false);
    expect(permissoesEntradaSchema.safeParse({ "contatos.exportar": ["admin"] }).success).toBe(
      false,
    );
  });

  it("aceita o válido e completa o resto com o padrão", () => {
    const r = permissoesEntradaSchema.safeParse({ "contatos.exportar": ["agent", "manager"] });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data["contatos.exportar"]).toEqual(["manager", "agent"]);
      expect(r.data["funis.editar"]).toEqual(["manager"]);
    }
  });
});

describe("exigirPermissao", () => {
  function sessao(role: string, permissoes?: unknown) {
    requireRoleMock.mockResolvedValue({
      ok: true,
      user: { id: USER, idioma: "pt-BR" },
      org: {
        orgId: ORG,
        name: "Org",
        role,
        permissoes: permissoes === undefined ? undefined : resolverPermissoes(permissoes),
      },
    });
  }

  it("pede ao requireRole o piso da capacidade e repassa a recusa dele", async () => {
    requireRoleMock.mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "x", 401, {}),
    });
    const { exigirPermissao } = await import("@/lib/permissoes/servidor");
    const r = await exigirPermissao("contatos.exportar", { requestId: "r1" });
    expect(requireRoleMock.mock.calls[0]?.[0]).toBe("viewer");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("sem escolha da organização vale o padrão: gerente exporta, atendente não", async () => {
    const { exigirPermissao } = await import("@/lib/permissoes/servidor");
    sessao("manager");
    expect((await exigirPermissao("contatos.exportar")).ok).toBe(true);
    sessao("agent");
    const r = await exigirPermissao("contatos.exportar", { requestId: "r2", resource: "contacts" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      const corpo = (await r.response.json()) as {
        error: { code: string; details: { permission: string } };
      };
      expect(corpo.error.code).toBe("forbidden_permission");
      expect(corpo.error.details.permission).toBe("contatos.exportar");
    }
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "authz.denied",
        organizationId: ORG,
        metadata: expect.objectContaining({
          reason: "permission",
          permission: "contatos.exportar",
        }),
      }),
    );
  });

  it("a escolha da organização vale: tira do gerente, dá ao atendente; admin passa sempre", async () => {
    const { exigirPermissao } = await import("@/lib/permissoes/servidor");
    sessao("manager", { "contatos.exportar": ["agent"] });
    expect((await exigirPermissao("contatos.exportar")).ok).toBe(false);
    sessao("agent", { "contatos.exportar": ["agent"] });
    expect((await exigirPermissao("contatos.exportar")).ok).toBe(true);
    sessao("admin", { "contatos.exportar": [] });
    expect((await exigirPermissao("contatos.exportar")).ok).toBe(true);
  });
});

// ─── A action que grava ────────────────────────────────────────────────────

const sessaoDaAction = {
  user: null as null | Record<string, unknown>,
  org: null as null | Record<string, unknown>,
  mfaEmDivida: false,
};
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => sessaoDaAction.user,
  resolveActiveOrg: async () => sessaoDaAction.org,
  mfaEmDivida: async () => sessaoDaAction.mfaEmDivida,
  sessionAal: async () => "aal2",
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-request-id": "req-1", "user-agent": "vitest" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

interface Chamada {
  tabela?: string;
  filtro?: [string, unknown];
  rpc?: string;
  args?: Record<string, unknown>;
}
const chamadas: Chamada[] = [];
let settingsNoBanco: Record<string, unknown> = {};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => ({
        eq: (col: string, val: unknown) => ({
          maybeSingle: async () => {
            chamadas.push({ tabela, filtro: [col, val] });
            return { data: val === ORG ? { settings: settingsNoBanco } : null, error: null };
          },
        }),
      }),
    }),
    rpc: async (rpc: string, args: Record<string, unknown>) => {
      chamadas.push({ rpc, args });
      return { data: 1, error: null };
    },
  }),
}));

describe("salvarPermissoesPorPerfil", () => {
  beforeEach(() => {
    chamadas.length = 0;
    settingsNoBanco = { permissoes: { "contatos.exportar": ["viewer"] }, outra: true };
    sessaoDaAction.user = { id: USER, is_platform_admin: false, support: null };
    sessaoDaAction.org = { orgId: ORG, name: "Org", role: "admin" };
    sessaoDaAction.mfaEmDivida = false;
  });

  it("admin da organização grava só a diferença, na organização da sessão, e audita antes/depois", async () => {
    const { salvarPermissoesPorPerfil } =
      await import("@/app/actions/settings/salvarPermissoesPorPerfil");
    const r = await salvarPermissoesPorPerfil({ "contatos.exportar": ["manager", "agent"] });
    expect(r.ok).toBe(true);
    const gravacao = chamadas.find((c) => c.rpc === "fn_atualizar_setting_da_organizacao");
    expect(gravacao?.args).toEqual({
      p_org: ORG,
      p_caminho: ["permissoes"],
      p_valor: { "contatos.exportar": ["manager", "agent"] },
    });
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.permissions_updated",
        actorUserId: USER,
        organizationId: ORG,
        metadata: expect.objectContaining({
          antes: expect.objectContaining({ "contatos.exportar": ["viewer"] }),
          depois: expect.objectContaining({ "contatos.exportar": ["manager", "agent"] }),
        }),
      }),
    );
  });

  it("restaurar padrão grava null (a chave deixa de ter efeito)", async () => {
    const { salvarPermissoesPorPerfil } =
      await import("@/app/actions/settings/salvarPermissoesPorPerfil");
    await salvarPermissoesPorPerfil({});
    expect(chamadas.find((c) => c.rpc)?.args?.p_valor).toBeNull();
  });

  it("organization_id no corpo não muda o alvo: o corpo nem é aceito com ele", async () => {
    const { salvarPermissoesPorPerfil } =
      await import("@/app/actions/settings/salvarPermissoesPorPerfil");
    const r = await salvarPermissoesPorPerfil({
      organization_id: OUTRA,
      "contatos.exportar": ["agent"],
    });
    expect(r).toEqual({ ok: false, error: "validation_failed" });
    expect(chamadas).toEqual([]);
  });

  it("gerente, atendente e leitor não gravam", async () => {
    const { salvarPermissoesPorPerfil } =
      await import("@/app/actions/settings/salvarPermissoesPorPerfil");
    for (const role of ["manager", "agent", "viewer"]) {
      sessaoDaAction.org = { orgId: ORG, name: "Org", role };
      expect(await salvarPermissoesPorPerfil({})).toEqual({ ok: false, error: "forbidden_role" });
    }
    expect(chamadas).toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("admin com MFA em dívida e acompanhamento somente-leitura não gravam", async () => {
    const { salvarPermissoesPorPerfil } =
      await import("@/app/actions/settings/salvarPermissoesPorPerfil");
    sessaoDaAction.mfaEmDivida = true;
    expect(await salvarPermissoesPorPerfil({})).toEqual({ ok: false, error: "mfa_required" });
    sessaoDaAction.mfaEmDivida = false;
    sessaoDaAction.user = {
      id: USER,
      is_platform_admin: false,
      support: { id: "s", access_mode: "support_readonly", status: "active" },
    };
    expect((await salvarPermissoesPorPerfil({})).ok).toBe(false);
    expect(chamadas).toEqual([]);
  });

  it("papel fora do liberável é recusado antes de qualquer leitura", async () => {
    const { salvarPermissoesPorPerfil } =
      await import("@/app/actions/settings/salvarPermissoesPorPerfil");
    expect(await salvarPermissoesPorPerfil({ "funis.editar": ["agent"] })).toEqual({
      ok: false,
      error: "validation_failed",
    });
    expect(chamadas).toEqual([]);
  });
});
