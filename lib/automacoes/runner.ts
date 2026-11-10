/**
 * O LAÇO RÁPIDO DAS AUTOMAÇÕES (lote 6), dentro do `agent-worker`.
 *
 * O motor das automações é o dos follow-ups (`runFollowupTick`), e quem o anda
 * é o cron `followup-flow-worker`, de minuto em minuto. Uma espera de 5 s
 * terminava, então, em até 1 minuto. Este laço roda no worker que já está de
 * pé e, a cada `AUTOMACAO_RUNNER_INTERVAL_MS` (5 s por padrão), chama o MESMO
 * `runFollowupTick` com UMA diferença: o claim é o da raia `automacao`
 * (`fn_claim_due_automacao_enrollments`, migration 1003).
 *
 * ─── Por que não há dupla execução ─────────────────────────────────────────
 *
 * Não é um segundo agendador com estado próprio: os dois claims (o do cron,
 * todas as raias; o deste laço, só a automação) gravam o MESMO
 * `followup_enrollments.claimed_until`, e os dois só pegam linha com o lease
 * vencido — a condição repetida no UPDATE de cada função. Quem pegou primeiro
 * anda a execução; o outro não a vê até o lease (120 s) vencer ou o motor soltá-lo.
 *
 * ─── Piso e desligamento ───────────────────────────────────────────────────
 *
 * O cron continua como piso: worker caído, as automações seguem no ritmo de
 * 1 minuto. `AUTOMACAO_RUNNER_INTERVAL_MS=0` desliga este laço.
 *
 * O turno de IA que a automação pedir passa pela MESMA porta do cron e do
 * relógio HTTP: organização que não pode produzir não enfileira, e a execução
 * é encerrada (`encerrarEnrollmentPorAssinaturaSuspensa`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { FollowupJobRequest, TickSummary } from "@/lib/followup/engine";

interface LogDoLaco {
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface DepsDoLacoDasAutomacoes {
  /** Um tick do motor, com o claim só da raia `automacao`. */
  tick: () => Promise<TickSummary>;
  /** Espera `ms` ou até o `signal` abortar. Injetável para o teste. */
  dormir?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Soneca que o `docker stop` corta: o abort resolve a espera na hora. */
export function dormirAbortavel(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const fim = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", fim);
      resolve();
    };
    const timer = setTimeout(fim, ms);
    signal.addEventListener("abort", fim, { once: true });
  });
}

/**
 * O laço. Nunca lança: um tick que explode (banco fora do ar) é registrado e o
 * laço dorme o intervalo normal — não acelera para uma tempestade de tentativas.
 */
export async function rodarLacoDasAutomacoes(
  knobs: { intervalMs: number },
  deps: DepsDoLacoDasAutomacoes,
  log: LogDoLaco,
  signal: AbortSignal,
): Promise<void> {
  if (!(knobs.intervalMs > 0)) {
    log.info(
      "laço rápido das automações OFF (AUTOMACAO_RUNNER_INTERVAL_MS=0) — o cron de 1 min segue",
      {},
    );
    return;
  }
  const dormir = deps.dormir ?? dormirAbortavel;
  while (!signal.aborted) {
    try {
      const r = await deps.tick();
      if (r.claim_falhou) {
        log.error(
          "automações: o claim do laço rápido falhou — o cron de 1 min segue como piso",
          {},
        );
      } else if (r.claimed > 0) {
        log.info("automações: tick do laço rápido", { ...r });
      }
    } catch (err) {
      log.error("automações: tick do laço rápido falhou", {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
    await dormir(knobs.intervalMs, signal);
  }
}

/**
 * O tick de produção, montado com imports dinâmicos (o mesmo cuidado de
 * `carregarDepsDoLaco` no laço do event_log): um módulo que não carrega sob
 * `tsx` desliga ESTE laço com um log, sem derrubar o worker.
 */
export async function carregarTickDasAutomacoes(
  log: LogDoLaco,
): Promise<(() => Promise<TickSummary>) | null> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { createSupabaseAdminClient, runFollowupTick } = await import("@/lib/followup/engine");
    const { criarExecutorDeEfeitos } = await import("@/lib/automacoes/efeitos");
    const { motivoDeNaoProduzir } = await import("@/lib/billing/assinatura/pode-produzir");
    const { encerrarEnrollmentPorAssinaturaSuspensa } =
      await import("@/lib/followup/encerrar-por-assinatura-suspensa");
    const admin: SupabaseClient = createAdminClient();

    const enqueueJob = async (job: FollowupJobRequest): Promise<void> => {
      const motivo = await motivoDeNaoProduzir(admin, job.organization_id);
      if (motivo) {
        log.info("automações: turno não enfileirado — organização não pode produzir", {
          motivo,
          organization_id: job.organization_id,
          followup_enrollment_id: job.payload.followup_enrollment_id,
        });
        await encerrarEnrollmentPorAssinaturaSuspensa(
          admin,
          job.organization_id,
          job.payload.followup_enrollment_id,
          motivo,
        );
        return;
      }
      const { error } = await admin.from("job_queue").insert({
        organization_id: job.organization_id,
        contact_id: job.contact_id,
        kind: "followup_turn",
        payload: job.payload,
      });
      if (error) throw new Error(error.message);
    };
    const efeitos = criarExecutorDeEfeitos(admin);

    // O adaptador é refeito a cada tick, como no cron: ele guarda as revisões
    // das linhas reclamadas, e um mapa vivo para sempre só cresceria.
    return () =>
      runFollowupTick({
        db: createSupabaseAdminClient(admin, { claim: "automacao" }),
        clock: () => new Date(),
        enqueueJob,
        efeitos,
      });
  } catch (err) {
    log.error("laço rápido das automações não carregou — o cron de 1 min segue", {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    return null;
  }
}
