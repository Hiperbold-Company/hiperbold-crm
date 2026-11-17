import { describe, expect, it } from "vitest";

import {
  recusaSeConexaoOficialAmbigua,
  temMaisDeUmaConexaoOficialViva,
} from "@/lib/channels/meta/sessao-oficial-viva";

/**
 * Erro da consulta de "tem mais de uma conexão oficial?" NÃO vira "uma só": responder `false` deixaria a
 * rota mutante seguir com "a mais antiga" justamente quando não se sabe quantas existem.
 */
function adminQue(resposta: { data: unknown; error: { code?: string; message?: string } | null }) {
  const cadeia: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "limit"]) cadeia[m] = () => cadeia;
  (cadeia as { then: unknown }).then = (ok: (v: unknown) => unknown) => Promise.resolve(resposta).then(ok);
  return { from: () => cadeia } as never;
}

describe("temMaisDeUmaConexaoOficialViva", () => {
  it("lança quando a consulta falha, em vez de dizer que há uma só", async () => {
    const admin = adminQue({ data: null, error: { code: "XX000", message: "banco fora" } });
    await expect(temMaisDeUmaConexaoOficialViva(admin, "org-1")).rejects.toThrow(/banco fora/);
  });

  it("sem erro, conta de verdade", async () => {
    expect(await temMaisDeUmaConexaoOficialViva(adminQue({ data: [{ id: "a" }, { id: "b" }], error: null }), "o")).toBe(true);
    expect(await temMaisDeUmaConexaoOficialViva(adminQue({ data: [{ id: "a" }], error: null }), "o")).toBe(false);
  });
});

describe("recusaSeConexaoOficialAmbigua", () => {
  it("consulta com erro responde 500, nunca segue como se fosse uma conexão só", async () => {
    const admin = adminQue({ data: null, error: { code: "XX000", message: "banco fora" } });
    const res = await recusaSeConexaoOficialAmbigua({ admin, organizationId: "org-1", requestId: "r1" });
    expect(res?.status).toBe(500);
  });

  it("com id informado nem consulta", async () => {
    const admin = adminQue({ data: null, error: { code: "XX000", message: "x" } });
    expect(await recusaSeConexaoOficialAmbigua({ admin, organizationId: "o", channelSessionId: "id" })).toBeNull();
  });

  it("duas conexões vivas sem id: 422 de sempre", async () => {
    const admin = adminQue({ data: [{ id: "a" }, { id: "b" }], error: null });
    const res = await recusaSeConexaoOficialAmbigua({ admin, organizationId: "o" });
    expect(res?.status).toBe(422);
  });
});
