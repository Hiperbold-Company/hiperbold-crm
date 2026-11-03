/**
 * Na AUTOMAÇÃO, "Esperar um tempo" (`wait` modo `delay`) é tempo puro: a
 * mensagem do contato não corta o timer. Quem quer reagir à resposta usa
 * `until_reply`, que estaciona em `waiting_reply` e continua acordando. Os
 * follow-ups seguem como sempre: a resposta corta a espera `fixed`.
 *
 * Duas camadas medidas: a regra da reatividade (com o DB estreito em memória)
 * e o adapter de produção, que precisa trazer `lane` e o modo do nó — sem isso
 * a regra nunca vê o `delay` e o bug volta.
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventRow } from "@/lib/event-log/dispatcher";
import type { EnrollmentPatch } from "./engine";
import {
  applyReactivityEvent,
  createSupabaseReactivityClient,
  modoDoWait,
  type LiveEnrollmentRef,
  type ReactivityAdminClient,
} from "./reactivity";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const AGORA = "2026-11-03T12:00:00.000Z";

function montarDb(inscricoes: LiveEnrollmentRef[]) {
  const eventos: string[] = [];
  const patches: Array<{ id: string; patch: EnrollmentPatch }> = [];
  const db: ReactivityAdminClient = {
    async loadConversationContactId() {
      return CONTATO;
    },
    async loadContactBlocked() {
      return false;
    },
    async loadLiveEnrollmentsForContact(_o, _c, statuses) {
      const ok = statuses ?? ["active", "waiting_reply", "paused_handoff"];
      return inscricoes.filter((e) => ok.includes(e.status));
    },
    async insertEnrollmentEvent(ev) {
      eventos.push(ev.event_type);
      return { inserted: true };
    },
    async updateEnrollment(id, _o, patch) {
      patches.push({ id, patch });
    },
    async agoraNoBanco() {
      return AGORA;
    },
  };
  return { db, eventos, patches };
}

function inscricao(over: Partial<LiveEnrollmentRef>): LiveEnrollmentRef {
  return {
    id: "enr-1",
    status: "active",
    current_node_id: "w1",
    steps_taken: 3,
    pointer_id: "ptr-1",
    handoff_policy: "pause",
    trigger_config: null,
    ...over,
  };
}

const inbound: EventRow = {
  id: "33333333-3333-4333-8333-333333333333",
  organization_id: ORG,
  event_type: "message.received",
  entity_kind: "message",
  entity_id: null,
  payload: { contact_id: CONTATO, direction: "inbound" },
  metadata: {},
  consumed_by: [],
  attempts: 0,
};

describe("reatividade — Esperar um tempo da automação", () => {
  it("automação em `delay` não é acordada pela mensagem do contato", async () => {
    const { db, eventos, patches } = montarDb([
      inscricao({ lane: "automacao", wait_mode: "delay" }),
    ]);
    const s = await applyReactivityEvent(db, () => new Date(AGORA), inbound);
    expect(s.reacted).toBe(0);
    expect(eventos).toEqual([]);
    expect(patches).toEqual([]);
  });

  it("follow-up em `fixed` continua acordando (a resposta corta o timer)", async () => {
    const { db, eventos, patches } = montarDb([
      inscricao({ lane: "followup", wait_mode: "fixed" }),
    ]);
    const s = await applyReactivityEvent(db, () => new Date(AGORA), inbound);
    expect(s.reacted).toBe(1);
    expect(eventos).toEqual(["inbound_woke"]);
    expect(patches[0]?.patch.next_eval_at).toBe(AGORA);
  });

  it("follow-up sem raia declarada (adapter antigo) continua acordando", async () => {
    const { db, eventos } = montarDb([inscricao({})]);
    await applyReactivityEvent(db, () => new Date(AGORA), inbound);
    expect(eventos).toEqual(["inbound_woke"]);
  });

  it("automação em `until_reply` (waiting_reply) continua acordando", async () => {
    const { db, eventos, patches } = montarDb([
      inscricao({ lane: "automacao", status: "waiting_reply", wait_mode: null }),
    ]);
    const s = await applyReactivityEvent(db, () => new Date(AGORA), inbound);
    expect(s.reacted).toBe(1);
    expect(eventos).toEqual(["inbound_woke"]);
    expect(patches[0]?.patch.next_eval_at).toBe(AGORA);
  });
});

describe("modoDoWait", () => {
  const grafo = {
    nodes: [
      { id: "w1", type: "wait", config: { mode: "delay", duration_s: 60 } },
      { id: "m1", type: "message", config: { mode: "x" } },
    ],
  };
  it("lê o modo do wait atual", () => expect(modoDoWait(grafo, "w1")).toBe("delay"));
  it("nó que não é wait devolve null", () => expect(modoDoWait(grafo, "m1")).toBeNull());
  it("grafo ausente ou malformado não lança", () => {
    expect(modoDoWait(null, "w1")).toBeNull();
    expect(modoDoWait({ nodes: "x" }, "w1")).toBeNull();
  });
});

/** Query builder mínimo do supabase-js: guarda filtros e resolve a tabela. */
function fakeSupabase(tabelas: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(tabela: string) {
      const filtros: Array<(r: Record<string, unknown>) => boolean> = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((r) => r[c] === v), q),
        in: (c: string, vs: unknown[]) => (filtros.push((r) => vs.includes(r[c])), q),
        is: () => q,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (res: (v: { data: unknown; error: null }) => unknown) =>
          res({ data: rows(), error: null }),
      };
      const rows = () => (tabelas[tabela] ?? []).filter((r) => filtros.every((f) => f(r)));
      return q;
    },
  } as unknown as SupabaseClient;
}

describe("adapter de produção — traz raia e modo do nó", () => {
  it("automação ativa no `delay` sai com lane=automacao e wait_mode=delay; follow-up sai com lane=followup", async () => {
    const admin = fakeSupabase({
      contacts: [{ id: CONTATO, organization_id: ORG, phone_number: null }],
      followup_enrollments: [
        {
          id: "a1",
          organization_id: ORG,
          contact_id: CONTATO,
          status: "active",
          lane: "automacao",
          version_id: "v1",
          current_node_id: "w1",
          steps_taken: 2,
          pointer_id: "p1",
          updated_at: AGORA,
        },
        {
          id: "f1",
          organization_id: ORG,
          contact_id: CONTATO,
          status: "active",
          lane: "followup",
          version_id: "v2",
          current_node_id: "w9",
          steps_taken: 1,
          pointer_id: "p2",
          updated_at: AGORA,
        },
      ],
      followup_flow_pointers: [
        { id: "p1", organization_id: ORG, handoff_policy: "pause", trigger_config: null },
        { id: "p2", organization_id: ORG, handoff_policy: "pause", trigger_config: null },
      ],
      followup_flow_versions: [
        {
          id: "v1",
          organization_id: ORG,
          graph: {
            nodes: [{ id: "w1", type: "wait", config: { mode: "delay", duration_s: 86400 } }],
          },
        },
      ],
    });
    const db = createSupabaseReactivityClient(admin);
    const vivos = await db.loadLiveEnrollmentsForContact(ORG, CONTATO, [
      "active",
      "waiting_reply",
      "paused_handoff",
      "dormente",
      "coletando",
    ]);
    const a = vivos.find((e) => e.id === "a1");
    const f = vivos.find((e) => e.id === "f1");
    expect(a).toMatchObject({ lane: "automacao", wait_mode: "delay" });
    expect(f).toMatchObject({ lane: "followup", wait_mode: null });
  });
});
