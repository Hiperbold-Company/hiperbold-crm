import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";

/**
 * OS MODELOS DA CONTA DA CONVERSA (painel de mensagens do chat, 17/11/2026).
 *
 * A organização pode ter várias contas oficiais. O painel do chat pede os
 * modelos e cria o modelo novo com o `channel_session_id` DA CONVERSA:
 *
 *   1. a lista sai só da WABA daquela conexão (a outra conta não vaza);
 *   2. conexão de OUTRA organização, ou id que não é uuid, dá 404 — no GET e no
 *      POST — e a plataforma não é chamada;
 *   3. criar vai para a conta DAQUELA conexão, com papel gerente e audit;
 *   4. atendente (agent) lê, mas não cria (403 da régua de papel);
 *   5. sem o parâmetro, a LEITURA segue na conta de sempre (a mais antiga); a ESCRITA também, se a
 *      organização tiver uma conta só — com duas, recusa 422 `conexao_oficial_ambigua` (regra da
 *      tela em cartões: criar modelo na conta errada não se desfaz).
 *
 * O banco é um duble que OBEDECE aos filtros: a sessão de outra organização
 * existe no duble, e só o filtro de `organization_id` a esconde.
 */
const h = vi.hoisted(() => ({
  role: vi.fn(),
  audit: vi.fn(),
  sync: vi.fn(),
  creds: vi.fn(),
  create: vi.fn(),
  tabelas: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/channels/meta/template-sync", () => ({ syncTemplates: h.sync }));
vi.mock("@/lib/channels/meta/credentials", () => ({ resolveMetaCreds: h.creds }));
vi.mock("@/lib/channels/meta/templates", () => ({ metaCloudTemplateOps: { create: h.create } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const filtros: ((r: Record<string, unknown>) => boolean)[] = [];
      const linhas = () => (h.tabelas[tabela] ?? []).filter((r) => filtros.every((f) => f(r)));
      let limite: number | null = null;
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((r) => r[c] === v), q),
        is: (c: string, v: unknown) => (filtros.push((r) => (r[c] ?? null) === v), q),
        order: () => q,
        limit: (n: number) => ((limite = n), q),
        maybeSingle: async () => ({ data: linhas().slice(0, limite ?? undefined)[0] ?? null, error: null }),
        then: (ok: (r: unknown) => unknown) => ok({ data: linhas(), error: null }),
      };
      return q;
    },
  }),
}));

import { GET, POST } from "@/app/api/v1/channels/templates/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const SESSAO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // a mais antiga da org
const SESSAO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // a da conversa
const SESSAO_DE_FORA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const sessao = (id: string, org: string, waba: string, pn: string) => ({
  id,
  organization_id: org,
  provider: CHANNEL_PROVIDER_META,
  archived_at: null,
  meta_waba_id: waba,
  meta_phone_number_id: pn,
});
const modelo = (name: string, org: string, waba: string) => ({
  name,
  language: "pt_BR",
  status: "APPROVED",
  category: "UTILITY",
  organization_id: org,
  channel_session_id: null,
  waba_id: waba,
  parameter_format: "POSITIONAL",
  contract_hash: "h",
  components: [{ type: "BODY", text: "Oi" }],
  synced_at: "2026-11-17T00:00:00Z",
  saved_values: {},
});

const autorizado = (papel = "manager") => ({
  ok: true,
  org: { orgId: ORG },
  user: { id: "u-1", idioma: "pt-BR" },
  papel,
});

const get = (qs = "") => GET(new NextRequest(`https://crm.test/api/v1/channels/templates${qs}`));
const post = (body: unknown) =>
  POST(new NextRequest("https://crm.test/api/v1/channels/templates", { method: "POST", body: JSON.stringify(body) }));

