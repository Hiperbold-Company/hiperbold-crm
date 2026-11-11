/**
 * O CRON PÕE OS ALARMES DE GATILHO DE PLANO NA PODA (migration 1009, D-074).
 *
 * `billing_trigger_alarmes` (0910) não tinha retenção nenhuma. O que este arquivo mede no lado do
 * TypeScript: o cron drena `fn_podar_alarmes_de_gatilho` pelo mesmo laço das irmãs, com o knob
 * `BILLING_TRIGGER_ALARM_RETENTION_DAYS` (abaixo do piso é elevado, com aviso); a rodada que só apagou
 * alarme ainda deixa rastro (`houveEfeito`); o corpo do baseline é o da migration; o padrão e o piso do
 * SQL são os de `lib/retencao/politica.ts`; e a função só é executável pelo servidor.
 *
 * O piso contra um Postgres de verdade está em `tests/invariants/alarmes-de-gatilho-tem-prazo.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type PodaDb,
  TAMANHO_DO_LOTE,
  houveEfeito,
  podarHistorico,
} from "@/app/api/v1/cron/data-retention/route";
import {
  RETENCAO_ALARMES_DE_GATILHO_DIAS_PADRAO,
  RETENCAO_ALARMES_DE_GATILHO_DIAS_PISO,
} from "@/lib/retencao/politica";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: "segredo", INTERNAL_SECRET: "" },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: 0, error: null }) }),
}));

const FN = "fn_podar_alarmes_de_gatilho";
const RAIZ = join(__dirname, "..", "..");
const BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
const MIGRATION = readFileSync(
  join(RAIZ, "supabase", "migrations", "20261111150000_1009_alarmes_de_gatilho_tem_prazo.sql"),
  "utf8",
);

/** Banco falso que só registra as chamadas: o que se mede é o que o cron PEDE, não o que o banco faz. */
function bancoGravador(devolve: number[] = []): { db: PodaDb; chamadas: { nome: string; dias: number; limite: number }[] } {
  const chamadas: { nome: string; dias: number; limite: number }[] = [];
  const fila = [...devolve];
  const db: PodaDb = {
    async rpc(nome, args) {
      chamadas.push({ nome, dias: args.p_retencao_dias, limite: args.p_limite });
      return { data: nome === FN ? (fila.shift() ?? 0) : 0, error: null };
    },
    async apagarRascunhos() {
      return { data: 0, error: null };
    },
    async enfileirarMidia() {
      return { data: { vencidas: 0, orfas: 0 }, error: null };
    },
  };
  return { db, chamadas };
}

function corpo(fonte: string): string {
  const i = fonte.lastIndexOf(`create or replace function public.${FN}(`);
  if (i < 0) throw new Error(`INSTRUMENTO: ${FN} ausente`);
  return fonte.slice(i, fonte.indexOf("$$;", i) + 3);
}

