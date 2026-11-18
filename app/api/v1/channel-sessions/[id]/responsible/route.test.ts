import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rota roda com o `requireRole` DE VERDADE: o que é dublado é a borda dele (quem está logado,
 * a organização ativa e o papel que o banco devolve) e o banco da gravação — duas tabelas em
 * memória (`channel_sessions` e `user_organizations`) e um dublê de `fn_gravar_membro_da_conexao`
 * com a mesma regra da migration 1019. A regra no Postgres de verdade (FK, travas, gatilho) é
 * medida em `tests/invariants/membro-responsavel-da-conexao.test.ts`; aqui, o que a rota faz com
 * cada resposta (status, corpo, auditoria) e que a organização sai da sessão.
 */
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
  mfaEmDividaEstrita: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PATCH } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "44444444-4444-4444-8444-444444444444";
const CANAL = "22222222-2222-4222-8222-222222222222";
const CANAL_DA_OUTRA = "55555555-5555-4555-8555-555555555555";
const USUARIO = "33333333-3333-4333-8333-333333333333";
const INGRID = "66666666-6666-4666-8666-666666666666";
const DE_FORA = "77777777-7777-4777-8777-777777777777";
const REMOVIDA = "88888888-8888-4888-8888-888888888888";
const OBSERVADOR = "99999999-9999-4999-8999-999999999999";

type Linha = Record<string, unknown>;
let tabelas: Record<string, Linha[]>;
let banco: ReturnType<typeof bancoEmMemoria>;

function bancoEmMemoria() {
  return {
    rpc: vi.fn(async (nome: string, a: { p_org: string; p_canal: string; p_user: string | null }) => {
      if (nome !== "fn_gravar_membro_da_conexao") throw new Error(`rpc inesperada: ${nome}`);
      const canal = tabelas.channel_sessions!.find(
        (l) => l.organization_id === a.p_org && l.id === a.p_canal && l.archived_at === null,
      );
      if (!canal) return { data: { resultado: "canal_nao_encontrado" }, error: null };
      if (a.p_user !== null) {
        const membro = tabelas.user_organizations!.find(
          (l) =>
            l.organization_id === a.p_org &&
            l.user_id === a.p_user &&
            l.revoked_at === null &&
            l.role !== "viewer",
        );
        if (!membro) return { data: { resultado: "membro_invalido" }, error: null };
      }
      const anterior = (canal.responsible_user_id ?? null) as string | null;
      if (anterior === a.p_user)
        return { data: { resultado: "sem_mudanca", anterior, atual: a.p_user }, error: null };
      canal.responsible_user_id = a.p_user;
      return { data: { resultado: "gravado", anterior, atual: a.p_user }, error: null };
    }),
  };
}

function papelNoBanco(role: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn(async () => ({ data: role, error: null })),
  } as never);
}

function papelDaOrgAtiva(role: string) {
  vi.mocked(orgAtivaSemPortao).mockResolvedValue({
    orgId: ORG,
    name: "Empresa",
    role,
    org_status: "active",
  } as never);
  papelNoBanco(role);
}

const chamar = (body: unknown, id = CANAL) =>
  PATCH(
    new NextRequest(`http://localhost/api/v1/channel-sessions/${id}/responsible`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

const canal = () => tabelas.channel_sessions![0]!;

beforeEach(() => {
  vi.clearAllMocks();
  tabelas = {
    channel_sessions: [
      { id: CANAL, organization_id: ORG, responsible_user_id: null, archived_at: null },
      { id: CANAL_DA_OUTRA, organization_id: OUTRA_ORG, responsible_user_id: null, archived_at: null },
    ],
    user_organizations: [
      { organization_id: ORG, user_id: INGRID, role: "agent", revoked_at: null },
      { organization_id: ORG, user_id: OBSERVADOR, role: "viewer", revoked_at: null },
      { organization_id: ORG, user_id: REMOVIDA, role: "agent", revoked_at: "2026-11-01T00:00:00Z" },
      // Membro ativo, mas de OUTRA empresa.
      { organization_id: OUTRA_ORG, user_id: DE_FORA, role: "admin", revoked_at: null },
    ],
  };
  banco = bancoEmMemoria();
  vi.mocked(createAdminClient).mockReturnValue(banco as never);
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: USUARIO,
    is_platform_admin: false,
    support: null,
    organizations: [],
    idioma: "pt-BR",
  } as never);
  papelDaOrgAtiva("manager");
});

