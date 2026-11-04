/**
 * Hiperbold: a régua de cobrança própria decide se a exclusão manual está liberada. Roda a leitura de verdade
 * (`estadoDaAssinatura`) sobre um cliente Supabase falso, que é a fronteira: só o que o banco devolveria é
 * substituído.
 */
import { describe, expect, it } from "vitest";

import { MENSAGEM_COBRANCA_ILEGIVEL, MENSAGEM_NA_REGUA, reguaDaCobrancaPermiteExcluir } from "./regua-de-cobranca";

const ORG = "7e0a0000-0000-4000-8000-0000000000ee";

interface Banco {
  contrato?: { status: string; current_period_end?: string | null; cycle?: string | null } | null;
  erroNoContrato?: boolean;
  erroNoModo?: boolean;
}

function bancoFalso(b: Banco) {
  return {
    from(tabela: string) {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.maybeSingle = async () => {
        if (tabela === "billing_contracts") {
          if (b.erroNoContrato) return { data: null, error: { message: "timeout" } };
          const contrato = b.contrato === undefined ? null : b.contrato;
          return {
            data: contrato && {
              cycle: "mensal",
              current_period_start: "2026-10-01T03:00:00.000Z",
              current_period_end: "2026-11-01T03:00:00.000Z",
              cancel_at_period_end: false,
              billing_plans: { grace_days: 7 },
              ...contrato,
            },
            error: null,
          };
        }
        if (tabela === "billing_settings") {
          if (b.erroNoModo) return { data: null, error: { message: "timeout" } };
          return { data: { modo: "avisar" }, error: null };
        }
        throw new Error(`tabela inesperada: ${tabela}`);
      };
      return c;
    },
    rpc: async () => ({ data: false, error: null }),
  };
}

const conferir = (b: Banco) => reguaDaCobrancaPermiteExcluir(bancoFalso(b) as never, ORG);

describe("régua de cobrança na exclusão manual", () => {
  it.each(["atrasada", "suspensa"])("contrato %s (no meio da régua): recusa com a mensagem", async (status) => {
    expect(await conferir({ contrato: { status } })).toEqual({
      liberada: false,
      codigo: "exclusao_na_regua_de_cobranca",
      mensagem: MENSAGEM_NA_REGUA,
      estado: status,
    });
  });

  it("a mensagem é a combinada com o dono do produto", () => {
    expect(MENSAGEM_NA_REGUA).toBe(
      "Esta empresa está na régua de cobrança; a exclusão só é liberada quando a régua termina.",
    );
  });

  it("contrato cancelado (a régua terminou): libera", async () => {
    expect(await conferir({ contrato: { status: "cancelada" } })).toEqual({ liberada: true });
  });

  it.each(["ativa", "avaliacao"])("contrato %s (sem inadimplência, ex. suspensa pelo admin): libera", async (status) => {
    expect(await conferir({ contrato: { status } })).toEqual({ liberada: true });
  });

  it("sem plano (nasceu suspensa, sem período nem ciclo, nunca pagou): libera, não há dívida", async () => {
    expect(await conferir({ contrato: { status: "suspensa", current_period_end: null, cycle: null } })).toEqual({
      liberada: true,
    });
  });

  it("sem contrato (organização de teste): libera", async () => {
    expect(await conferir({ contrato: null })).toEqual({ liberada: true });
  });

  it("leitura do contrato falha: recusa (exclusão é irreversível)", async () => {
    expect(await conferir({ erroNoContrato: true })).toEqual({
      liberada: false,
      codigo: "cobranca_ilegivel",
      mensagem: MENSAGEM_COBRANCA_ILEGIVEL,
      estado: null,
    });
  });

  it("leitura do modo de cobrança falha: recusa também", async () => {
    const r = await conferir({ contrato: { status: "ativa" }, erroNoModo: true });
    expect(r).toMatchObject({ liberada: false, codigo: "cobranca_ilegivel" });
  });
});
