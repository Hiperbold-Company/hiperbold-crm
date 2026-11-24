import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chave do redesign POR EMPRESA (fase 1 do lançamento: só o admin da
 * plataforma liga, empresa por empresa).
 *
 * Regra: chave geral da instalação (`REDESIGN_HIPERBOLD=ligado`) OU
 * `organizations.settings.redesign.ligado === true` da empresa ativa.
 * Sem sessão, sem empresa, ou qualquer falha: desligado — nunca lança, porque
 * a raiz (`app/layout.tsx`) depende dela em todas as telas.
 */

const h = vi.hoisted(() => ({
  envValor: "desligado" as string,
  usuario: { id: "u1" } as Record<string, unknown> | null,
  org: { orgId: "org-a" } as Record<string, unknown> | null,
  settings: {} as unknown,
  falharUsuario: false,
  falharOrg: false,
  falharLeitura: false,
  leituras: 0,
  caminho: "/app/inbox" as string | null,
  leuUsuario: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.caminho === null ? {} : { "x-pathname": h.caminho }),
}));
vi.mock("@/lib/env", () => ({
  env: new Proxy({}, { get: (_t, k) => (k === "REDESIGN_HIPERBOLD" ? h.envValor : undefined) }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => {
    h.leuUsuario += 1;
    if (h.falharUsuario) throw new Error("sessão quebrou");
    return h.usuario;
  },
  orgAtivaSemPortao: async () => {
    if (h.falharOrg) throw new Error("org quebrou");
    return h.org;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = async () => {
        h.leituras += 1;
        if (h.falharLeitura) return { data: null, error: { message: "banco fora" } };
        return { data: { settings: h.settings }, error: null };
      };
      return c;
    },
  }),
}));

import { redesignDaEmpresa, redesignNaRequisicao } from "./chave";

beforeEach(() => {
  h.envValor = "desligado";
  h.usuario = { id: "u1" };
  h.org = { orgId: "org-a" };
  h.settings = {};
  h.falharUsuario = false;
  h.falharOrg = false;
  h.falharLeitura = false;
  h.leituras = 0;
  h.caminho = "/app/inbox";
  h.leuUsuario = 0;
});

describe("redesignDaEmpresa (regra pura sobre settings)", () => {
  it("só `redesign.ligado === true` liga", () => {
    expect(redesignDaEmpresa({ redesign: { ligado: true } })).toBe(true);
  });
  it.each([
    ["settings nulo", null],
    ["settings vazio", {}],
    ["redesign ausente", { branding: {} }],
    ["ligado false", { redesign: { ligado: false } }],
    ["ligado como texto", { redesign: { ligado: "true" } }],
    ["ligado como 1", { redesign: { ligado: 1 } }],
    ["redesign como booleano solto", { redesign: true }],
    ["settings não-objeto", "ligado"],
  ])("%s → desligado", (_nome, settings) => {
    expect(redesignDaEmpresa(settings)).toBe(false);
  });
});

describe("redesignNaRequisicao (env × empresa × sessão × falha)", () => {
  it("chave geral ligada liga sem consultar a empresa", async () => {
    h.envValor = "ligado";
    h.usuario = null;
    expect(await redesignNaRequisicao()).toBe(true);
    expect(h.leituras).toBe(0);
  });

  it("geral desligada + empresa ligada → ligado", async () => {
    h.settings = { redesign: { ligado: true } };
    expect(await redesignNaRequisicao()).toBe(true);
  });

  it("geral desligada + empresa desligada → desligado", async () => {
    h.settings = { redesign: { ligado: false } };
    expect(await redesignNaRequisicao()).toBe(false);
  });

  it("geral desligada + empresa sem a chave → desligado", async () => {
    expect(await redesignNaRequisicao()).toBe(false);
  });

  it("sem sessão (visitante) → desligado, sem ler o banco", async () => {
    h.usuario = null;
    expect(await redesignNaRequisicao()).toBe(false);
    expect(h.leituras).toBe(0);
  });

  it("logado sem empresa → desligado, sem ler o banco", async () => {
    h.org = null;
    expect(await redesignNaRequisicao()).toBe(false);
    expect(h.leituras).toBe(0);
  });

  it.each([
    ["sessão lança", () => (h.falharUsuario = true)],
    ["empresa lança", () => (h.falharOrg = true)],
    ["leitura do banco falha", () => (h.falharLeitura = true)],
  ])("%s → desligado, nunca lança", async (_nome, preparar) => {
    h.settings = { redesign: { ligado: true } };
    preparar();
    await expect(redesignNaRequisicao()).resolves.toBe(false);
  });

  // Telas públicas: o proxy NÃO renova a sessão nelas (`isPublicPath` → segue
  // direto). Ler a sessão num Server Component dessas telas pode girar o
  // refresh token sem conseguir gravar o cookie novo e deslogar a pessoa depois.
  // Por isso, nelas vale só a chave geral, e a sessão nem é lida.
  it.each(["/login", "/legal/privacy", "/403"])(
    "tela pública (%s) → só a chave geral, sem ler a sessão",
    async (caminho) => {
      h.caminho = caminho;
      h.settings = { redesign: { ligado: true } };
      expect(await redesignNaRequisicao()).toBe(false);
      expect(h.leuUsuario).toBe(0);
    },
  );

  it("tela pública com a chave geral ligada → ligado", async () => {
    h.caminho = "/login";
    h.envValor = "ligado";
    expect(await redesignNaRequisicao()).toBe(true);
  });

  it("sem o cabeçalho de caminho do proxy → desligado, sem ler a sessão", async () => {
    h.caminho = null;
    h.settings = { redesign: { ligado: true } };
    expect(await redesignNaRequisicao()).toBe(false);
    expect(h.leuUsuario).toBe(0);
  });
});