describe("PATCH …/channel-sessions/[id]/responsible (membro responsável pela conexão)", () => {
  it("sem login: 401 e o banco não é tocado", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null);
    const r = await chamar({ user_id: INGRID });
    expect(r.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("suporte só leitura: a guarda de efeito recusa antes de tudo", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "support_read_only" } }), { status: 403 }) as never,
    );
    const r = await chamar({ user_id: INGRID });
    expect(r.status).toBe(403);
    expect(canal().responsible_user_id).toBeNull();
  });

  it("atendente: 403 e nada muda", async () => {
    papelDaOrgAtiva("agent");
    const r = await chamar({ user_id: INGRID });
    expect(r.status).toBe(403);
    expect(canal().responsible_user_id).toBeNull();
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "channel.responsible_changed" }));
  });

  it("gerente grava o membro e audita o antes e o depois", async () => {
    const r = await chamar({ user_id: INGRID });
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: Linha };
    expect(corpo.data).toMatchObject({ id: CANAL, responsible_user_id: INGRID });
    expect(canal().responsible_user_id).toBe(INGRID);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.responsible_changed",
        actorUserId: USUARIO,
        organizationId: ORG,
        resourceType: "channel_session",
        resourceId: CANAL,
        metadata: { previous_responsible_user_id: null, responsible_user_id: INGRID },
      }),
    );
  });

  it("administrador grava e tira o membro (nenhum = null)", async () => {
    papelDaOrgAtiva("admin");
    canal().responsible_user_id = INGRID;
    const r = await chamar({ user_id: null });
    expect(r.status).toBe(200);
    expect(canal().responsible_user_id).toBeNull();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channel.responsible_changed",
        metadata: { previous_responsible_user_id: INGRID, responsible_user_id: null },
      }),
    );
  });

  it("membro de outra organização: 422 e o vínculo não é gravado", async () => {
    const r = await chamar({ user_id: DE_FORA });
    expect(r.status).toBe(422);
    expect(canal().responsible_user_id).toBeNull();
    expect(audit).not.toHaveBeenCalled();
  });

  it("membro removido da equipe e observador também são recusados", async () => {
    expect((await chamar({ user_id: REMOVIDA })).status).toBe(422);
    expect((await chamar({ user_id: OBSERVADOR })).status).toBe(422);
    expect(canal().responsible_user_id).toBeNull();
  });

  it("conexão de outra organização: 404 e a linha dela não muda", async () => {
    const r = await chamar({ user_id: INGRID }, CANAL_DA_OUTRA);
    expect(r.status).toBe(404);
    expect(tabelas.channel_sessions![1]!.responsible_user_id).toBeNull();
  });

  it("a organização da escrita é a da sessão, nunca do corpo", async () => {
    await chamar({ user_id: INGRID });
    expect(banco.rpc).toHaveBeenCalledWith("fn_gravar_membro_da_conexao", {
      p_org: ORG,
      p_canal: CANAL,
      p_user: INGRID,
    });
  });

  it("falha do banco: 500 e nenhuma auditoria de mudança", async () => {
    banco.rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } } as never);
    const r = await chamar({ user_id: INGRID });
    expect(r.status).toBe(500);
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "channel.responsible_changed" }));
  });

  it("sem mudança: 200 sem gravar nem auditar", async () => {
    canal().responsible_user_id = INGRID;
    const r = await chamar({ user_id: INGRID });
    expect(r.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("corpo inválido (sem user_id, id que não é uuid, campo a mais): 422", async () => {
    expect((await chamar({})).status).toBe(422);
    expect((await chamar({ user_id: "ingrid" })).status).toBe(422);
    expect((await chamar({ user_id: INGRID, organization_id: OUTRA_ORG })).status).toBe(422);
    expect(canal().responsible_user_id).toBeNull();
  });
});