describe("podarHistorico: os alarmes de gatilho", () => {
  it("sem knob, chama a função uma vez com o padrão, em lote do tamanho das irmãs, sem aviso", async () => {
    const { db, chamadas } = bancoGravador();
    const r = await podarHistorico(db, {});
    expect(chamadas.filter((c) => c.nome === FN)).toEqual([
      { nome: FN, dias: RETENCAO_ALARMES_DE_GATILHO_DIAS_PADRAO, limite: TAMANHO_DO_LOTE },
    ]);
    expect(r.retencao_alarmes_de_gatilho_dias).toBe(RETENCAO_ALARMES_DE_GATILHO_DIAS_PADRAO);
    expect(r.avisos).toEqual([]);
  });

  it("knob abaixo do piso é ELEVADO ao piso, com aviso nomeando a chave", async () => {
    const { db, chamadas } = bancoGravador();
    const r = await podarHistorico(db, { BILLING_TRIGGER_ALARM_RETENTION_DAYS: "1" });
    expect(chamadas.find((c) => c.nome === FN)?.dias).toBe(RETENCAO_ALARMES_DE_GATILHO_DIAS_PISO);
    expect(r.avisos).toEqual([expect.stringContaining("BILLING_TRIGGER_ALARM_RETENTION_DAYS")]);
  });

  it("knob acima do piso é respeitado", async () => {
    const { db, chamadas } = bancoGravador();
    await podarHistorico(db, { BILLING_TRIGGER_ALARM_RETENTION_DAYS: "365" });
    expect(chamadas.find((c) => c.nome === FN)?.dias).toBe(365);
  });

  it("drena em lotes: lote cheio pede outro, lote incompleto para", async () => {
    const { db, chamadas } = bancoGravador([TAMANHO_DO_LOTE, 2]);
    const r = await podarHistorico(db, {});
    expect(chamadas.filter((c) => c.nome === FN)).toHaveLength(2);
    expect(r.alarmes_de_gatilho_apagados).toBe(TAMANHO_DO_LOTE + 2);
    expect(r.lotes_alarmes_de_gatilho).toBe(2);
    expect(r.alarmes_de_gatilho_tem_resto).toBe(false);
  });

  it("falha da função entra nomeada em `falhas` e não derruba as outras podas", async () => {
    const chamadas: string[] = [];
    const db: PodaDb = {
      async rpc(nome) {
        chamadas.push(nome);
        return nome === FN ? { data: null, error: { message: "função ausente" } } : { data: 0, error: null };
      },
      async apagarRascunhos() {
        return { data: 0, error: null };
      },
      async enfileirarMidia() {
        return { data: { vencidas: 0, orfas: 0 }, error: null };
      },
    };
    const r = await podarHistorico(db, {});
    expect(r.falhas).toEqual([expect.stringContaining(FN)]);
    expect(chamadas).toContain("fn_expurgar_checkpoints_superados");
  });
});

describe("houveEfeito: rodada que só podou alarme ainda audita", () => {
  it("só os alarmes apagaram, então houve efeito", async () => {
    const { db } = bancoGravador([1]);
    const r = await podarHistorico(db, {});
    expect(r.alarmes_de_gatilho_apagados).toBe(1);
    expect(houveEfeito(r)).toBe(true);
  });

  it("nada apagado, então sem efeito (a outra direção)", async () => {
    const { db } = bancoGravador();
    expect(houveEfeito(await podarHistorico(db, {}))).toBe(false);
  });
});

describe("a função no baseline e na migration", () => {
  it("o corpo do baseline é o MESMO da migration", () => {
    expect(corpo(BASELINE)).toBe(corpo(MIGRATION));
  });

  it("padrão e piso do SQL são os números de lib/retencao/politica.ts", () => {
    expect(corpo(BASELINE)).toContain(
      `greatest(coalesce(p_retencao_dias, ${RETENCAO_ALARMES_DE_GATILHO_DIAS_PADRAO}), ${RETENCAO_ALARMES_DE_GATILHO_DIAS_PISO})`,
    );
  });

  it("security definer com search_path public, pg_temp; parâmetros só de idade e lote", () => {
    const c = corpo(BASELINE);
    expect(c).toMatch(/\(\s*p_retencao_dias int default null,\s*p_limite int default 1000\s*\)/);
    expect(c).toContain("security definer");
    expect(c).toContain("set search_path = public, pg_temp");
    expect(c).toContain("where a.criado_em < v_corte");
  });

  it("revogada das duas origens e concedida só ao servidor", () => {
    expect(BASELINE).toContain(`revoke execute on function public.${FN}(int,int) from public, anon, authenticated;`);
    expect(BASELINE).toContain(`grant  execute on function public.${FN}(int,int) to service_role;`);
  });

  it("o bloco do baseline fica antes da VARREDURA anon (cria função)", () => {
    const bloco = BASELINE.indexOf("(migration 1009, fork Hiperbold, D-074) ----");
    expect(bloco).toBeGreaterThan(0);
    expect(bloco).toBeLessThan(BASELINE.indexOf("-- ---- VARREDURA anon:"));
  });
});
