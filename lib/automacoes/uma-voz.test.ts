import type pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { automacaoEsperaRespostaDoContato } from "./uma-voz";

/** Banco falso que responde como o Postgres: só devolve linha quando a execução espera NESTE contato. */
function banco(execucoes: Array<{ org: string; contato: string; lane: string; status: string }>): Pick<pg.Pool, "query"> {
  return {
    query: (async (sql: string, params: unknown[]) => {
      expect(sql).toContain("lane = 'automacao'");
      expect(sql).toContain("status = 'waiting_reply'");
      const [org, contato] = params as [string, string];
      const rows = execucoes.filter(
        (e) => e.org === org && e.contato === contato && e.lane === "automacao" && e.status === "waiting_reply",
      );
      return { rows: rows.map(() => ({ "?column?": 1 })) };
    }) as unknown as pg.Pool["query"],
  };
}

const pedido = { organizationId: "org-1", contactId: "c-1" };

describe("uma voz: automação esperando resposta cala a IA daquele contato", () => {
  it("com espera: a IA cede", async () => {
    expect(
      await automacaoEsperaRespostaDoContato(banco([{ org: "org-1", contato: "c-1", lane: "automacao", status: "waiting_reply" }]), pedido),
    ).toBe(true);
  });
  it("sem espera (execução andando, outra raia, outro contato): a IA responde", async () => {
    const execucoes = [
      { org: "org-1", contato: "c-1", lane: "automacao", status: "active" },
      { org: "org-1", contato: "c-1", lane: "followup", status: "waiting_reply" },
      { org: "org-1", contato: "c-2", lane: "automacao", status: "waiting_reply" },
      { org: "org-2", contato: "c-1", lane: "automacao", status: "waiting_reply" },
    ];
    expect(await automacaoEsperaRespostaDoContato(banco(execucoes), pedido)).toBe(false);
  });
  it("consulta que falha não cala a IA (fail-open)", async () => {
    const quebrado = { query: (async () => { throw new Error("db fora"); }) as unknown as pg.Pool["query"] };
    expect(await automacaoEsperaRespostaDoContato(quebrado, pedido)).toBe(false);
  });
  it("o drain do agente consulta a espera antes de enfileirar o turno", () => {
    const fonte = readFileSync(path.join(process.cwd(), "lib/agent-engine/edge/crm/drain.ts"), "utf8");
    const consulta = fonte.indexOf("automacaoEsperaRespostaDoContato(pool");
    expect(consulta).toBeGreaterThan(0);
    expect(consulta).toBeLessThan(fonte.indexOf("deveCederTurnoAoRetorno(pool"));
  });
});
