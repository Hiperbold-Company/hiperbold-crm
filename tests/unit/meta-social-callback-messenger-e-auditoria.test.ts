/**
 * Volta do OAuth do Messenger (várias Páginas, nenhuma, recusa parcial), o id
 * de quem autorizou guardado na sessão, e a trilha de falha ANTES de o nonce
 * ser queimado sem a organização do `state` (que pode ser cópia).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso } from "./helpers/meta-social-banco-falso";

const SEGREDO = "segredo-interno-com-mais-de-16-caracteres";
process.env.INTERNAL_SECRET = SEGREDO;
process.env.NEXT_PUBLIC_APP_URL = "https://crm.exemplo";
process.env.META_APP_ID = "12345678";
process.env.META_APP_SECRET = "segredo-do-app-da-meta";
process.env.INSTAGRAM_APP_ID = "IG-APP";
process.env.INSTAGRAM_APP_SECRET = "ig-segredo";

const h = vi.hoisted(() => ({
  db: null as unknown,
  audit: vi.fn(async (_e: Record<string, unknown>) => undefined),
  podeCriar: vi.fn(async () => ({ pode: true })),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit, isServiceRoleConfigured: () => true }));
vi.mock("@/lib/impersonate/support", () => ({ supportCallbackWriteAllowed: async () => true }));
vi.mock("@/lib/billing/planos/pode-criar", () => ({ podeCriar: h.podeCriar }));

import { invalidarAppDaMeta } from "@/lib/channels/meta/app";
import { invalidarConfigMetaSocial } from "@/lib/channels/meta-social/config";
import {
  NOME_DO_VINCULO_META_SOCIAL,
  assinarVinculoMetaSocial,
  emitirEstadoMetaSocial,
} from "@/lib/channels/meta-social/estado";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function metaFalsa(paginas: { id: string; name: string; access_token: string }[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.endsWith("/oauth/access_token")) {
      const corpo = new URLSearchParams(String(init?.body ?? ""));
      return json({ access_token: corpo.get("grant_type") === "fb_exchange_token" ? "longo" : "curto" });
    }
    if (u.includes("/me/accounts")) return json({ data: paginas });
    if (u.includes("/me?fields=id")) return json({ id: "FB-PESSOA" });
    if (u.includes("/subscribed_apps")) return json({ success: true });
    return new Response("{}", { status: 404 });
  });
}

async function chamar(nonce: string, cookie: string | null = assinarVinculoMetaSocial(nonce, SEGREDO), code: string | null = "abc") {
  const state = emitirEstadoMetaSocial(
    { plataforma: "messenger", organizationId: ORG, userId: USER },
    { segredo: SEGREDO, agora: new Date(), nonce },
  );
  const { GET } = await import("@/app/api/v1/channels/meta-social/callback/[plataforma]/route");
  const { NextRequest } = await import("next/server");
  const q = new URLSearchParams({ state, ...(code ? { code } : {}) });
  const req = new NextRequest(`https://crm.exemplo/api/v1/channels/meta-social/callback/messenger?${q}`, {
    headers: cookie ? { cookie: `${NOME_DO_VINCULO_META_SOCIAL}=${cookie}` } : {},
  });
  const res = await GET(req, { params: Promise.resolve({ plataforma: "messenger" }) });
  return new URL(decodeURIComponent(/location\.replace\("([^"]+)"\)/.exec(await res.text())?.[1] ?? ""));
}

const novoBanco = () =>
  bancoFalso({ user_organizations: [{ organization_id: ORG, user_id: USER, role: "admin", revoked_at: null }] });

beforeEach(() => {
  invalidarAppDaMeta();
  invalidarConfigMetaSocial();
  h.audit.mockClear();
  h.podeCriar.mockReset();
  h.podeCriar.mockResolvedValue({ pode: true });
});

describe("callback do Messenger", () => {
  it("várias Páginas: cada uma vira um canal, com o id de quem autorizou", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    vi.stubGlobal(
      "fetch",
      metaFalsa([
        { id: "PAG-1", name: "Loja", access_token: "t1" },
        { id: "PAG-2", name: "Outlet", access_token: "t2" },
      ]),
    );
    const destino = await chamar("m-1");
    expect(destino.searchParams.get("meta_social")).toBe("ok");
    expect(destino.searchParams.get("n")).toBe("2");
    const sessoes = banco.t("channel_sessions");
    expect(sessoes.map((s) => s.meta_social_account_id).sort()).toEqual(["PAG-1", "PAG-2"]);
    for (const s of sessoes) expect((s.metadata as Record<string, unknown>).meta_autorizador_id).toBe("FB-PESSOA");
  });

  it("nenhuma Página concedida: erro nenhuma_pagina", async () => {
    h.db = novoBanco().db;
    vi.stubGlobal("fetch", metaFalsa([]));
    const destino = await chamar("m-2");
    expect(destino.searchParams.get("meta_social")).toBe("erro");
    expect(destino.searchParams.get("motivo")).toBe("nenhuma_pagina");
  });

  it("recusa parcial: volta 'parcial' com quantas entraram, quantas não e o motivo", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    // A segunda Página já está viva em OUTRA organização.
    banco.t("channel_sessions").push({
      id: "da-outra",
      organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      provider: "meta_social",
      meta_social_platform: "messenger",
      meta_social_account_id: "PAG-2",
      archived_at: null,
    });
    vi.stubGlobal(
      "fetch",
      metaFalsa([
        { id: "PAG-1", name: "Loja", access_token: "t1" },
        { id: "PAG-2", name: "Outlet", access_token: "t2" },
      ]),
    );
    const destino = await chamar("m-3");
    expect(destino.searchParams.get("meta_social")).toBe("parcial");
    expect(destino.searchParams.get("n")).toBe("1");
    expect(destino.searchParams.get("recusadas")).toBe("1");
    expect(destino.searchParams.get("motivo")).toBe("conta_em_outra_organizacao");
    expect(banco.t("channel_sessions").filter((s) => s.organization_id === ORG)).toHaveLength(1);
  });

  it("as trocas de token vão por POST, com o segredo no corpo e nunca na URL", async () => {
    h.db = novoBanco().db;
    const fetchFalso = metaFalsa([{ id: "PAG-1", name: "Loja", access_token: "t1" }]);
    vi.stubGlobal("fetch", fetchFalso);
    await chamar("m-4");
    const trocas = fetchFalso.mock.calls.filter(([u]) => String(u).includes("/oauth/access_token"));
    expect(trocas).toHaveLength(2);
    for (const [u, init] of trocas) {
      expect(String(u)).not.toContain("client_secret");
      expect(String(u)).not.toContain("segredo-do-app-da-meta");
      expect((init as RequestInit).method).toBe("POST");
      expect(String((init as RequestInit).body)).toContain("client_secret=segredo-do-app-da-meta");
    }
  });
});

describe("trilha da falha no callback", () => {
  it("antes de queimar o nonce (vínculo de outro navegador): sem a organização do state", async () => {
    h.db = novoBanco().db;
    vi.stubGlobal("fetch", metaFalsa([]));
    const destino = await chamar("m-5", assinarVinculoMetaSocial("outro", SEGREDO));
    expect(destino.searchParams.get("motivo")).toBe("retorno_nao_verificavel");
    expect(h.audit).toHaveBeenCalledTimes(1);
    const evento = h.audit.mock.calls[0]![0];
    expect(evento.organizationId).toBeUndefined();
    expect(evento.actorUserId).toBeUndefined();
  });

  it("depois de queimar o nonce: na organização do state", async () => {
    h.db = novoBanco().db;
    vi.stubGlobal("fetch", metaFalsa([]));
    await chamar("m-6");
    const evento = h.audit.mock.calls.find(([e]) => e.action === "channel.meta_social_connect_failed")![0];
    expect(evento.organizationId).toBe(ORG);
    expect((evento.metadata as Record<string, unknown>).motivo).toBe("nenhuma_pagina");
  });
});
