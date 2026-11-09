/**
 * `MODULOS_OPCIONAIS` tem DOIS mecanismos por baixo (ver o cabeçalho de `./modulos.ts`):
 *
 *  - `banco_externo`: uma FLAG em `platform_config` — só o valor `ligado` liga (doc 37).
 *  - `honorarios`: um MÓDULO DE TABELA (ADR-0002) — a fonte é `modulos_instalados.estado`,
 *    escrita só por `fn_modulo_instalar`, nunca por esta tela.
 *
 * Os dois falham fechado: banco que não responde, ou que lança, nunca liga um módulo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { abrirAcesso } from "@/lib/external-db/acesso";

import { CHAVE_DO_MODULO, esquecerMemoDosModulos, MEMO_DO_MODULO_MS, moduloLigadoComMemo, modulosLigados } from "./modulos";

// Este arquivo mede a LEITURA (o que cada linha do banco liga) com bancos diferentes no mesmo caso;
// o memo de 30 s tem o seu arquivo (`memo-dos-modulos.test.ts`) e aqui ficaria no caminho.
beforeAll(() => {
  process.env.MEMO_DA_INSTALACAO_MS = "0";
});
afterAll(() => {
  delete process.env.MEMO_DA_INSTALACAO_MS;
});

type Resposta = { data?: unknown; error?: unknown } | Error;

/**
 * Um builder por tabela, chamável tanto como `.select().in()` (flag) quanto como
 * `.select().in().eq()` (módulo de tabela) — os dois formatos que `modulosLigados` usa,
 * cada um resolvendo pela mesma promessa no fim da cadeia (como o cliente real: qualquer
 * ponto da cadeia é `await`-ável).
 */
function banco(porTabela: Record<string, Resposta> = {}) {
  const from = vi.fn((table: string) => {
    const resposta = porTabela[table] ?? { data: [], error: null };
    const resolver = () =>
      resposta instanceof Error
        ? Promise.reject(resposta)
        : Promise.resolve({ data: resposta.data ?? null, error: resposta.error ?? null });
    const builder = {
      select: () => builder,
      in: () => builder,
      eq: () => builder,
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        resolver().then(onFulfilled, onRejected),
    };
    return builder;
  });
  return { db: { from } as unknown as SupabaseClient, from };
}

describe("modulosLigados — banco_externo (flag em platform_config)", () => {
  it("sem linha, o banco externo está desligado", async () => {
    expect(await modulosLigados(banco().db)).toEqual([]);
  });

  it("só `ligado` liga — `desligado` e lixo não", async () => {
    const ligado = [{ chave: "MODULO_BANCO_EXTERNO", valor: "ligado" }];
    expect(await modulosLigados(banco({ platform_config: { data: ligado } }).db)).toEqual([
      "banco_externo",
    ]);
    const desligado = [{ chave: "MODULO_BANCO_EXTERNO", valor: "desligado" }];
    expect(await modulosLigados(banco({ platform_config: { data: desligado } }).db)).toEqual([]);
    const lixo = [{ chave: "MODULO_BANCO_EXTERNO", valor: "true" }];
    expect(await modulosLigados(banco({ platform_config: { data: lixo } }).db)).toEqual([]);
  });

  it("cada módulo tem a sua linha — ligar um não liga o outro", async () => {
    const soFluxos = [{ chave: "MODULO_FLUXOS_DE_ATENDIMENTO", valor: "ligado" }];
    expect(await modulosLigados(banco({ platform_config: { data: soFluxos } }).db)).toEqual([
      "fluxos_atendimento",
    ]);
    const osDois = [
      { chave: "MODULO_BANCO_EXTERNO", valor: "ligado" },
      { chave: "MODULO_FLUXOS_DE_ATENDIMENTO", valor: "ligado" },
    ];
    expect(await modulosLigados(banco({ platform_config: { data: osDois } }).db)).toEqual([
      "banco_externo",
      "fluxos_atendimento",
    ]);
  });

  it("banco que recusa ou lança = desligado, sem lançar", async () => {
    expect(
      await modulosLigados(banco({ platform_config: { error: { code: "42P01" } } }).db),
    ).toEqual([]);
    expect(await modulosLigados(banco({ platform_config: new Error("rede") }).db)).toEqual([]);
  });
});

