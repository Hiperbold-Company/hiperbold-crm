/**
 * Modelos POR CONTA oficial (tela em cartões, várias WABAs na mesma organização, 17/11/2026).
 *
 * - GET com `channel_session_id`: só as linhas daquela conta (oficial = sem conexão de parceiro e com a
 *   WABA da sessão escolhida). Sem id: o espelho inteiro da organização, como antes.
 * - PATCH (link de mídia salvo no modelo) com `channel_session_id`: grava só nas linhas daquela WABA.
 *   Sem id: em todas as linhas do mesmo nome e idioma, como antes.
 *
 * Dublê no banco (que OBEDECE aos filtros), na sessão e nas guardas; a rota é a de verdade.
 * Medir: pnpm vitest run tests/unit/modelos-oficiais-por-conta.test.ts
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Sessao from "@/lib/channels/meta/session";

const CONTA_1 = "11111111-1111-4111-8111-111111111111";
const CONTA_2 = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  sessao: vi.fn(),
  espelho: [] as Record<string, unknown>[],
  atualizados: [] as string[],
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, org: { orgId: "org-1" }, user: { id: "u-1", idioma: "pt-BR" } }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/channels/meta/session", async (original) => ({
  ...(await original<typeof Sessao>()),
  metaSessionForOrg: h.sessao,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const filtros: ((r: Record<string, unknown>) => boolean)[] = [];
      let atualizando = false;
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((r) => r[c] === v), q),
        is: (c: string, v: unknown) => (filtros.push((r) => (r[c] ?? null) === v), q),
        order: () => q,
        update: () => ((atualizando = true), q),
        then: (ok: (r: unknown) => unknown) => {
          const linhas = h.espelho.filter((r) => filtros.every((f) => f(r)));
          if (atualizando) h.atualizados.push(...linhas.map((r) => String(r.id)));
          return ok({ data: linhas, error: null });
        },
      };
      return q;
    },
  }),
}));

import { GET, PATCH } from "@/app/api/v1/channels/templates/route";

const BASE = {
  organization_id: "org-1",
  name: "boas_vindas",
  language: "pt_BR",
  status: "APPROVED",
  category: "MARKETING",
  rejected_reason: null,
  quality_score: null,
  parameter_format: "POSITIONAL",
  contract_hash: "h",
  synced_at: "2026-11-17T00:00:00Z",
  saved_values: {},
  components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Oi" }],
};

beforeEach(() => {
  h.atualizados = [];
  h.espelho = [
    { ...BASE, id: "da-conta-1", channel_session_id: null, waba_id: "WABA-1" },
    { ...BASE, id: "da-conta-2", channel_session_id: null, waba_id: "WABA-2" },
    { ...BASE, id: "do-parceiro", channel_session_id: "sess-parceiro", waba_id: "WABA-P" },
  ];
  h.sessao.mockImplementation(async (_org: string, id?: string) =>
    id === CONTA_2 ? { id: CONTA_2, wabaId: "WABA-2" } : { id: CONTA_1, wabaId: "WABA-1" },
  );
});

const url = (q = "") => `https://crm.test/api/v1/channels/templates${q}`;

describe("GET por conta", () => {
  it("com channel_session_id: só os modelos daquela WABA", async () => {
    const res = await GET(new NextRequest(url(`?channel_session_id=${CONTA_2}`)));
    const corpo = (await res.json()).data;
    expect(corpo.waba).toBe("WABA-2");
    expect(corpo.templates).toHaveLength(1);
    expect(corpo.templates[0].daConexao).toBe(true);
  });

  it("sem id: o espelho inteiro da organização, como antes", async () => {
    const res = await GET(new NextRequest(url()));
    expect((await res.json()).data.templates).toHaveLength(3);
  });
});

describe("PATCH por conta", () => {
  const corpo = JSON.stringify({ name: "boas_vindas", language: "pt_BR", values: { "header:1": "https://x.test/a.png" } });

  it("com channel_session_id: grava só nas linhas daquela WABA", async () => {
    const res = await PATCH(new NextRequest(url(`?channel_session_id=${CONTA_1}`), { method: "PATCH", body: corpo }));
    expect(res.status).toBe(200);
    expect(h.atualizados).toEqual(["da-conta-1"]);
  });

  it("sem id: grava em todas as linhas do mesmo nome e idioma, como antes", async () => {
    const res = await PATCH(new NextRequest(url(), { method: "PATCH", body: corpo }));
    expect(res.status).toBe(200);
    expect(h.atualizados.sort()).toEqual(["da-conta-1", "da-conta-2", "do-parceiro"]);
  });

  it("id que não é conexão oficial desta organização: 404 e nada gravado", async () => {
    h.sessao.mockResolvedValue(null);
    const res = await PATCH(new NextRequest(url(`?channel_session_id=${CONTA_2}`), { method: "PATCH", body: corpo }));
    expect(res.status).toBe(404);
    expect(h.atualizados).toEqual([]);
  });
});
