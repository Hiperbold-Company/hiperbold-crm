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

const gravacoes = () => rpcAdmin.mock.calls.filter((c) => c[0] === "fn_acrescentar_etiqueta_ao_vocabulario");

/**
 * Dublê do contrato da função do banco: serializa as chamadas (a linha travada), recusa
 * duplicata (caixa/aparo) e teto, e acrescenta sobre o estado que a chamada anterior deixou.
 * A prova no banco real (duas sessões) está em tests/invariants/etiqueta-acrescentada-atomica.test.ts.
 */
function funcaoAtomicaDoBanco() {
  let fila: Promise<unknown> = Promise.resolve();
  rpcAdmin.mockImplementation((fn: string, args: { p_nome: string; p_cor: string | null; p_teto: number }) => {
    const rodar = async () => {
      await new Promise((r) => setTimeout(r, 5)); // a janela em que o ler→gravar antigo perdia
      const lista = Array.isArray(estado.settings.tags) ? (estado.settings.tags as unknown[]) : [];
      const nomeDe = (e: unknown) =>
        (typeof e === "string" ? e : ((e as { tag?: string } | null)?.tag ?? "")).trim().toLowerCase();
      if (lista.some((e) => nomeDe(e) === args.p_nome)) return { data: "ja_existe", error: null };
      if (lista.length >= args.p_teto) return { data: "limite", error: null };
      estado.settings = {
        ...estado.settings,
        tags: [...lista, args.p_cor ? { tag: args.p_nome, cor: args.p_cor } : { tag: args.p_nome }],
      };
      return { data: "criada", error: null };
    };
    const r = fn === "fn_acrescentar_etiqueta_ao_vocabulario" ? fila.then(rodar) : Promise.resolve({ data: null, error: { message: fn } });
    fila = r.catch(() => undefined);
    return r;
  });
}

beforeEach(() => {
  estado.papel = "manager";
  estado.settings = {};
  estado.vocabulario = [];
  audit.mockClear();
  rpcAdmin.mockReset();
  funcaoAtomicaDoBanco();
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
    expect(gravacoes()[0]![1]).toEqual({ p_org: ORG, p_nome: "cliente vip", p_cor: "#0091ff", p_teto: 200 });
    expect(estado.settings.tags).toEqual([{ tag: "cliente vip", cor: "#0091ff" }]);
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
    expect(estado.settings.tags).toEqual(["antiga", { tag: "outra", cor: "#ff0000" }, { tag: "nova" }]);
    expect(estado.settings.routing).toEqual({ x: 1 });
  });

  it.each(["vip", "VIP", "  Vip  "])("duplicada (%s) já curada no settings é 409 e não grava", async (digitado) => {
    estado.settings = { tags: [{ tag: "vip" }] };
    const r = await postar({ acao: "criar", tag: digitado });
    expect(r.status).toBe(409);
    expect((await r.json()).error.message).toBe("Essa etiqueta já existe.");
    expect(estado.settings.tags).toEqual([{ tag: "vip" }]);
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
    expect(estado.settings.tags).toHaveLength(200);
  });

  it("duas criações simultâneas: nenhuma se perde e a repetida vira 409", async () => {
    const [a, b, c] = await Promise.all([
      postar({ acao: "criar", tag: "alfa" }),
      postar({ acao: "criar", tag: "beta", cor: "#00ff00" }),
      postar({ acao: "criar", tag: "ALFA" }),
    ]);
    expect([a.status, b.status, c.status].sort()).toEqual([201, 201, 409]);
    expect((estado.settings.tags as { tag: string }[]).map((e) => e.tag).sort()).toEqual(["alfa", "beta"]);
  });

  it.each(["viewer", "agent"])("papel %s é recusado com 403 antes de gravar", async (papel) => {
    estado.papel = papel;
    const r = await postar({ acao: "criar", tag: "nova" });
    expect(r.status).toBe(403);
    expect(gravacoes()).toHaveLength(0);
  });
});
