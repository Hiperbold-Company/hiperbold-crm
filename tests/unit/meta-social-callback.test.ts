/**
 * Volta do OAuth do Instagram: state + vínculo + nonce de uso único, contra o
 * banco em memória (nonce único real) e a Meta dublada por `fetch`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso } from "./helpers/meta-social-banco-falso";

const SEGREDO = "segredo-interno-com-mais-de-16-caracteres";
process.env.INTERNAL_SECRET = SEGREDO;
process.env.NEXT_PUBLIC_APP_URL = "https://crm.exemplo";
process.env.INSTAGRAM_APP_ID = "IG-APP";
process.env.INSTAGRAM_APP_SECRET = "ig-segredo";

const h = vi.hoisted(() => ({ db: null as unknown, audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit, isServiceRoleConfigured: () => true }));
vi.mock("@/lib/impersonate/support", () => ({ supportCallbackWriteAllowed: async () => true }));

import { invalidarConfigMetaSocial } from "@/lib/channels/meta-social/config";
import {
  NOME_DO_VINCULO_META_SOCIAL,
  assinarVinculoMetaSocial,
  emitirEstadoMetaSocial,
} from "@/lib/channels/meta-social/estado";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function metaFalsa() {
  return vi.fn(async (url: string) => {
    const u = String(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.includes("api.instagram.com/oauth/access_token")) return json({ access_token: "curto", user_id: 1 });
    if (u.includes("/access_token?grant_type=ig_exchange_token")) return json({ access_token: "longo", expires_in: 5_184_000 });
    if (u.includes("/me?fields=user_id")) return json({ user_id: "IG-CONTA", username: "loja" });
    if (u.includes("/subscribed_apps")) return json({ success: true });
    return new Response("{}", { status: 404 });
  });
}

async function chamar(state: string, cookie: string | null) {
  const { GET } = await import("@/app/api/v1/channels/meta-social/callback/[plataforma]/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    `https://crm.exemplo/api/v1/channels/meta-social/callback/instagram?code=abc&state=${encodeURIComponent(state)}`,
    { headers: cookie ? { cookie: `${NOME_DO_VINCULO_META_SOCIAL}=${cookie}` } : {} },
  );
  const res = await GET(req, { params: Promise.resolve({ plataforma: "instagram" }) });
  const html = await res.text();
  return decodeURIComponent(/location\.replace\("([^"]+)"\)/.exec(html)?.[1] ?? "");
}

beforeEach(() => {
  invalidarConfigMetaSocial();
  h.audit.mockClear();
  vi.stubGlobal("fetch", metaFalsa());
});

describe("callback do Instagram", () => {
  const novoBanco = () =>
    bancoFalso({ user_organizations: [{ organization_id: ORG, user_id: USER, role: "admin", revoked_at: null }] });

  it("conecta a conta na organização do state e queima o nonce: o replay é recusado", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    const state = emitirEstadoMetaSocial(
      { plataforma: "instagram", organizationId: ORG, userId: USER },
      { segredo: SEGREDO, agora: new Date(), nonce: "n-1" },
    );
    const cookie = assinarVinculoMetaSocial("n-1", SEGREDO);

    expect(await chamar(state, cookie)).toContain("meta_social=ok");
    const sessoes = banco.t("channel_sessions");
    expect(sessoes).toHaveLength(1);
    expect(sessoes[0]).toMatchObject({
      organization_id: ORG,
      provider: "meta_social",
      meta_social_platform: "instagram",
      meta_social_account_id: "IG-CONTA",
      meta_social_token_encrypted: "cifrado:longo",
      status: "WORKING",
    });
    // O user_id da troca do código: é por ele que a exclusão de dados acha a sessão.
    expect((sessoes[0]!.metadata as Record<string, unknown>).meta_autorizador_id).toBe("1");

    const replay = await chamar(state, cookie);
    expect(replay).toContain("meta_social=erro");
    expect(replay).toContain("motivo=retorno_nao_verificavel");
    expect(banco.t("channel_sessions")).toHaveLength(1);
  });

  it("vínculo de outro navegador não conecta", async () => {
    const banco = novoBanco();
    h.db = banco.db;
    const state = emitirEstadoMetaSocial(
      { plataforma: "instagram", organizationId: ORG, userId: USER },
      { segredo: SEGREDO, agora: new Date(), nonce: "n-2" },
    );
    const destino = await chamar(state, assinarVinculoMetaSocial("outro-nonce", SEGREDO));
    expect(destino).toContain("motivo=retorno_nao_verificavel");
    expect(banco.t("channel_sessions")).toHaveLength(0);
  });

  it("quem deixou de ser admin da organização não conecta", async () => {
    const banco = bancoFalso({
      user_organizations: [{ organization_id: ORG, user_id: USER, role: "agent", revoked_at: null }],
    });
    h.db = banco.db;
    const state = emitirEstadoMetaSocial(
      { plataforma: "instagram", organizationId: ORG, userId: USER },
      { segredo: SEGREDO, agora: new Date(), nonce: "n-3" },
    );
    expect(await chamar(state, assinarVinculoMetaSocial("n-3", SEGREDO))).toContain("motivo=sem_permissao");
    expect(banco.t("channel_sessions")).toHaveLength(0);
  });

  it("conta ativa em OUTRA organização é recusada", async () => {
    const banco = novoBanco();
    banco.t("channel_sessions").push({
      id: "da-outra",
      organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      provider: "meta_social",
      meta_social_platform: "instagram",
      meta_social_account_id: "IG-CONTA",
      archived_at: null,
    });
    h.db = banco.db;
    const state = emitirEstadoMetaSocial(
      { plataforma: "instagram", organizationId: ORG, userId: USER },
      { segredo: SEGREDO, agora: new Date(), nonce: "n-4" },
    );
    expect(await chamar(state, assinarVinculoMetaSocial("n-4", SEGREDO))).toContain(
      "motivo=conta_em_outra_organizacao",
    );
    expect(banco.t("channel_sessions")).toHaveLength(1);
  });
});
