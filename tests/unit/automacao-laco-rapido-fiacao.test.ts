// @vitest-environment node
/**
 * A FIAÇÃO do laço rápido das automações (lote 6): o que o `runner.test.ts` (ritmo)
 * e o invariante contra Postgres (a função) não provam sozinhos — que o worker
 * realmente CHAMA a função da raia, e não a do cron.
 *
 * Sem estes casos, apagar `{ claim: "automacao" }` do runner deixaria todos os
 * outros testes verdes: o laço de 5 s passaria a reclamar também os follow-ups
 * (que enfileiram turno de IA e têm ritmo de 1 min), sem nenhum teste notar.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chamadas: string[] = [];
const fakeAdmin = {
  rpc: async (funcao: string) => {
    chamadas.push(funcao);
    return { data: [], error: null };
  },
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeAdmin,
}));

import { createSupabaseAdminClient } from "@/lib/followup/engine";
import { carregarTickDasAutomacoes } from "@/lib/automacoes/runner";

const RAIZ = path.resolve(__dirname, "../..");
const log = { info: () => {}, error: () => {} };

beforeEach(() => {
  chamadas.length = 0;
});

describe("createSupabaseAdminClient: qual função de claim", () => {
  it("com { claim: 'automacao' } chama fn_claim_due_automacao_enrollments", async () => {
    await createSupabaseAdminClient(fakeAdmin as unknown as SupabaseClient, {
      claim: "automacao",
    }).claimDueEnrollments(20, 120);
    expect(chamadas).toEqual(["fn_claim_due_automacao_enrollments"]);
  });

  it("sem a opção (cron e relógio HTTP) chama fn_claim_due_followup_enrollments", async () => {
    await createSupabaseAdminClient(fakeAdmin as unknown as SupabaseClient).claimDueEnrollments(
      20,
      120,
    );
    expect(chamadas).toEqual(["fn_claim_due_followup_enrollments"]);
  });
});

describe("carregarTickDasAutomacoes", () => {
  it("o tick de produção reclama pela função da raia automacao, nunca pela do cron", async () => {
    const tick = await carregarTickDasAutomacoes(log);
    expect(tick).not.toBeNull();
    const resumo = await tick!();
    expect(resumo.claim_falhou).toBeUndefined();
    expect(chamadas).toEqual(["fn_claim_due_automacao_enrollments"]);
  });
});

describe("o worker liga o laço (cerca estrutural)", () => {
  const main = readFileSync(path.join(RAIZ, "workers/agent-worker/main.ts"), "utf8");

  it("monta o tick, a sonda e roda o laço com o sinal de desligamento do worker", () => {
    expect(main).toMatch(/carregarTickDasAutomacoes\(\s*log\s*\)/);
    expect(main).toMatch(/criarSondaDeTrabalhoDasAutomacoes\(\s*pool\s*\)/);
    expect(main).toMatch(/rodarLacoDasAutomacoes\([\s\S]*?loopsAbort\.signal/);
  });

  it("o laço é aguardado no desligamento junto com os demais", () => {
    const usos = main.match(/automacoesLoop/g) ?? [];
    expect(usos.length).toBeGreaterThanOrEqual(2); // declarado e esperado/drenado
  });

  it("o knob AUTOMACAO_RUNNER_INTERVAL_MS existe no env validado", () => {
    expect(readFileSync(path.join(RAIZ, "lib/agent-engine/env.ts"), "utf8")).toContain(
      "AUTOMACAO_RUNNER_INTERVAL_MS",
    );
  });
});
