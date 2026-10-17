import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rota da exclusão dos dados depois do cancelamento: sem segredo 403 e nada roda; rodada vazia não audita (é
 * diária, mas o princípio é o de `cron-audita-so-quando-ha-efeito`); rodada que programou ou cancelou por
 * reativação deixa rastro; erro devolve frase fixa, com o texto só no log.
 */
const SEGREDO = "segredo-da-exclusao";
const rodar = vi.fn();
const auditar = vi.fn();
const error = vi.fn();

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "segredo-da-exclusao", INTERNAL_SECRET: "" } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => error(...a), debug: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditar(...a) }));
let configurado = "120";
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: configurado, fonte: "banco" }) }));
vi.mock("@/lib/retencao/exclusao-de-organizacao/rodada", () => ({ rodarExclusaoDeDados: (...a: unknown[]) => rodar(...a) }));

import { GET, POST } from "@/app/api/v1/cron/exclusao-de-dados/route";

const VAZIO = {
  sincronizacaoFalhou: false, programadas: 0, atualizadas: 0, canceladasPorReativacao: 0, adiadasParaAvisar: 0,
  avisosEnfileirados: 0, vencidas: 0, excluidas: 0, falhas: 0, fiscaisExpurgados: 0,
};
const chamar = (segredo = SEGREDO, metodo: typeof GET = GET) =>
  metodo(new NextRequest("http://local/api/v1/cron/exclusao-de-dados", { headers: segredo ? { authorization: `Bearer ${segredo}` } : {} }));

beforeEach(() => {
  rodar.mockReset();
  auditar.mockReset();
  error.mockReset();
  configurado = "120";
});

describe("GET/POST /api/v1/cron/exclusao-de-dados", () => {
  it("sem segredo ou com segredo errado: 403 e nada roda", async () => {
    expect((await chamar("")).status).toBe(403);
    expect((await chamar("outro")).status).toBe(403);
    expect(rodar).not.toHaveBeenCalled();
  });

  it("usa os dias da configuração e devolve o resumo (GET e POST)", async () => {
    rodar.mockResolvedValue(VAZIO);
    for (const m of [GET, POST]) {
      const res = await chamar(SEGREDO, m);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: typeof VAZIO }).data).toEqual(VAZIO);
    }
    expect(rodar.mock.calls[0]?.[1]).toMatchObject({ diasDeGuarda: 120 });
  });

  it("configuração inválida (30, lixo, 366): 500 e a rodada NÃO roda, nem para programar ou excluir", async () => {
    for (const ruim of ["30", "noventa", "366", "90.5"]) {
      configurado = ruim;
      const res = await chamar();
      expect(res.status, ruim).toBe(500);
    }
    expect(rodar).not.toHaveBeenCalled();
    expect(auditar).not.toHaveBeenCalled();
  });

  it("configuração vazia vale 90", async () => {
    rodar.mockResolvedValue(VAZIO);
    configurado = "";
    await chamar();
    expect(rodar.mock.calls[0]?.[1]).toMatchObject({ diasDeGuarda: 90 });
  });

  it("rodada vazia não audita", async () => {
    rodar.mockResolvedValue({ ...VAZIO, avisosEnfileirados: 2 });
    await chamar();
    expect(auditar).not.toHaveBeenCalled();
  });

  it("rodada que programou audita a programação; a que cancelou por reativação audita o cancelamento", async () => {
    rodar.mockResolvedValue({ ...VAZIO, programadas: 2, canceladasPorReativacao: 1 });
    await chamar();
    expect(auditar.mock.calls.map((c) => (c[0] as { action: string }).action).sort()).toEqual([
      "org.deletion_cancelled",
      "org.deletion_scheduled",
    ]);
  });

  it("erro: 500 com frase fixa, sem o texto do banco no corpo", async () => {
    rodar.mockRejectedValue(new Error("relation org_exclusoes_programadas does not exist"));
    const res = await chamar();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("org_exclusoes_programadas");
    expect(error).toHaveBeenCalled();
  });
});
