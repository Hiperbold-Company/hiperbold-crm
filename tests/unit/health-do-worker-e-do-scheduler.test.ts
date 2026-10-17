import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/v1/health/worker e /api/v1/health/scheduler (migration 0961) e o
 * batimento do scheduler gravado pela rota de cron.
 *
 * O admin client é trocado por um falso que se comporta como a tabela: o que o
 * teste mede é a resposta HTTP e o que foi escrito, não o mock.
 */

type Linha = { servico: string; ultimo_em: string } | null;
let linha: Linha = null;
let erroDeLeitura: { message: string } | null = null;
let gravacoes: Array<{ valores: Record<string, unknown>; opcoes: unknown }> = [];
let erroDeEscrita: { message: string } | null = null;
let servicoConsultado: string | null = null;

function montar() {
  vi.doMock("@/lib/env", () => ({
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
      SUPABASE_SERVICE_ROLE_KEY: "chave",
      INTERNAL_CRON_SECRET: "segredo-do-cron-de-teste",
      INTERNAL_SECRET: "",
    },
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    createAdminClient: () => ({
      from: (tabela: string) => {
        expect(tabela).toBe("sistema_batimentos");
        return {
          select: () => ({
            eq: (_coluna: string, valor: string) => {
              servicoConsultado = valor;
              return {
                maybeSingle: async () =>
                  erroDeLeitura ? { data: null, error: erroDeLeitura } : { data: linha, error: null },
              };
            },
          }),
          upsert: async (valores: Record<string, unknown>, opcoes: unknown) => {
            gravacoes.push({ valores, opcoes });
            return { error: erroDeEscrita };
          },
        };
      },
    }),
  }));
}

const ha = (s: number) => new Date(Date.now() - s * 1000).toISOString();

beforeEach(() => {
  vi.resetModules();
  linha = null;
  erroDeLeitura = null;
  erroDeEscrita = null;
  gravacoes = [];
  servicoConsultado = null;
  montar();
});

describe.each([
  ["worker", "@/app/api/v1/health/worker/route"],
  ["scheduler", "@/app/api/v1/health/scheduler/route"],
] as const)("GET /api/v1/health/%s", (servico, caminho) => {
  it("batimento recente: 200, status ok, ultimo_batimento_em e segundos_desde", async () => {
    linha = { servico, ultimo_em: ha(20) };
    const { GET } = await import(caminho);
    const res = await GET();
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.status).toBe("ok");
    expect(corpo.ultimo_batimento_em).toBe(linha.ultimo_em);
    expect(corpo.segundos_desde).toBeGreaterThanOrEqual(19);
    expect(corpo.segundos_desde).toBeLessThanOrEqual(22);
    expect(servicoConsultado).toBe(servico);
  });

  it("batimento velho (> 180 s): 503, status down", async () => {
    linha = { servico, ultimo_em: ha(400) };
    const { GET } = await import(caminho);
    const res = await GET();
    expect(res.status).toBe(503);
    const corpo = await res.json();
    expect(corpo).toMatchObject({ status: "down", motivo: "batimento_atrasado" });
    expect(corpo.segundos_desde).toBeGreaterThan(180);
  });

  it("sem linha nenhuma: 503, sem_batimento", async () => {
    const { GET } = await import(caminho);
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: "down",
      ultimo_batimento_em: null,
      segundos_desde: null,
      motivo: "sem_batimento",
    });
  });

  it("banco fora: 503, leitura_indisponivel, e a mensagem do erro não vaza", async () => {
    erroDeLeitura = { message: "connection to db.interno.exemplo:5432 refused" };
    const { GET } = await import(caminho);
    const res = await GET();
    expect(res.status).toBe(503);
    const texto = JSON.stringify(await res.json());
    expect(texto).toContain("leitura_indisponivel");
    expect(texto).not.toContain("db.interno.exemplo");
  });

  it("nunca em cache, e só carrega as chaves públicas combinadas", async () => {
    linha = { servico, ultimo_em: ha(1) };
    const { GET } = await import(caminho);
    const res = await GET();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(Object.keys(await res.json()).sort()).toEqual(["segundos_desde", "status", "ultimo_batimento_em"]);
  });
});

describe("o proxy deixa passar exatamente estas duas rotas", () => {
  it("public-paths", async () => {
    const { PUBLIC_PATHS } = await import("@/lib/auth/public-paths");
    const publico = (p: string) => PUBLIC_PATHS.some((re) => re.test(p));
    expect(publico("/api/v1/health/worker")).toBe(true);
    expect(publico("/api/v1/health/scheduler")).toBe(true);
    expect(publico("/api/v1/health/outra-coisa")).toBe(false);
    expect(publico("/api/v1/health/worker/x")).toBe(false);
  });
});

describe("batimento do scheduler pela rota de cron", () => {
  vi.setConfig({ testTimeout: 15_000 });

  async function chamarDrain(headers: Record<string, string>) {
    vi.doMock("@/lib/event-log/drain", () => ({ drainEventLog: async () => ({ drained: 0 }) }));
    vi.doMock("@/lib/event-log/register-handlers", () => ({ ensureHandlersRegistered: () => undefined }));
    const { GET } = await import("@/app/api/v1/cron/event-log-drain/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/cron/event-log-drain", { headers }));
    await new Promise((r) => setTimeout(r, 0));
    return res;
  }

  it("cron autorizado grava o batimento do scheduler (upsert por serviço)", async () => {
    const res = await chamarDrain({ authorization: "Bearer segredo-do-cron-de-teste" });
    expect(res.status).toBe(200);
    expect(gravacoes).toHaveLength(1);
    const gravacao = gravacoes[0]!;
    expect(gravacao.valores).toMatchObject({ servico: "scheduler" });
    expect(Date.parse(String(gravacao.valores.ultimo_em))).toBeGreaterThan(Date.now() - 5_000);
    expect(gravacao.opcoes).toEqual({ onConflict: "servico" });
  });

  it("cron NÃO autorizado: 403 e nenhum batimento (senão qualquer um pintaria o scheduler de vivo)", async () => {
    const res = await chamarDrain({ authorization: "Bearer segredo-errado" });
    expect(res.status).toBe(403);
    expect(gravacoes).toHaveLength(0);
  });

  it("sem credencial nenhuma: 403 e nenhum batimento", async () => {
    const res = await chamarDrain({});
    expect(res.status).toBe(403);
    expect(gravacoes).toHaveLength(0);
  });

  it("falha ao gravar o batimento não derruba o cron", async () => {
    erroDeEscrita = { message: "tabela ausente" };
    const res = await chamarDrain({ authorization: "Bearer segredo-do-cron-de-teste" });
    expect(res.status).toBe(200);
  });

  it("chamadas seguidas dentro de 30 s gravam uma vez só", async () => {
    await chamarDrain({ authorization: "Bearer segredo-do-cron-de-teste" });
    await chamarDrain({ authorization: "Bearer segredo-do-cron-de-teste" });
    expect(gravacoes).toHaveLength(1);
  });
});
