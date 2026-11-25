/**
 * `POST /api/v1/tags/vocabulario` com `acao: "criar"` — a etiqueta nasce no
 * vocabulário curado (`organizations.settings.tags`) sem passar por contato.
 *
 * O `requireRole` é o de verdade; só as bordas (sessão, papel no banco, leitura
 * do vocabulário, escritor de settings) são dublês.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "00000000-0000-4000-8000-0000000000e6";

const estado = vi.hoisted(() => ({
  papel: "manager",
  settings: {} as Record<string, unknown>,
  vocabulario: [] as { tag: string }[],
}));
const rpc = vi.hoisted(() => vi.fn());
const rpcAdmin = vi.hoisted(() => vi.fn());
const audit = vi.hoisted(() => vi.fn());

const USUARIO = { id: "u1", email: "m@example.com", is_platform_admin: false, support: null, idioma: "pt-BR" };

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => USUARIO,
  requireAuth: async () => USUARIO,
  resolveActiveOrg: async () => ({ orgId: ORG, name: "Org", role: estado.papel }),
  orgAtivaSemPortao: async () => ({ orgId: ORG, name: "Org", role: estado.papel, org_status: "active" }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc,
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: { settings: estado.settings }, error: null });
      return chain;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: rpcAdmin }) }));
vi.mock("@/lib/audit", () => ({ audit }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));

import { POST } from "@/app/api/v1/tags/vocabulario/route";

function postar(corpo: unknown) {
  return POST(
    new NextRequest("http://localhost/api/v1/tags/vocabulario", {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const gravacoes = () => rpcAdmin.mock.calls.filter((c) => c[0] === "fn_atualizar_setting_da_organizacao");

beforeEach(() => {
  estado.papel = "manager";
  estado.settings = {};
  estado.vocabulario = [];
  audit.mockClear();
  rpcAdmin.mockReset();
  rpcAdmin.mockResolvedValue({ data: 1, error: null });
  rpc.mockReset();
  rpc.mockImplementation(async (fn: string) => {
    if (fn === "fn_user_role_in_org") return { data: estado.papel, error: null };
    if (fn === "fn_vocabulario_de_tags_pagina")
      return {
        data: {
          items: estado.vocabulario.map((v) => ({
            tag: v.tag, uso_em_contatos: 0, uso_em_leads: 0, uso_em_conversas: 0,
            em_regras: 0, cor: null, descricao: null, no_vocabulario: true,
          })),
          total: estado.vocabulario.length,
        },
        error: null,
      };
    return { data: null, error: { message: `rpc inesperada: ${fn}` } };
  });
});

describe("criar etiqueta", () => {
  it("cria com nome normalizado e cor, grava só a chave `tags` e audita", async () => {
    const r = await postar({ acao: "criar", tag: "  Cliente VIP ", cor: "#0091FF" });
    expect(r.status).toBe(201);
    expect((await r.json()).data).toEqual({ tag: "cliente vip", cor: "#0091ff" });
    expect(gravacoes()).toHaveLength(1);
    expect(gravacoes()[0]![1]).toEqual({
      p_org: ORG,
      p_caminho: ["tags"],
      p_valor: [{ tag: "cliente vip", cor: "#0091ff" }],
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tag_vocabulary.changed",
        organizationId: ORG,
        metadata: expect.objectContaining({ acao: "criar", tag: "cliente vip" }),
      }),
    );
  });

  it("sem cor grava só o nome; acrescenta ao que já estava no vocabulário curado", async () => {
    estado.settings = { tags: ["antiga", { tag: "outra", cor: "#ff0000" }], routing: { x: 1 } };
    const r = await postar({ acao: "criar", tag: "nova" });
    expect(r.status).toBe(201);
    expect(gravacoes()[0]![1].p_valor).toEqual(["antiga", { tag: "outra", cor: "#ff0000" }, { tag: "nova" }]);
    // outras chaves de settings (routing) nunca são tocadas: o caminho é só ["tags"]
    expect(gravacoes()[0]![1].p_caminho).toEqual(["tags"]);
  });

  it.each(["vip", "VIP", "  Vip  "])("duplicada (%s) já curada no settings é 409 e não grava", async (digitado) => {
    estado.settings = { tags: [{ tag: "vip" }] };
    const r = await postar({ acao: "criar", tag: digitado });
    expect(r.status).toBe(409);
    expect((await r.json()).error.message).toBe("Essa etiqueta já existe.");
    expect(gravacoes()).toHaveLength(0);
  });

  it("duplicada que só existe em uso (fora do curado) também é 409", async () => {
    estado.vocabulario = [{ tag: "Reclamação" }];
    const r = await postar({ acao: "criar", tag: "reclamação" });
    expect(r.status).toBe(409);
    expect(gravacoes()).toHaveLength(0);
  });

  it.each(["", "   "])("nome vazio (%j) é 422", async (tag) => {
    const r = await postar({ acao: "criar", tag });
    expect(r.status).toBe(422);
    expect(gravacoes()).toHaveLength(0);
  });

  it("nome acima de 40 caracteres e cor inválida são 422", async () => {
    expect((await postar({ acao: "criar", tag: "x".repeat(41) })).status).toBe(422);
    expect((await postar({ acao: "criar", tag: "ok", cor: "verde" })).status).toBe(422);
    expect(gravacoes()).toHaveLength(0);
  });

  it("vocabulário com 200 etiquetas curadas recusa com 422", async () => {
    estado.settings = { tags: Array.from({ length: 200 }, (_, i) => ({ tag: `t${i}` })) };
    const r = await postar({ acao: "criar", tag: "mais-uma" });
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("limite_de_etiquetas");
    expect(gravacoes()).toHaveLength(0);
  });

  it.each(["viewer", "agent"])("papel %s é recusado com 403 antes de gravar", async (papel) => {
    estado.papel = papel;
    const r = await postar({ acao: "criar", tag: "nova" });
    expect(r.status).toBe(403);
    expect(gravacoes()).toHaveLength(0);
  });
});
