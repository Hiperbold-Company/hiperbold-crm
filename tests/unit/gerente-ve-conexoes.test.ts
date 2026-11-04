/**
 * Gerente vê Conexões (decisão do dono do produto, 03/11/2026): "Gerente pode
 * sim ver conexões. Só o nível mais básico, o atendente, que não pode ver mesmo."
 *
 * O piso das rotas que a tela de Conexões chama no escopo da ORGANIZAÇÃO é
 * `manager`. Aqui o `requireRole` é o REAL: o papel efetivo vem do stub da
 * `fn_user_role_in_org`, e o MFA é o `mfaEmDivida` real sobre o mesmo stub
 * (sem fator cadastrado). Para a rota não sair do processo, o cliente
 * administrativo lança um erro marcado: chegar a ele prova que o portão de
 * papel deixou passar, sem conectar nada.
 *
 * Cobre as duas pontas: `agent` e `viewer` levam `forbidden_role` em toda
 * rota, sem tocar no cliente administrativo; `manager` e `admin` passam do
 * portão. E o item do menu segue o mesmo piso.
 */
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadAuthUser, orgAtivaSemPortao, resolveActiveOrg } from "@/lib/auth/server";
import type { AuthUser, Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { searchable } from "@/lib/navigation/registry";

const h = vi.hoisted(() => ({ admin: vi.fn() }));
const PASSOU_DO_PORTAO = "passou-do-portao-de-papel";

vi.mock("@/lib/auth/server", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn(), orgAtivaSemPortao: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: h.admin }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));
// A guarda de suporte não é o que se mede aqui (sessão comum, sem acompanhamento):
// ela segue nas rotas, e tem os próprios testes.
vi.mock("@/lib/impersonate/support", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, requireSupportWrite: vi.fn(async () => null) };
});
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
// O canal parceiro espelho é desligado por padrão e responde 404 ANTES do papel:
// ligado aqui para a guarda de papel ser o que decide.
vi.mock("@/lib/channels/graph-parceiro/credentials", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, canalGraphParceiroLigado: () => true };
});

import * as pareamentoQr from "@/app/api/v1/channels/pareamento-qr/route";
import * as pareamentoQrPorId from "@/app/api/v1/channels/pareamento-qr/[id]/route";
import * as pareamentoQrVerificar from "@/app/api/v1/channels/pareamento-qr/[id]/verificar/route";
import * as instancia from "@/app/api/v1/channels/instancia/route";
import * as oficial from "@/app/api/v1/channels/official/route";
import * as oficialNumero from "@/app/api/v1/channels/official/numero/route";
import * as oficialRegistrar from "@/app/api/v1/channels/official/registrar/route";
import * as oficialWebhook from "@/app/api/v1/channels/official/webhook/route";
import * as parceiro from "@/app/api/v1/channels/partner/route";
import * as parceiroModelos from "@/app/api/v1/channels/partner/templates/route";
import * as graph from "@/app/api/v1/channels/graph-partner/route";
import * as graphModelos from "@/app/api/v1/channels/graph-partner/templates/route";
import * as modelos from "@/app/api/v1/channels/templates/route";
import * as social from "@/app/api/v1/channels/social/route";
import * as metaSocial from "@/app/api/v1/channels/meta-social/route";
import * as metaSocialConectar from "@/app/api/v1/channels/meta-social/conectar/route";
import * as metaSocialPorId from "@/app/api/v1/channels/meta-social/[id]/route";
import * as acessoDaIa from "@/app/api/v1/channel-sessions/[id]/ai-access/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";

function preparar(role: Role): void {
  const user = {
    id: USER_ID,
    email: "pessoa@teste.local",
    is_platform_admin: false,
    organizations: [],
    idioma: "pt-BR",
  } as unknown as AuthUser;
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role });
  vi.mocked(orgAtivaSemPortao).mockResolvedValue({ orgId: ORG_ID, name: "Org", role, org_status: "active" });
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn(async () => ({ data: role, error: null })),
    auth: {
      // `isMfaEnrolled` lê `user.factors` da mesma ida ao GoTrue do `getUser()`.
      getUser: vi.fn(async () => ({ data: { user: { id: USER_ID, factors: [] } }, error: null })),
      mfa: {
        listFactors: vi.fn(async () => ({ data: { totp: [] }, error: null })),
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: "aal1", nextLevel: "aal1" },
          error: null,
        })),
      },
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
}

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const h1 = (f: unknown) => f as Handler;

