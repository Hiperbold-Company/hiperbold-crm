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
 * ─── Piso OCIOSO: a sonda, e por que não `recursoTemTrabalho` ─────────────
 *
 * O cron só chama o claim quando `recursoTemTrabalho("followup")` diz que há
 * execução vencida. O mecanismo dele (`lib/cron/piso-ocioso.ts`) é um retrato
 * de 30 s em cache DENTRO do processo do app: servir o laço de 5 s com ele
 * adiaria a retomada de uma espera de 5 s em até 30 s. Por isso o laço tem a
 * sua sonda: uma leitura direta pelo pool `pg` do worker (nenhuma requisição ao
 * PostgREST), um `exists` que para na primeira linha e que o índice parcial
 * `idx_followup_enrollments_due_automacao` (migration 1003) atende sem varrer
 * nada. Só quando a sonda diz "há vencido" o laço paga o RPC do claim. A
 * retomada continua em ~5 s e o laço ocioso custa um `exists` indexado a cada
 * 5 s. Sonda que falha = "na dúvida, roda" (a mesma regra do piso do cron).
 *
 * ─── Falha, teto e desligamento ────────────────────────────────────────────
 *
 * - Claim que falha de forma repetida (função ausente: app novo antes do
 *   banco) recua o intervalo para 60 s e loga no máximo 1 vez por minuto; o
 *   primeiro claim que volta bem devolve o ritmo de 5 s.
 * - Cada tick tem um teto (110 s, abaixo do lease de 120 s do claim): tick
 *   preso é registrado e o laço segue, em vez de parar calado. O lease impede
 *   que a execução presa seja pega por outro enquanto ele vale.
 * - O sinal de desligamento é conferido antes de cada tick.
 *
 * O turno de IA que a automação pedir passa pela MESMA porta do cron e do
 * relógio HTTP: organização que não pode produzir não enfileira, e a execução
 * é encerrada (`encerrarEnrollmentPorAssinaturaSuspensa`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import type { FollowupJobRequest, TickSummary } from "@/lib/followup/engine";

interface LogDoLaco {
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface DepsDoLacoDasAutomacoes {
  /** Um tick do motor, com o claim só da raia `automacao`. */
  tick: () => Promise<TickSummary>;
  /**
   * Sonda barata: há execução da raia vencida e sem lease? Ausente = o laço
   * sempre chama o tick. Se lançar, vale `true` (na dúvida, roda).
   */
  temTrabalho?: () => Promise<boolean>;
  /** Espera `ms` ou até o `signal` abortar. Injetável para o teste. */
  dormir?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Relógio em ms (só para o limite de 1 log por minuto). Injetável para o teste. */
  agora?: () => number;
}

/** Intervalo enquanto o claim falha (função ausente, banco fora). */
export const INTERVALO_COM_FALHA_MS = 60_000;
/** Teto de um tick: abaixo do lease de 120 s do claim (`CLAIM_LEASE_SECONDS`). */
export const TETO_DO_TICK_MS = 110_000;
/** No máximo um log de erro por esta janela. */
const JANELA_DO_LOG_DE_ERRO_MS = 60_000;

class TickPresoError extends Error {}

/** Corre o tick contra um teto; o tick preso segue em segundo plano, sem rejeição solta. */
async function comTeto<T>(p: Promise<T>, tetoMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const teto = new Promise<never>((_, rejeita) => {
    timer = setTimeout(() => rejeita(new TickPresoError(`tick passou de ${tetoMs} ms`)), tetoMs);
  });
  p.catch(() => {});
  try {
    return await Promise.race([p, teto]);
  } finally {
    clearTimeout(timer);
  }
}

/** O mesmo `exists` do piso do cron para o follow-up, restrito à raia — e atendido pelo índice parcial. */
export const SQL_DA_SONDA_DAS_AUTOMACOES = `select exists (
  select 1 from followup_enrollments e
   where e.lane = 'automacao'
     and e.status in ('active', 'waiting_reply', 'dormente')
     and e.next_eval_at <= now()
     and (e.claimed_until is null or e.claimed_until < now())
     and exists (select 1 from organizations o where o.id = e.organization_id and o.status = 'active')
) as tem`;

/** Sonda de produção sobre o pool `pg` do worker. Teto de 2 s: banco mudo = "roda". */
export function criarSondaDeTrabalhoDasAutomacoes(
  pool: Pick<pg.Pool, "query">,
): () => Promise<boolean> {
  return async () => {
    const r = await comTeto(pool.query<{ tem: boolean }>(SQL_DA_SONDA_DAS_AUTOMACOES), 2_000);
    return r.rows[0]?.tem !== false;
  };
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
  knobs: { intervalMs: number; tetoDoTickMs?: number },
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
  const agora = deps.agora ?? Date.now;
  const teto = knobs.tetoDoTickMs ?? TETO_DO_TICK_MS;
  let logLivreEm = 0;
  const logarErro = (msg: string, fields: Record<string, unknown> = {}): void => {
    const t = agora();
    if (t < logLivreEm) return;
    logLivreEm = t + JANELA_DO_LOG_DE_ERRO_MS;
    log.error(msg, fields);
  };
  const msgErro = (err: unknown): string =>
    (err instanceof Error ? err.message : String(err)).slice(0, 300);

  while (!signal.aborted) {
    let espera = knobs.intervalMs;
    try {
      let haTrabalho = true;
      if (deps.temTrabalho) {
        try {
          haTrabalho = await deps.temTrabalho();
        } catch (err) {
          haTrabalho = true; // na dúvida, roda
          logarErro("automações: a sonda de trabalho falhou — o tick roda mesmo assim", {
            error: msgErro(err),
          });
        }
      }
      // O desligamento é conferido antes de cada tick: a sonda pode ter demorado.
      if (haTrabalho && !signal.aborted) {
        const r = await comTeto(deps.tick(), teto);
        if (r.claim_falhou) {
          logarErro(
            "automações: o claim do laço rápido falhou — recua para 60 s; o cron de 1 min segue como piso",
          );
          espera = Math.max(knobs.intervalMs, INTERVALO_COM_FALHA_MS);
        } else if (r.claimed > 0) {
          log.info("automações: tick do laço rápido", { ...r });
        }
      }
    } catch (err) {
      logarErro(
        err instanceof TickPresoError
          ? "automações: tick do laço rápido preso — segue para o próximo"
          : "automações: tick do laço rápido falhou",
        { error: msgErro(err) },
      );
      espera = Math.max(knobs.intervalMs, INTERVALO_COM_FALHA_MS);
    }
    await dormir(espera, signal);
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