const CRIAR = {
  acao: "criar",
  name: "boas_vindas",
  language: "pt_BR",
  category: "UTILITY",
  components: [{ type: "BODY", text: "Olá" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.tabelas = {
    channel_sessions: [
      sessao(SESSAO_A, ORG, "WABA-A", "PN-A"),
      sessao(SESSAO_B, ORG, "WABA-B", "PN-B"),
      sessao(SESSAO_DE_FORA, OUTRA_ORG, "WABA-FORA", "PN-FORA"),
    ],
    meta_templates: [
      modelo("da_conta_a", ORG, "WABA-A"),
      modelo("da_conta_b", ORG, "WABA-B"),
      modelo("de_outra_org", OUTRA_ORG, "WABA-FORA"),
    ],
  };
  h.role.mockImplementation(async (papel: string) => autorizado(papel));
  h.creds.mockResolvedValue({ token: "tk", graphVersion: "v22.0" });
  h.sync.mockResolvedValue({ inserted: 1, updated: 0, unchanged: 0, disabled: 0 });
  h.create.mockResolvedValue({ id: "novo" });
});

const nomes = async (res: Response) =>
  ((await res.json()) as { data: { templates: { name: string }[] } }).data.templates.map((m) => m.name);

describe("GET com a conexão da conversa", () => {
  it("lista só os modelos da conta daquela conexão", async () => {
    const res = await get(`?channel_session_id=${SESSAO_B}`);
    expect(res.status).toBe(200);
    expect(await nomes(res)).toEqual(["da_conta_b"]);
  });

  it("sem o parâmetro, segue a organização inteira (o contrato de antes)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect((await nomes(res)).sort()).toEqual(["da_conta_a", "da_conta_b"]);
  });

  it("conexão de outra organização dá 404, igual à que não existe", async () => {
    expect((await get(`?channel_session_id=${SESSAO_DE_FORA}`)).status).toBe(404);
    expect((await get("?channel_session_id=nao-e-uuid")).status).toBe(404);
  });

  it("lê com papel de atendente", async () => {
    await get(`?channel_session_id=${SESSAO_B}`);
    expect(h.role).toHaveBeenCalledWith("agent", expect.anything());
  });
});

describe("POST criar com a conexão da conversa", () => {
  it("cria na conta da conexão pedida, com papel gerente e audit", async () => {
    const res = await post({ ...CRIAR, channel_session_id: SESSAO_B });
    expect(res.status).toBe(200);
    expect(h.role).toHaveBeenCalledWith("manager", expect.anything());
    expect(h.creds).toHaveBeenCalledWith(expect.anything(), { organizationId: ORG, phoneNumberId: "PN-B" });
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, sessionRef: "PN-B", draft: expect.objectContaining({ name: "boas_vindas" }) }),
    );
    expect(h.sync).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, wabaId: "WABA-B" }));
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "template.created", organizationId: ORG, resourceId: SESSAO_B }),
    );
  });

  it("conexão de outra organização dá 404 e a plataforma não é chamada", async () => {
    const res = await post({ ...CRIAR, channel_session_id: SESSAO_DE_FORA });
    expect(res.status).toBe(404);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("atendente não cria: a régua de papel barra antes de qualquer efeito", async () => {
    h.role.mockImplementation(async (papel: string) =>
      papel === "manager"
        ? { ok: false, response: NextResponse.json({ error: { code: "forbidden_role" } }, { status: 403 }) }
        : autorizado("agent"),
    );
    const res = await post({ ...CRIAR, channel_session_id: SESSAO_B });
    expect(res.status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("sem o parâmetro e com duas contas oficiais, recusa 422 conexao_oficial_ambigua sem chamar a plataforma", async () => {
    const res = await post(CRIAR);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("conexao_oficial_ambigua");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("sem o parâmetro e com uma conta oficial só, cria nela (a de sempre)", async () => {
    h.tabelas.channel_sessions = h.tabelas.channel_sessions!.filter((s) => s.id !== SESSAO_B);
    await post(CRIAR);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ sessionRef: "PN-A" }));
  });
});
