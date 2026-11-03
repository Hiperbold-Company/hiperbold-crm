/**
 * Devolver o turno à IA (`devolverTurnoAoAgente`): só emite o despacho quando é
 * seguro afirmar que a IA não atendeu nem vai atender sozinha.
 *
 * Banco em memória que FILTRA de verdade (eq com caminho de JSON, gte, order,
 * limit, contagem) e grava o que o `emit_event` recebeu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { devolverTurnoAoAgente, devolverTurnoDoInicio, EVENTO_DE_DESPACHO_DO_AGENTE } from "./devolver-turno";

type Linha = Record<string, unknown>;

function valor(linha: Linha, caminho: string): unknown {
  return caminho
    .replace(/->>/g, "->")
    .split("->")
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === "object" ? (acc as Linha)[k] : undefined),
      linha,
    );
}

function criarBanco(tabelas: Record<string, Linha[]>) {
  const emitidos: Linha[] = [];
  const admin = {
    rpc(nome: string, args: Linha) {
      if (nome === "emit_event") emitidos.push(args);
      return Promise.resolve({ data: null, error: null });
    },
    from(tabela: string) {
      const filtros: Array<(l: Linha) => boolean> = [];
      const ordens: Array<{ col: string; asc: boolean }> = [];
      let limite = Infinity;
      let contar = false;
      const executar = () => {
        let linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        linhas = [...linhas].sort((a, b) => {
          for (const { col, asc } of ordens) {
            const x = String(a[col] ?? ""),
              y = String(b[col] ?? "");
            if (x !== y) return asc ? x.localeCompare(y) : y.localeCompare(x);
          }
          return 0;
        });
        return linhas.slice(0, limite);
      };
      const b: Record<string, unknown> = {
        select(_c?: string, o?: { count?: string }) {
          contar = Boolean(o?.count);
          return b;
        },
        eq(col: string, v: unknown) {
          filtros.push((l) => valor(l, col) === v);
          return b;
        },
        gte(col: string, v: string) {
          filtros.push((l) => String(valor(l, col)) >= v);
          return b;
        },
        order(col: string, o?: { ascending?: boolean }) {
          ordens.push({ col, asc: o?.ascending !== false });
          return b;
        },
        limit(n: number) {
          limite = n;
          return b;
        },
        maybeSingle() {
          return Promise.resolve({ data: executar()[0] ?? null, error: null });
        },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          const linhas = executar();
          return Promise.resolve(
            contar
              ? { data: null, count: linhas.length, error: null }
              : { data: linhas, error: null },
          ).then(res, rej);
        },
      };
      return b;
    },
  };
  return { admin: admin as unknown as SupabaseClient, emitidos };
}

const ORG = "org-1";
const ENR = "enr-1";
const DESDE = "2026-11-03T12:00:00.000Z";

function base(over: Record<string, Linha[]> = {}): Record<string, Linha[]> {
  return {
    messages: [
      {
        id: "out-1",
        organization_id: ORG,
        conversation_id: "conv-wa",
        direction: "outbound",
        created_at: "2026-11-03T12:00:00.000Z",
        sent_at: "2026-11-03T12:00:00.000Z",
        metadata: { origem_automacao: { enrollment_id: ENR } },
      },
      {
        id: "in-1",
        organization_id: ORG,
        conversation_id: "conv-wa",
        direction: "inbound",
        created_at: "2026-11-03T12:01:00.000Z",
        sent_at: "2026-11-03T12:01:00.000Z",
        metadata: {},
      },
    ],
    conversations: [
      {
        id: "conv-wa",
        organization_id: ORG,
        contact_id: "c-1",
        channel_session_id: "sess-1",
        is_group: false,
      },
    ],
    event_log: [
      {
        id: "ev-1",
        organization_id: ORG,
        event_type: EVENTO_DE_DESPACHO_DO_AGENTE,
        entity_id: "in-1",
        status: "done",
      },
    ],
    job_queue: [],
    ...over,
  };
}

const pedido = { organizationId: ORG, enrollmentId: ENR, desde: DESDE };

describe("devolver o turno à IA", () => {
  it("a IA cedeu e ninguém respondeu: emite o despacho da última mensagem da conversa onde a automação falou", async () => {
    const { admin, emitidos } = criarBanco(base());
    expect(await devolverTurnoAoAgente(admin, pedido)).toBe("emitido");
    expect(emitidos).toHaveLength(1);
    expect(emitidos[0]).toMatchObject({
      p_event_type: EVENTO_DE_DESPACHO_DO_AGENTE,
      p_entity_id: "in-1",
      p_organization_id: ORG,
      p_payload: {
        conversation_id: "conv-wa",
        contact_id: "c-1",
        channel_session_id: "sess-1",
        inbound_message_id: "in-1",
      },
    });
  });

  it("o despacho daquela mensagem ainda está pendente: não emite (o drain responde sozinho)", async () => {
    const { admin, emitidos } = criarBanco(
      base({
        event_log: [
          {
            id: "ev-1",
            organization_id: ORG,
            event_type: EVENTO_DE_DESPACHO_DO_AGENTE,
            entity_id: "in-1",
            status: "pending",
          },
        ],
      }),
    );
    expect(await devolverTurnoAoAgente(admin, pedido)).toBe("despacho_em_curso");
    expect(emitidos).toHaveLength(0);
  });

  it("a IA já teve turno com o contato desde o início da espera: não emite", async () => {
    const { admin, emitidos } = criarBanco(
      base({
        job_queue: [
          {
            id: "j1",
            organization_id: ORG,
            contact_id: "c-1",
            kind: "inbound_turn",
            created_at: "2026-11-03T12:01:05.000Z",
          },
        ],
      }),
    );
    expect(await devolverTurnoAoAgente(admin, pedido)).toBe("ia_ja_atendeu");
    expect(emitidos).toHaveLength(0);
  });

  it("turno antigo (antes da espera) ou de outra organização não impede", async () => {
    const { admin, emitidos } = criarBanco(
      base({
        job_queue: [
          {
            id: "j0",
            organization_id: ORG,
            contact_id: "c-1",
            kind: "inbound_turn",
            created_at: "2026-11-03T11:00:00.000Z",
          },
          {
            id: "j2",
            organization_id: "org-2",
            contact_id: "c-1",
            kind: "inbound_turn",
            created_at: "2026-11-03T12:01:05.000Z",
          },
        ],
      }),
    );
    expect(await devolverTurnoAoAgente(admin, pedido)).toBe("emitido");
    expect(emitidos).toHaveLength(1);
  });

  it("a execução nunca falou numa conversa, ou a mensagem é de antes da espera: não emite", async () => {
    const semEnvio = criarBanco(
      base({ messages: base().messages!.filter((m) => m.direction === "inbound") }),
    );
    expect(await devolverTurnoAoAgente(semEnvio.admin, pedido)).toBe("sem_conversa");
    const antiga = criarBanco(base());
    expect(
      await devolverTurnoAoAgente(antiga.admin, { ...pedido, desde: "2026-11-03T12:05:00.000Z" }),
    ).toBe("sem_inbound");
    expect(semEnvio.emitidos.length + antiga.emitidos.length).toBe(0);
  });
});

describe("devolver o turno do INÍCIO (a mensagem que iniciou a automação)", () => {
  // A mensagem do gatilho é a `in-1`; a execução nasceu dela e terminou.
  const doInicio = {
    organizationId: ORG,
    enrollmentId: "enr-inicio",
    conversationId: "conv-wa",
    messageId: "in-1",
  };

  it("a execução terminou SEM falar na conversa: emite o despacho da última mensagem do contato", async () => {
    const { admin, emitidos } = criarBanco(base());
    expect(await devolverTurnoDoInicio(admin, doInicio)).toBe("emitido");
    expect(emitidos).toHaveLength(1);
    expect(emitidos[0]).toMatchObject({ p_entity_id: "in-1", p_organization_id: ORG });
  });

  it("a execução falou na conversa: não devolve (a automação respondeu)", async () => {
    const t = base();
    t.messages!.push({
      id: "out-2",
      organization_id: ORG,
      conversation_id: "conv-wa",
      direction: "outbound",
      created_at: "2026-11-03T12:01:10.000Z",
      metadata: { origem_automacao: { enrollment_id: "enr-inicio" } },
    });
    const { admin, emitidos } = criarBanco(t);
    expect(await devolverTurnoDoInicio(admin, doInicio)).toBe("automacao_falou");
    expect(emitidos).toHaveLength(0);
  });

  it("a IA já teve turno depois da mensagem (não tinha cedido): não devolve", async () => {
    const { admin, emitidos } = criarBanco(
      base({
        job_queue: [
          {
            id: "j1",
            organization_id: ORG,
            contact_id: "c-1",
            kind: "inbound_turn",
            created_at: "2026-11-03T12:01:02.000Z",
          },
        ],
      }),
    );
    expect(await devolverTurnoDoInicio(admin, doInicio)).toBe("ia_ja_atendeu");
    expect(emitidos).toHaveLength(0);
  });

  it("mensagem de outra organização: não acha e não emite", async () => {
    const { admin, emitidos } = criarBanco(base());
    expect(await devolverTurnoDoInicio(admin, { ...doInicio, organizationId: "org-2" })).toBe("sem_inbound");
    expect(emitidos).toHaveLength(0);
  });
});