describe("modulosLigados — honorarios (módulo de tabela, ADR-0002)", () => {
  it("sem linha em modulos_instalados, honorarios está desligado", async () => {
    expect(await modulosLigados(banco().db)).toEqual([]);
  });

  it("estado 'ativo' liga; 'suspenso' NÃO liga — D6 (falha alto na reaplicação)", async () => {
    const ativo = [{ modulo: "honorarios", estado: "ativo" }];
    expect(await modulosLigados(banco({ modulos_instalados: { data: ativo } }).db)).toEqual([
      "honorarios",
    ]);
    // O `.eq('estado','ativo')' da query real já filtra suspenso no servidor — o fake
    // simula exatamente o que o Postgrest devolveria: nenhuma linha.
    expect(await modulosLigados(banco({ modulos_instalados: { data: [] } }).db)).toEqual([]);
  });

  it("banco que recusa ou lança = desligado, sem lançar (o outro mecanismo segue funcionando)", async () => {
    expect(
      await modulosLigados(banco({ modulos_instalados: { error: { code: "42P01" } } }).db),
    ).toEqual([]);
    expect(await modulosLigados(banco({ modulos_instalados: new Error("rede") }).db)).toEqual([]);
  });

  it("os dois mecanismos somam quando ambos estão ligados", async () => {
    const resultado = await modulosLigados(
      banco({
        platform_config: { data: [{ chave: "MODULO_BANCO_EXTERNO", valor: "ligado" }] },
        modulos_instalados: { data: [{ modulo: "honorarios", estado: "ativo" }] },
      }).db,
    );
    expect(resultado.sort()).toEqual(["banco_externo", "honorarios"]);
  });
});

describe("abrirAcesso com o módulo desligado", () => {
  it("recusa antes de carregar a conexão — nenhuma credencial é lida", async () => {
    const { db, from } = banco();
    const acesso = await abrirAcesso(db, "org", "conexao");
    expect(acesso).toEqual({ ok: false, motivo: "modulo_desligado" });
    // `banco_externo` é módulo por FLAG: `moduloLigado` consulta só o mecanismo dele
    // (`platform_config`), não a tabela de módulos instalados — e a tabela de conexões
    // nem é tocada quando o módulo já está desligado.
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("platform_config");
  });
});

describe("moduloLigadoComMemo (turno do agente)", () => {
  it("dentro do prazo do memo, uma leitura só; vencido, lê de novo", async () => {
    esquecerMemoDosModulos();
    const { db, from } = banco({
      platform_config: { data: [{ chave: "MODULO_FLUXOS_DE_ATENDIMENTO", valor: "ligado" }] },
    });
    expect(await moduloLigadoComMemo(db, "fluxos_atendimento", 1_000)).toBe(true);
    expect(await moduloLigadoComMemo(db, "fluxos_atendimento", 1_000 + MEMO_DO_MODULO_MS - 1)).toBe(true);
    // `fluxos_atendimento` é módulo por flag: 1 leitura real = 1 chamada a `.from()`
    // (`moduloLigado` não consulta a tabela de módulos). O memo evita a SEGUNDA leitura.
    expect(from).toHaveBeenCalledTimes(1);
    await moduloLigadoComMemo(db, "fluxos_atendimento", 1_000 + MEMO_DO_MODULO_MS + 1);
    expect(from).toHaveBeenCalledTimes(2);
  });
});


describe("a chave da cobrança do revendedor (spec 2026-09-29, PR 2)", () => {
  it("mora em MODULO_COBRANCA, e só `ligado` liga", async () => {
    expect(CHAVE_DO_MODULO.cobranca).toBe("MODULO_COBRANCA");
    const ligada = [{ chave: "MODULO_COBRANCA", valor: "ligado" }];
    expect(await modulosLigados(banco({ platform_config: { data: ligada } }).db)).toEqual(["cobranca"]);
    const lixo = [{ chave: "MODULO_COBRANCA", valor: "sim" }];
    expect(await modulosLigados(banco({ platform_config: { data: lixo } }).db)).toEqual([]);
  });
});
