/**
 * `GET /api/v1/system/instalacao?provar=1` GASTA uma geração real na chave da instalação (20/10/2026).
 *
 * Sem teto, um admin (ou um laço de tela) esgotava o saldo da chave que atende todas as empresas.
 * Agora: 1 prova por minuto, por organização; a segunda devolve 429 com `Retry-After`. As respostas
 * que NÃO gastam (sem chave, ainda conferindo) não consomem o balde.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cena = vi.hoisted(() => ({
  org: "org-a",
  origemDaChave: "instalacao" as "instalacao" | "nenhuma",
  provar: vi.fn(async () => ({ ok: true })),
}));

// Sem Redis: o balde é o contador em memória, determinístico (o .env.local do dev pode ter Upstash).
vi.mock("@/lib/redis-config", () => ({ validarConfigRedisRest: () => ({ ok: false, reason: "ausente" }) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({ ok: true, org: { orgId: cena.org }, user: { idioma: "pt-BR" } })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/channels/selectable", () => ({ listSelectableChannels: vi.fn(async () => []) }));
vi.mock("@/lib/instalacao/retrato", () => ({
  lerRetratoDaInstalacao: vi.fn(async () => ({
    inteligencia: {
      provedor: "openrouter",
      rotulo: "OpenRouter",
      origemDaChave: cena.origemDaChave,
      chaveEmVerificacao: false,
      chaveDaOrg: null,
      modeloCurado: null,
      prontaParaPublicar: true,
    },
  })),
}));
vi.mock("@/lib/instalacao/prova-de-credito", () => ({ provarSaldo: (...a: unknown[]) => cena.provar(...(a as [])) }));
vi.mock("@/lib/ai/modelos-da-instalacao-leitura", () => ({
  modelosDaInstalacao: vi.fn(async () => ["openai/gpt-6-luna"]),
}));

import { GET } from "@/app/api/v1/system/instalacao/route";

const chama = (provar = true) =>
  GET({ nextUrl: new URL(`http://x/api/v1/system/instalacao${provar ? "?provar=1" : ""}`) } as never);

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-instalacao");
  cena.provar.mockClear();
  cena.origemDaChave = "instalacao";
});

describe("?provar=1 — 1 prova por minuto por organização", () => {
  it("a primeira prova roda; a segunda da MESMA organização é 429 com Retry-After e não gasta nada", async () => {
    cena.org = "org-limite-1";
    const a = await chama();
    expect(a.status).toBe(200);
    expect(cena.provar).toHaveBeenCalledTimes(1);

    const b = await chama();
    expect(b.status).toBe(429);
    expect(b.headers.get("Retry-After")).toBe("60");
    expect(((await b.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(cena.provar).toHaveBeenCalledTimes(1);
  });

  it("outra organização tem o balde dela", async () => {
    cena.org = "org-limite-2";
    expect((await chama()).status).toBe(200);
    cena.org = "org-limite-3";
    expect((await chama()).status).toBe(200);
    expect(cena.provar).toHaveBeenCalledTimes(2);
  });

  it("o retrato sem ?provar=1 não passa pelo balde (a tela chama sozinha)", async () => {
    cena.org = "org-limite-4";
    for (let i = 0; i < 3; i++) expect((await chama(false)).status).toBe(200);
    expect(cena.provar).not.toHaveBeenCalled();
  });

  it("resposta que não gasta (sem chave) não consome o balde", async () => {
    cena.org = "org-limite-5";
    cena.origemDaChave = "nenhuma";
    expect((await chama()).status).toBe(200);
    expect((await chama()).status).toBe(200);
    cena.origemDaChave = "instalacao";
    expect((await chama()).status).toBe(200);
    expect(cena.provar).toHaveBeenCalledTimes(1);
  });
});
