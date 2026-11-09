/**
 * O RETRATO DO PISO OCIOSO RODA CONTRA O BASELINE — e não fecha o portão com
 * trabalho na fila (#3731).
 *
 * `SQL_DO_RETRATO` (`lib/cron/piso-ocioso.ts`) é uma consulta só, com um
 * `exists` por recurso. Os testes unitários semeiam o retrato e nunca executam
 * a consulta, e a regra de falha do portão ("não sei" = roda) torna um erro
 * nela INVISÍVEL: uma coluna com o nome errado não reprova nada, apenas abre
 * todos os portões para sempre e devolve o piso ocioso inteiro. Este arquivo
 * roda a consulta de verdade e cobra os dois lados:
 *
 * 1. banco recém-instalado → as filas saem `false` (a consulta EXECUTOU — o
 *    erro daria `true` em todas);
 * 2. o trabalho que a rodada faz e o predicado da fila não enxergava → `true`.
 *    São os dois casos em que a rodada faz MAIS do que o `select` principal:
 *    - `agenda-reminder` chama `fn_resolver_avisos_de_lembrete_expirados`, que
 *      resolve o aviso de remetente cujo compromisso já passou. Sem compromisso
 *      futuro o portão fechava e o aviso ficava aberto na Central;
 *    - `mcp-oauth-revogacao` poda os pedidos de autorização vencidos há mais de
 *      um dia. Sem credencial vencida o portão fechava e a poda não rodava.
 *
 * Roda só no CI e em `pnpm test:db` (precisa de Postgres).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  esquecerRetrato,
  organizacoesComHistorico,
  recursoTemTrabalho,
  type RecursoDoCron,
} from "@/lib/cron/piso-ocioso";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());
beforeEach(() => esquecerRetrato());

const FILAS: RecursoDoCron[] = [
  "fila_de_soneca",
  "mensagem_presa",
  "redacao_de_storage",
  "devolucao_de_handoff",
  "devolucao_ao_rodizio",
  "canal_vigiado",
  "mcp_a_revogar",
  "lembrete_de_tarefa",
  "lembrete_de_agenda",
  "confirmacao_de_presenca",
  "fila_meta_social",
  "roteamento",
];

async function leitura(recurso: RecursoDoCron): Promise<boolean> {
  esquecerRetrato();
  return recursoTemTrabalho(recurso, Date.now(), pool);
}

/** Insere sem montar a árvore de FKs: o que se mede é o predicado, não o vínculo. */
async function semFk(sql: string, params: unknown[]): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("set session_replication_role = replica");
    await c.query(sql, params);
  } finally {
    await c.query("set session_replication_role = origin");
    c.release();
  }
}

describe("retrato do piso ocioso contra o baseline", () => {
  it("banco recém-instalado: a consulta executa e as filas saem vazias", async () => {
    for (const recurso of FILAS) {
      expect({ recurso, emUso: await leitura(recurso) }).toEqual({ recurso, emUso: false });
    }
  });

  it("aviso de remetente aberto sem compromisso futuro mantém a agenda acordada", async () => {
    const org = randomUUID();
    const aviso = randomUUID();
    await semFk(
      `insert into agent_inbox_items (id, organization_id, kind, title, ref_kind, ref_id, status)
       values ($1, $2, 'other', 'remetente', 'agenda_reminder_sender', $3, 'open')`,
      [aviso, org, randomUUID()],
    );
    try {
      expect(await leitura("lembrete_de_agenda")).toBe(true);
      // controle: é trabalho de verdade — a limpeza da rodada resolve o aviso
      await pool.query("select public.fn_resolver_avisos_de_lembrete_expirados()");
      expect(await leitura("lembrete_de_agenda")).toBe(false);
    } finally {
      await pool.query("delete from agent_inbox_items where id = $1", [aviso]);
    }
  });

  it("pedido de autorização MCP vencido há mais de um dia mantém a revogação acordada", async () => {
    const id = "a".repeat(43);
    await semFk(
      `insert into mcp_oauth_pedidos
         (id, organization_id, servidor_id, contact_id, code_verifier_encrypted, code_verifier_iv, code_verifier_tag, expira_em)
       values ($1, $2, $3, $4, '\\x00', '\\x00', '\\x00', now() - interval '2 days')`,
      [id, randomUUID(), randomUUID(), randomUUID()],
    );
    try {
      expect(await leitura("mcp_a_revogar")).toBe(true);
    } finally {
      await pool.query("delete from mcp_oauth_pedidos where id = $1", [id]);
    }
    expect(await leitura("mcp_a_revogar")).toBe(false);
  });

  it("evento de roteamento pendente liga o recurso; consumido, desliga", async () => {
    const id = randomUUID();
    await semFk(
      `insert into event_log (id, organization_id, event_type, entity_kind, payload, status)
       values ($1, $2, 'conversation.routing_requested', 'conversation', '{}'::jsonb, 'pending')`,
      [id, randomUUID()],
    );
    try {
      expect(await leitura("roteamento")).toBe(true);
      await pool.query("update event_log set status = 'done' where id = $1", [id]);
      expect(await leitura("roteamento")).toBe(false);
    } finally {
      await pool.query("delete from event_log where id = $1", [id]);
    }
  });

  it("organizacoesComHistorico executa contra o baseline e só devolve organização operante com o que olhar", async () => {
    const operante = randomUUID();
    const suspensa = randomUUID();
    const sossegada = randomUUID();
    const orgs = [operante, suspensa, sossegada];
    for (const [org, status] of [
      [operante, "active"],
      [suspensa, "suspended"],
      [sossegada, "active"],
    ] as const) {
      await semFk(`insert into organizations (id, slug, legal_name, display_name, status) values ($1, $2, 'T', 'T', $3)`, [
        org,
        `t-${org.slice(0, 8)}`,
        status,
      ]);
    }
    const eventos = [randomUUID(), randomUUID()];
    try {
      for (const [i, org] of [operante, suspensa].entries()) {
        await semFk(
          `insert into event_log (id, organization_id, event_type, entity_kind, payload, status)
           values ($1, $2, 'channel_session.status_changed', 'channel_session', '{"from_status":"WORKING","to_status":"FAILED"}'::jsonb, 'done')`,
          [eventos[i], org],
        );
      }
      const lista = await organizacoesComHistorico(pool);
      expect(lista).not.toBeNull();
      expect(lista).toContain(operante);
      expect(lista).not.toContain(suspensa);
      expect(lista).not.toContain(sossegada);
    } finally {
      await pool.query("delete from event_log where id = any($1)", [eventos]);
      await pool.query("delete from organizations where id = any($1)", [orgs]);
    }
  });
});
