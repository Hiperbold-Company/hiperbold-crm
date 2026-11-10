/**
 * O gatilho da 1005 (`fn_regra_convertida_nao_religa`) recusa religar uma regra que já virou automação ligada,
 * com o código PT409. A operação traduz para 409 com texto legível (e não para 500), na língua de quem pede.
 *
 * Roda `alterarRegra` DE VERDADE com um banco falso que devolve o erro do Postgres.
 */
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/types";

import { alterarRegra, MENSAGEM_DA_REGRA_CONVERTIDA, type DepsDeRegras } from "./regras-automaticas-admin";

function bancoQueRecusaAoAtualizar(erro: { code?: string; message: string }): DepsDeRegras["supabase"] {
  const leitura = {
    select: () => leitura,
    eq: () => leitura,
    maybeSingle: () =>
      Promise.resolve({
        data: { id: "r1", trigger_event: "lead.created", trigger_config: null, actions: [] },
        error: null,
      }),
  };
  const escrita = {
    eq: () => escrita,
    select: () => escrita,
    single: () => Promise.resolve({ data: null, error: erro }),
  };
  return {
    from: () => ({ select: leitura.select, update: () => escrita }),
  } as unknown as DepsDeRegras["supabase"];
}

const deps = (erro: { code?: string; message: string }, t?: (s: string) => string) =>
  ({
    supabase: bancoQueRecusaAoAtualizar(erro),
    admin: {} as DepsDeRegras["admin"],
    organizationId: "org-1",
    actor: { type: "user", id: "u-1" },
    responsavel: "u-1",
    requestId: "req-1",
    t,
  }) as unknown as DepsDeRegras;

async function recusaDe(d: DepsDeRegras): Promise<ApiError> {
  try {
    await alterarRegra(d, "r1", { is_active: true });
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("deveria ter recusado");
}

describe("alterarRegra: religar regra já convertida em automação ligada", () => {
  it("PT409 do gatilho vira 409 com a mensagem legível", async () => {
    const err = await recusaDe(deps({ code: "PT409", message: "regra_convertida_com_automacao_ligada" }));
    expect(err.status).toBe(409);
    expect(err.code).toBe("rule_converted_to_automation");
    expect(err.message).toBe("Esta regra foi convertida em uma automação. Desligue a automação antes de religar a regra.");
    expect(err.message).toBe(MENSAGEM_DA_REGRA_CONVERTIDA);
  });

  it("a mensagem passa pelo tradutor de quem pediu (en/es)", async () => {
    const err = await recusaDe(
      deps({ code: "PT409", message: "x" }, (texto) => `[en] ${texto}`),
    );
    expect(err.message).toBe(`[en] ${MENSAGEM_DA_REGRA_CONVERTIDA}`);
  });

  it("qualquer outro erro do banco continua sendo 500 interno (não vira 409)", async () => {
    const err = await recusaDe(deps({ code: "23505", message: "duplicate key" }));
    expect(err.status).toBe(500);
    expect(err.code).toBe("internal_error");
  });
});