/** Toda rota de Conexões no escopo da organização cujo piso virou `manager`. */
const ROTAS: Array<[string, Handler, string, Record<string, string>?]> = [
  ["GET pareamento-qr", h1(pareamentoQr.GET), "GET"],
  ["POST pareamento-qr", h1(pareamentoQr.POST), "POST"],
  ["POST pareamento-qr/[id]", h1(pareamentoQrPorId.POST), "POST", { id: CANAL }],
  ["DELETE pareamento-qr/[id]", h1(pareamentoQrPorId.DELETE), "DELETE", { id: CANAL }],
  ["POST pareamento-qr/[id]/verificar", h1(pareamentoQrVerificar.POST), "POST", { id: CANAL }],
  ["GET instancia", h1(instancia.GET), "GET"],
  ["POST instancia", h1(instancia.POST), "POST"],
  ["DELETE instancia", h1(instancia.DELETE), "DELETE"],
  ["GET official", h1(oficial.GET), "GET"],
  ["POST official", h1(oficial.POST), "POST"],
  ["GET official/numero", h1(oficialNumero.GET), "GET"],
  ["POST official/registrar", h1(oficialRegistrar.POST), "POST"],
  ["POST official/webhook", h1(oficialWebhook.POST), "POST"],
  ["GET partner", h1(parceiro.GET), "GET"],
  ["POST partner", h1(parceiro.POST), "POST"],
  ["POST partner/templates", h1(parceiroModelos.POST), "POST"],
  ["GET graph-partner", h1(graph.GET), "GET"],
  ["POST graph-partner", h1(graph.POST), "POST"],
  ["PATCH graph-partner", h1(graph.PATCH), "PATCH"],
  ["POST graph-partner/templates", h1(graphModelos.POST), "POST"],
  ["GET templates", h1(modelos.GET), "GET"],
  ["POST templates", h1(modelos.POST), "POST"],
  ["PATCH templates", h1(modelos.PATCH), "PATCH"],
  ["GET social", h1(social.GET), "GET"],
  ["GET meta-social", h1(metaSocial.GET), "GET"],
  ["DELETE meta-social/[id]", h1(metaSocialPorId.DELETE), "DELETE", { id: CANAL }],
  ["GET channel-sessions/[id]/ai-access", h1(acessoDaIa.GET), "GET", { id: CANAL }],
  ["PATCH channel-sessions/[id]/ai-access", h1(acessoDaIa.PATCH), "PATCH", { id: CANAL }],
];

async function chamar(handler: Handler, method: string, params: Record<string, string> = {}) {
  const req = new Request("http://localhost/api/v1/x?plataforma=instagram", {
    method,
    headers: { "content-type": "application/json", "user-agent": "vitest" },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
  // `nextUrl` é o que as rotas do Next leem; o Request do Node não o tem.
  Object.assign(req, { nextUrl: new URL(req.url) });
  try {
    const res = await handler(req as unknown as NextRequest, { params: Promise.resolve(params) });
    const corpo = (await res.clone().json().catch(() => null)) as { error?: { code?: string } } | null;
    return { passou: false, status: res.status, codigo: corpo?.error?.code ?? null };
  } catch (err) {
    if (err instanceof Error && err.message === PASSOU_DO_PORTAO) return { passou: true, status: null, codigo: null };
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  h.admin.mockImplementation(() => {
    throw new Error(PASSOU_DO_PORTAO);
  });
});

/**
 * Leitura que o ATENDENTE faz fora da tela de Conexões (correção do upstream
 * #2328): o seletor de modelos da janela fechada, no inbox, lê `GET templates`.
 * O piso dela é `agent`; `viewer` segue recusado (o laço de baixo cobre).
 */
const LEITURA_DO_ATENDENTE = new Set(["GET templates"]);

describe("rotas de Conexões: piso `manager`", () => {
  describe.each(["agent", "viewer"] as const)("%s é recusado", (role) => {
    const rotas = role === "agent" ? ROTAS.filter(([nome]) => !LEITURA_DO_ATENDENTE.has(nome)) : ROTAS;
    it.each(rotas)("%s → 403 forbidden_role, sem chegar ao banco", async (_nome, handler, method, params) => {
      preparar(role);
      const r = await chamar(handler, method, params);
      expect(r).toEqual({ passou: false, status: 403, codigo: "forbidden_role" });
      expect(h.admin).not.toHaveBeenCalled();
    });
  });

  describe.each(["manager", "admin"] as const)("%s passa do portão de papel", (role) => {
    it.each(ROTAS)("%s não é recusado por papel", async (_nome, handler, method, params) => {
      preparar(role);
      const r = await chamar(handler, method, params);
      expect(r.codigo).not.toBe("forbidden_role");
      expect(r.status === 403 && r.codigo === "forbidden_role").toBe(false);
    });
  });

  it("GET templates: o atendente passa do papel (seletor da janela fechada, #2328)", async () => {
    preparar("agent");
    const r = await chamar(h1(modelos.GET), "GET");
    expect(r.codigo).not.toBe("forbidden_role");
    expect(r.status === 403).toBe(false);
  });

  it("o início do OAuth das redes sociais: atendente volta com recusa, gerente passa do papel", async () => {
    preparar("agent");
    const agente = await chamar(h1(metaSocialConectar.GET), "GET");
    expect(agente).toEqual({ passou: false, status: 403, codigo: "forbidden_role" });

    preparar("manager");
    const gerente = await chamar(h1(metaSocialConectar.GET), "GET");
    expect(gerente.codigo).not.toBe("forbidden_role");
  });

  it("social POST: atendente recusado, gerente passa do papel", async () => {
    preparar("agent");
    expect(await chamar(h1(social.POST), "POST")).toEqual({ passou: false, status: 403, codigo: "forbidden_role" });
    preparar("manager");
    // Corpo vazio para ao validar (400), antes do limitador de taxa: o que importa é não ser 403 de papel.
    expect((await chamar(h1(social.POST), "POST")).codigo).not.toBe("forbidden_role");
  });
});

describe("menu: Conexões aparece a partir de gerente", () => {
  const alcanca = (role: Role) => searchable(false, role).some((d) => d.href === "/app/connections");

  it.each(["manager", "admin"] as const)("%s alcança /app/connections", (role) => {
    expect(alcanca(role)).toBe(true);
  });

  it.each(["agent", "ai_operator", "viewer"] as const)("%s não alcança /app/connections", (role) => {
    expect(alcanca(role)).toBe(false);
  });
});
