/**
 * B3 (auditoria do lote 16): os portões do GASTO DE IA falhavam ABERTOS. Falha na leitura de
 * `organizations` no dispatcher legado processava tudo, e organização sem linha em `organizations`
 * seguia no dreno do motor. (O dispatcher legado, `lib/ai/dispatcher`, saiu com o upstream; os
 * casos dele saíram junto. Fica o dreno do motor, que é o caminho que existe.) No gasto de IA o portão falha FECHADO: não chama o modelo.
 *
 * Escolha de desfecho:
 * - leitura que FALHA (transitória): o evento fica como está (dispatcher: sem claim, nada consumido;
 *   dreno: o `throw` já devolve o evento a `pending` com espera e conta tentativa), para a próxima
 *   rodada tentar de novo;
 * - organização que NÃO EXISTE (permanente): o evento é consumido, tentar de novo dá o mesmo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { drainTick } from "@/lib/agent-engine/edge/crm/drain";

const ORG = "11111111-1111-4111-8111-111111111111";
const EVENTO = "33333333-3333-4333-8333-333333333333";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const CONTATO = "77777777-7777-4777-8777-777777777777";
const CANAL = "55555555-5555-4555-8555-555555555555";
const MENSAGEM = "66666666-6666-4666-8666-666666666666";

const PAYLOAD = {
  conversation_id: CONVERSA,
  contact_id: CONTATO,
  channel_session_id: CANAL,
  inbound_message_id: MENSAGEM,
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── dreno do motor ────────────────────────────────────────────────────────

const KNOBS = { batchSize: 10, intervalMs: 1, idleIntervalMs: 1, debounceMs: 0, reapTimeoutMs: 1000 };
const LOG = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function poolDoDreno(leituraDaOrg: "sem_linha" | "falha") {
  const sqls: string[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      sqls.push(sql);
      if (sql.startsWith("update event_log e")) {
        return { rows: [{ id: EVENTO, organization_id: ORG, payload: PAYLOAD, attempts: 1, created_at: new Date().toISOString() }] };
      }
      if (sql.includes("from organizations")) {
        if (leituraDaOrg === "falha") throw new Error("banco fora");
        return { rows: [] };
      }
      if (sql.includes("from conversations")) return { rows: [{ is_group: false }] };
      void params;
      return { rows: [] };
    }),
  };
  return { pool, sqls };
}

describe("dreno do motor: gasto de IA falha FECHADO", () => {
  it("organização sem linha em organizations: o evento é consumido, sem ler conversa nem criar job", async () => {
    const { pool, sqls } = poolDoDreno("sem_linha");
    await drainTick(pool as never, KNOBS as never, LOG);

    expect(sqls.some((s) => s.includes("from conversations"))).toBe(false);
    expect(sqls.some((s) => s.includes("job_queue"))).toBe(false);
    expect(sqls.some((s) => s.startsWith("update event_log set status = 'done'"))).toBe(true);
  });

  it("leitura da organização falhou: o evento volta a pending para nova tentativa, sem job", async () => {
    const { pool, sqls } = poolDoDreno("falha");
    await drainTick(pool as never, KNOBS as never, LOG);

    expect(sqls.some((s) => s.includes("from conversations"))).toBe(false);
    expect(sqls.some((s) => s.includes("job_queue"))).toBe(false);
    expect(sqls.some((s) => s.startsWith("update event_log set status = 'done'"))).toBe(false);
    const volta = pool.query.mock.calls.find(([sql]) => String(sql).includes("set status = $2, last_error"));
    expect(volta?.[1]?.[1]).toBe("pending");
  });
});
