/**
 * A rota dos posts: papel gerente, organização da SESSÃO (nunca do pedido),
 * Zod no query, 404 para conta de outra organização. O banco é o em memória
 * dos testes do canal; a Meta é um `fetch` falso.
 */
import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

import { bancoFalso } from "@/tests/unit/helpers/meta-social-banco-falso";

const h = vi.hoisted(() => ({ role: vi.fn(), limit: vi.fn(), db: null as unknown }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: h.limit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));

import { GET } from "./route";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSAO = "11111111-1111-4111-8111-111111111111";
const sessao = {
  id: SESSAO,
  organization_id: ORG_A,
  provider: "meta_social",
  meta_social_platform: "instagram",
  meta_social_account_id: "17841400000000001",
  meta_social_page_id: "PAG-1",
  meta_social_token_encrypted: "cifrado:TOKEN",
  archived_at: null,
};
const pedir = (qs: string) => GET(new NextRequest(`https://crm.test/api/v1/channels/meta-social/posts?${qs}`));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  h.role.mockResolvedValue({ ok: true, org: { orgId: ORG_A }, user: { id: "gerente" } });
  h.limit.mockResolvedValue({ allowed: true });
  h.db = bancoFalso({ channel_sessions: [sessao] }).db;
});

it("exige gerente", async () => {
  h.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await pedir(`channel_session_id=${SESSAO}`)).status).toBe(403);
  expect(h.role).toHaveBeenCalledWith("manager", expect.anything());
});

it("query inválida é 400; campo a mais (organization_id) também", async () => {
  expect((await pedir("channel_session_id=nao-uuid")).status).toBe(400);
  expect((await pedir(`channel_session_id=${SESSAO}&organization_id=${ORG_B}`)).status).toBe(400);
});

it("lista os posts da conta da organização da sessão", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "M-1", permalink: "https://www.instagram.com/p/A1/", media_type: "IMAGE" }] }))),
  );
  const r = await pedir(`channel_session_id=${SESSAO}`);
  expect(r.status).toBe(200);
  expect((await r.json()).data.posts.map((p: { media_id: string }) => p.media_id)).toEqual(["M-1"]);
});

it("resolve por link e devolve { media_id }", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "M-9", permalink: "https://www.instagram.com/reel/R9/" }] }))),
  );
  const r = await pedir(`channel_session_id=${SESSAO}&link=${encodeURIComponent("https://instagram.com/reel/R9/?igsh=x")}`);
  expect(r.status).toBe(200);
  expect((await r.json()).data).toEqual({ media_id: "M-9" });
});

it("conta de outra organização é 404, e a Meta nem é chamada", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  h.role.mockResolvedValue({ ok: true, org: { orgId: ORG_B }, user: { id: "gerente" } });
  const r = await pedir(`channel_session_id=${SESSAO}`);
  expect(r.status).toBe(404);
  expect((await r.json()).error.code).toBe("conta_indisponivel");
  expect(fetcher).not.toHaveBeenCalled();
});

it("link inválido é 400; teto estourado é 429", async () => {
  expect((await pedir(`channel_session_id=${SESSAO}&link=https://evil.com/p/X`)).status).toBe(400);
  h.limit.mockResolvedValue({ allowed: false });
  const r = await pedir(`channel_session_id=${SESSAO}`);
  expect(r.status).toBe(429);
  expect(r.headers.get("retry-after")).toBe("60");
});
