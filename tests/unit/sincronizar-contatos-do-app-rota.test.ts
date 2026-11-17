/**
 * POST /api/v1/channels/official/sincronizar-contatos: "tentar de novo" a sincronização dos contatos do
 * app WhatsApp Business (coexistência).
 *
 * O Graph é um dublê de `fetch`; a autorização, o banco e a cifra são dublês simples. O que se prova:
 * papel mínimo (gerente), a sessão vem só da organização da sessão de login (id de outra organização é
 * 404 e NUNCA chega à Meta), suporte em leitura é barrado antes do efeito, o corpo é validado, o limite
 * de tentativas vale, o pedido à Meta leva o token certo, e o audit não leva token.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSAO_DA_ORG = "11111111-1111-4111-8111-111111111111";
const SESSAO_DE_OUTRA_ORG = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  papelOk: true,
  suporteNegado: false,
  limiteLiberado: true,
  orgId: "org-a",
  /** O que o banco devolve, JÁ filtrado pela organização pedida (como o `.eq("organization_id")` faz). */
  sessoesPorOrg: {} as Record<string, null | Record<string, string>>,
  token: "TOKEN-EM-CLARO-DA-META" as string | null,
  consultasPorOrg: [] as string[],
  papelPedido: null as string | null,
  audit: [] as Array<Record<string, unknown>>,
  logs: [] as string[],
}));

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () =>
    h.suporteNegado ? new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }) : null,
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async (min: string) => {
    h.papelPedido = min;
    return h.papelOk
      ? { ok: true, user: { id: "u1", idioma: "pt-BR", support: null }, org: { orgId: h.orgId, role: min } }
      : { ok: false, response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }) };
  },
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: h.limiteLiberado }),
}));
vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    h.audit.push(entrada);
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: {
    info: (...a: unknown[]) => h.logs.push(JSON.stringify(a)),
    warn: (...a: unknown[]) => h.logs.push(JSON.stringify(a)),
    error: (...a: unknown[]) => h.logs.push(JSON.stringify(a)),
  },
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => h.token }));
vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async (principal: () => Promise<unknown>) => principal(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      let org = "";
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.is = () => q;
      q.eq = (coluna: string, valor: string) => {
        if (coluna === "organization_id") org = valor;
        return q;
      };
      q.maybeSingle = async () => {
        h.consultasPorOrg.push(org);
        return { data: h.sessoesPorOrg[org] ?? null, error: null };
      };
      return q;
    },
  }),
}));

import { POST } from "@/app/api/v1/channels/official/sincronizar-contatos/route";

const fetchMock = vi.fn();
const post = (corpo: unknown) =>
  new NextRequest("http://localhost/api/v1/channels/official/sincronizar-contatos", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });

function meta(status: number, corpo: unknown) {
  fetchMock.mockResolvedValue({ ok: status < 300, status, json: async () => corpo } as Response);
}

beforeEach(() => {
  h.papelOk = true;
  h.papelPedido = null;
  h.suporteNegado = false;
  h.limiteLiberado = true;
  h.orgId = "org-a";
  h.token = "TOKEN-EM-CLARO-DA-META";
  h.consultasPorOrg = [];
  h.audit = [];
  h.logs = [];
  h.sessoesPorOrg = {
    "org-a": { id: SESSAO_DA_ORG, meta_phone_number_id: "111", meta_waba_id: "222", meta_token_encrypted: "CIFRADO" },
    "org-b": { id: SESSAO_DE_OUTRA_ORG, meta_phone_number_id: "999", meta_waba_id: "888", meta_token_encrypted: "CIFRADO-B" },
  };
  fetchMock.mockReset();
  meta(200, { success: true });
  vi.stubGlobal("fetch", fetchMock);
});

describe("POST /api/v1/channels/official/sincronizar-contatos", () => {
  it("sucesso: pede à Meta com o token da sessão, devolve sincronizado e audita sem token", async () => {
    const res = await POST(post({ channel_session_id: SESSAO_DA_ORG }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ sincronizado: true, motivo: null });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/111/smb_app_data");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer TOKEN-EM-CLARO-DA-META" });

    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: "channel.official_contacts_sync_requested",
      organizationId: "org-a",
      actorUserId: "u1",
      resourceId: SESSAO_DA_ORG,
    });
    expect(JSON.stringify(h.audit)).not.toContain("TOKEN-EM-CLARO");
  });

  it("⭐ tenant: id da sessão de OUTRA organização é 404 e a Meta nem é chamada", async () => {
    const res = await POST(post({ channel_session_id: SESSAO_DE_OUTRA_ORG }));
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.audit).toHaveLength(0);
    // A busca é escopada pela organização da SESSÃO de login, nunca pela do id enviado.
    expect(new Set(h.consultasPorOrg)).toEqual(new Set(["org-a"]));
  });

  it("⭐ tenant: quem é da org B só alcança a sessão da org B", async () => {
    h.orgId = "org-b";
    expect((await POST(post({ channel_session_id: SESSAO_DA_ORG }))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await POST(post({ channel_session_id: SESSAO_DE_OUTRA_ORG }))).status).toBe(200);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/999/smb_app_data");
  });

  it("organização sem conexão oficial viva é 404", async () => {
    h.sessoesPorOrg["org-a"] = null;
    expect((await POST(post({ channel_session_id: SESSAO_DA_ORG }))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("papel abaixo de gerente é recusado antes de qualquer efeito", async () => {
    h.papelOk = false;
    expect((await POST(post({ channel_session_id: SESSAO_DA_ORG }))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.audit).toHaveLength(0);
  });

  it("o papel exigido é gerente (nem mais, nem menos)", async () => {
    await POST(post({ channel_session_id: SESSAO_DA_ORG }));
    expect(h.papelPedido).toBe("manager");
  });

  it("suporte em leitura é recusado antes de qualquer efeito", async () => {
    h.suporteNegado = true;
    expect((await POST(post({ channel_session_id: SESSAO_DA_ORG }))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.audit).toHaveLength(0);
  });

  it("corpo inválido (sem id, id que não é uuid, campo a mais) é 422 sem chegar à Meta", async () => {
    for (const corpo of [{}, { channel_session_id: "nao-e-uuid" }, { channel_session_id: SESSAO_DA_ORG, extra: 1 }]) {
      expect((await POST(post(corpo))).status).toBe(422);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("limite de tentativas estourado é 429 sem chegar à Meta", async () => {
    h.limiteLiberado = false;
    const res = await POST(post({ channel_session_id: SESSAO_DA_ORG }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a Meta recusar não é erro de requisição: 200 com sincronizado false e o motivo; o log não leva o token", async () => {
    meta(400, { error: { code: 100, message: "Invalid parameter" } });
    const res = await POST(post({ channel_session_id: SESSAO_DA_ORG }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.sincronizado).toBe(false);
    expect(data.motivo).toBeTruthy();
    expect(h.audit[0]).toMatchObject({ metadata: { aceita: false } });
    expect(h.logs.join("\n")).not.toContain("TOKEN-EM-CLARO");
  });

  it("falha de rede com a Meta também vira sincronizado false", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const res = await POST(post({ channel_session_id: SESSAO_DA_ORG }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.sincronizado).toBe(false);
  });

  it("credencial ilegível é 422, sem chegar à Meta", async () => {
    h.token = null;
    expect((await POST(post({ channel_session_id: SESSAO_DA_ORG }))).status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
