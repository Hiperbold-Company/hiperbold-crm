// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A LOGO DA EMPRESA NO SELETOR DE ORGANIZAÇÕES — com ou sem o módulo de marca.
 *
 * Toda empresa pode enviar a própria logo (Configurações › Organização), e ela
 * vira o avatar redondo da empresa no seletor do menu. Três coisas precisam
 * valer juntas:
 *
 *  (1) a lista de organizações que `loadAuthUser` monta traz `logo_url` a partir
 *      de `settings.branding.logo_path`, com o módulo `marca_por_organizacao`
 *      LIGADO ou DESLIGADO (a leitura nem pergunta ao módulo);
 *  (2) o resolvedor nunca lança e recusa caminho fora do prefixo da empresa;
 *  (3) a MARCA DO PRODUTO continua sem a camada da organização com o módulo
 *      desligado, mesmo havendo `logo_path` gravado: o avatar não repinta o shell.
 *
 * O Supabase é substituído só na borda (a resposta do PostgREST e do GoTrue);
 * quem monta a lista e resolve a URL é o código real.
 */

const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "55555555-5555-4555-8555-555555555555";
const LOGO_A = `${ORG_A}/44444444-4444-4444-8444-444444444444.png`;
const BASE = "http://supabase.local";

const estado = {
  moduloLigado: false,
  selects: [] as string[],
  linhas: [] as unknown[],
  userId: "11111111-1111-4111-8111-111111111111",
};

const tabelasLidas: string[] = [];

function consulta(tabela: string) {
  tabelasLidas.push(tabela);
  const c: Record<string, unknown> = {};
  for (const m of ["eq", "is", "order", "in"]) c[m] = () => c;
  c.select = (colunas: string) => {
    if (tabela === "user_organizations") estado.selects.push(colunas);
    return c;
  };
  c.maybeSingle = async () => ({ data: null, error: null });
  const dados =
    tabela === "user_organizations"
      ? estado.linhas
      : tabela === "platform_config" && estado.moduloLigado
        ? [{ chave: "MODULO_MARCA_POR_ORGANIZACAO", valor: "ligado" }]
        : [];
  c.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: dados, error: null }).then(ok);
  return c;
}

function clienteFalso() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: { id: estado.userId, email: "a@b.c", user_metadata: {}, app_metadata: {} } },
        error: null,
      }),
    },
    from: (tabela: string) => consulta(tabela),
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (para: string) => {
    throw new Error(`NEXT_REDIRECT:${para}`);
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "http://supabase.local",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    IMPERSONATE_COOKIE_SECRET: "x".repeat(32),
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clienteFalso() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => clienteFalso() }));

process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;

const { loadAuthUser } = await import("@/lib/auth/server");
const { invalidarUsuario } = await import("@/lib/auth/cache-curto");
const { logoDaEmpresa } = await import("@/lib/branding/logo-da-empresa");
const { resolverMarcaDaOrganizacao } = await import("@/lib/branding/organizacao");

function linha(orgId: string, nome: string, logoPath: unknown) {
  return {
    organization_id: orgId,
    role: "admin",
    interface_settings: null,
    accepted_at: null,
    organizations: {
      display_name: nome,
      locale: "pt-BR",
      timezone: null,
      currency: null,
      country: null,
      status: "active",
      suspended_kind: null,
      permissoes: null,
      logo_path: logoPath,
    },
    interface_da_empresa: { interface_settings: null },
  };
}

let contador = 0;
beforeEach(() => {
  // Um usuário por caso: o snapshot de vínculos tem cache curto por pessoa.
  contador += 1;
  estado.userId = `11111111-1111-4111-8111-${String(contador).padStart(12, "0")}`;
  invalidarUsuario(estado.userId);
  estado.selects = [];
  estado.linhas = [linha(ORG_A, "Clínica da Ana", LOGO_A), linha(ORG_B, "Loja do Beto", null)];
});

describe("(1) a lista de organizações traz logo_url", () => {
  it("a consulta pede só o caminho da logo do jsonb, nunca `settings` inteiro", async () => {
    await loadAuthUser();
    expect(estado.selects.join(" ")).toContain("logo_path:settings->branding->>logo_path");
    expect(estado.selects.join(" ")).not.toMatch(/[(,]\s*settings\s*[,)]/);
  });

  it.each([
    ["DESLIGADO", false],
    ["LIGADO", true],
  ])("módulo %s: a empresa com logo sai com a URL pública; a sem logo sai null", async (_rotulo, ligado) => {
    estado.moduloLigado = ligado;
    const user = await loadAuthUser();
    const porId = new Map(user!.organizations.map((o) => [o.organization_id, o.logo_url]));
    expect(porId.get(ORG_A)).toBe(`${BASE}/storage/v1/object/public/brand-logos/${LOGO_A}`);
    expect(porId.get(ORG_B)).toBeNull();
  });

  it("a montagem da lista não lê módulo nenhum: a logo independe de marca_por_organizacao", async () => {
    tabelasLidas.length = 0;
    await loadAuthUser();
    expect(tabelasLidas).toContain("user_organizations");
    expect(tabelasLidas).not.toContain("platform_config");
    expect(tabelasLidas).not.toContain("modulos_instalados");
  });

  it("caminho de OUTRA empresa gravado à mão não vira avatar desta", async () => {
    estado.linhas = [linha(ORG_B, "Loja do Beto", LOGO_A)];
    const user = await loadAuthUser();
    expect(user!.organizations[0]!.logo_url).toBeNull();
  });
});

describe("(2) logoDaEmpresa nunca lança", () => {
  it.each([
    ["número", 7],
    ["objeto", { a: 1 }],
    ["vazio", "   "],
    ["instalação", "platform/33333333-3333-4333-8333-333333333333.png"],
    ["fuga de pasta", `${ORG_A}/../platform/x.png`],
    ["svg", `${ORG_A}/44444444-4444-4444-8444-444444444444.svg`],
  ])("%s vira null", (_rotulo, caminho) => {
    expect(logoDaEmpresa(ORG_A, caminho, BASE)).toBeNull();
  });

  it("sem base do storage vira null, e com barra final não dobra a barra", () => {
    expect(logoDaEmpresa(ORG_A, LOGO_A, "")).toBeNull();
    expect(logoDaEmpresa(ORG_A, LOGO_A, `${BASE}/`)).toBe(
      `${BASE}/storage/v1/object/public/brand-logos/${LOGO_A}`,
    );
  });
});

describe("(3) a marca do produto não ganha a logo da empresa com o módulo desligado", () => {
  const INSTALACAO = { app_name: "Sistema", logo_url: null, accent_hex: "#2563eb" };
  const AMBIENTE = { APP_NAME: "Do env" };
  const SETTINGS = { branding: { logo_path: LOGO_A } };

  it("DESLIGADO: logo_path gravado não entra na pilha da marca", () => {
    const marca = resolverMarcaDaOrganizacao(SETTINGS, INSTALACAO, AMBIENTE, false);
    expect(marca.origens.logoUrl).not.toBe("organizacao");
    expect(marca.logoUrl ?? "").not.toContain(LOGO_A);
  });

  it("LIGADO: a mesma logo vira a marca (prova que a flag é quem decide)", () => {
    const marca = resolverMarcaDaOrganizacao(SETTINGS, INSTALACAO, AMBIENTE, true);
    expect(marca.origens.logoUrl).toBe("organizacao");
  });
});
