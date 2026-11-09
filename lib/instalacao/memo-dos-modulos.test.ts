/**
 * O memo de 30 s de `moduloLigado` / `modulosLigados` (módulos por FLAG em
 * `platform_config`). Mede quantas vezes o banco é consultado e o que o chamador
 * enxerga — dentro do prazo, depois de `gravarModulo`, depois do prazo, depois de
 * erro, com leitura fresca. Módulo de TABELA segue lido a cada vez.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TTL_CURTO_MS } from "@/lib/auth/cache-curto";

import { gravarModulo, moduloLigado, modulosLigados } from "./modulos";

function banco() {
  const estado = {
    flags: [] as Array<{ chave: string; valor: string }>,
    tabela: [] as Array<{ modulo: string }>,
    leiturasDeFlag: 0,
    leiturasDeTabela: 0,
    erroNaFlag: false,
    upsertErro: false,
  };
  const db = {
    from: (nome: string) => {
      const builder = {
        select: () => builder,
        in: () => builder,
        eq: () => builder,
        upsert: async (linha: { chave: string; valor: string }) => {
          if (estado.upsertErro) return { error: { code: "X", message: "recusou" } };
          estado.flags = estado.flags.filter((f) => f.chave !== linha.chave).concat(linha);
          return { error: null };
        },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
          if (nome === "platform_config") {
            estado.leiturasDeFlag += 1;
            if (estado.erroNaFlag) return Promise.resolve({ data: null, error: { code: "X", message: "fora" } }).then(ok, ko);
            return Promise.resolve({ data: estado.flags, error: null }).then(ok, ko);
          }
          estado.leiturasDeTabela += 1;
          return Promise.resolve({ data: estado.tabela, error: null }).then(ok, ko);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, estado };
}

const CAIXA_LIGADA = { chave: "MODULO_SETORES", valor: "ligado" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.MEMO_DA_INSTALACAO_MS;
});

const M = { fresco: false } as const;

describe("moduloLigado — memo de 30 s dos módulos por flag", () => {
  it("a segunda pergunta dentro do prazo não vai ao banco, nem para outro módulo", async () => {
    const { db, estado } = banco();
    estado.flags = [CAIXA_LIGADA];
    expect(await moduloLigado(db, "setores", M)).toBe(true);
    expect(await moduloLigado(db, "setores", M)).toBe(true);
    expect(await moduloLigado(db, "cold_call", M)).toBe(false);
    expect(await modulosLigados(db, M)).toEqual(["setores"]);
    expect(estado.leiturasDeFlag).toBe(1);
  });

  it("módulo por flag não consulta a tabela de módulos instalados", async () => {
    const { db, estado } = banco();
    await moduloLigado(db, "setores", M);
    expect(estado.leiturasDeTabela).toBe(0);
  });

  it("módulo de tabela é lido a cada vez e não consulta as flags", async () => {
    const { db, estado } = banco();
    estado.tabela = [{ modulo: "financeiro" }];
    expect(await moduloLigado(db, "financeiro", M)).toBe(true);
    expect(await moduloLigado(db, "financeiro", M)).toBe(true);
    expect(estado.leiturasDeTabela).toBe(2);
    expect(estado.leiturasDeFlag).toBe(0);
  });

  it("gravarModulo invalida: a pergunta seguinte já vê o novo estado", async () => {
    const { db, estado } = banco();
    expect(await moduloLigado(db, "setores", M)).toBe(false);
    expect(await gravarModulo(db, "setores", true, "u1")).toBe(true);
    expect(await moduloLigado(db, "setores", M)).toBe(true);
    expect(await gravarModulo(db, "setores", false, "u1")).toBe(true);
    expect(await moduloLigado(db, "setores", M)).toBe(false);
    expect(estado.leiturasDeFlag).toBe(3);
  });

  it("gravação que falhou não invalida (o estado não mudou)", async () => {
    const { db, estado } = banco();
    expect(await moduloLigado(db, "setores", M)).toBe(false);
    estado.upsertErro = true;
    expect(await gravarModulo(db, "setores", true, "u1")).toBe(false);
    await moduloLigado(db, "setores", M);
    expect(estado.leiturasDeFlag).toBe(1);
  });

  it("vencido o prazo, volta ao banco e enxerga a mudança de outro processo", async () => {
    const { db, estado } = banco();
    expect(await moduloLigado(db, "setores", M)).toBe(false);
    estado.flags = [CAIXA_LIGADA];
    vi.advanceTimersByTime(TTL_CURTO_MS - 1);
    expect(await moduloLigado(db, "setores", M)).toBe(false);
    vi.advanceTimersByTime(2);
    expect(await moduloLigado(db, "setores", M)).toBe(true);
  });

  it("erro de leitura falha fechado e não entra no memo", async () => {
    const { db, estado } = banco();
    estado.flags = [CAIXA_LIGADA];
    estado.erroNaFlag = true;
    expect(await moduloLigado(db, "setores", M)).toBe(false);
    estado.erroNaFlag = false;
    expect(await moduloLigado(db, "setores", M)).toBe(true);
    expect(estado.leiturasDeFlag).toBe(2);
  });

  it("o padrão lê o banco a cada vez: ligar um módulo vale na hora", async () => {
    const { db, estado } = banco();
    expect(await moduloLigado(db, "setores")).toBe(false);
    estado.flags = [CAIXA_LIGADA];
    expect(await moduloLigado(db, "setores")).toBe(true);
    expect(estado.leiturasDeFlag).toBe(2);
  });

  it("MEMO_DA_INSTALACAO_MS=0 desliga o memo", async () => {
    process.env.MEMO_DA_INSTALACAO_MS = "0";
    const { db, estado } = banco();
    await moduloLigado(db, "setores", M);
    await moduloLigado(db, "setores", M);
    expect(estado.leiturasDeFlag).toBe(2);
  });
});
