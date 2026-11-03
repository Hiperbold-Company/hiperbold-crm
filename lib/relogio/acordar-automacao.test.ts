/**
 * `acordarAutomacaoEmEspera`: a automação em `waiting_reply` só é antecipada
 * quando o contato escreveu DEPOIS do último `wait_started` do nó atual.
 *
 * Banco em memória que filtra de verdade e aplica o `update`: o que se mede é
 * o estado final de `followup_enrollments`, inclusive o de outra organização.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

// Dependências de módulo que o relógio importa e esta função não usa.
vi.mock("@/app/api/v1/cron/recover-stuck-messages/route", () => ({
  recoverStuckMessages: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { acordarAutomacaoEmEspera } from "./executar";

type Linha = Record<string, unknown>;

function criarBanco(tabelas: Record<string, Linha[]>) {
  const admin = {
    from(tabela: string) {
      const filtros: Array<(l: Linha) => boolean> = [];
      let ordem: { col: string; asc: boolean } | null = null;
      let limite = Infinity;
      let patch: Linha | null = null;
      const linhas = () => {
        let r = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        if (ordem) {
          const { col, asc } = ordem;
          r = [...r].sort((a, b) => (asc ? 1 : -1) * String(a[col]).localeCompare(String(b[col])));
        }
        return r.slice(0, limite);
      };
      const b: Record<string, unknown> = {
        select: () => b,
        eq(col: string, v: unknown) {
          filtros.push((l) => l[col] === v);
          return b;
        },
        order(col: string, o?: { ascending?: boolean }) {
          ordem = { col, asc: o?.ascending !== false };
          return b;
        },
        limit(n: number) {
          limite = n;
          return b;
        },
        update(p: Linha) {
          patch = p;
          return b;
        },
        maybeSingle: () => Promise.resolve({ data: linhas()[0] ?? null, error: null }),
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          if (patch) for (const l of linhas()) Object.assign(l, patch);
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
  return admin as unknown as SupabaseClient;
}

const AGORA = new Date("2026-11-03T12:00:00.000Z");
const ESTACIONOU = "2026-11-03T11:00:00.000Z";
const DEPOIS = "2026-11-03T11:30:00.000Z";
const ANTES = "2026-11-03T10:30:00.000Z";
const FUTURO = "2026-11-04T11:00:00.000Z";

function cenario(over: { lane?: string; org?: string } = {}) {
  const enrollments: Linha[] = [
    {
      id: "enr-1",
      organization_id: "org-1",
      lane: over.lane ?? "automacao",
      status: "waiting_reply",
      next_eval_at: FUTURO,
    },
    {
      id: "enr-1",
      organization_id: "org-2",
      lane: "automacao",
      status: "waiting_reply",
      next_eval_at: FUTURO,
    },
  ];
  const eventos: Linha[] = [
    {
      organization_id: "org-1",
      enrollment_id: "enr-1",
      node_id: "message-1",
      event_type: "wait_started",
      created_at: ESTACIONOU,
    },
    {
      organization_id: "org-2",
      enrollment_id: "enr-1",
      node_id: "message-1",
      event_type: "wait_started",
      created_at: ESTACIONOU,
    },
  ];
  return {
    enrollments,
    admin: criarBanco({ followup_enrollments: enrollments, followup_enrollment_events: eventos }),
    enr: {
      id: "enr-1",
      organization_id: over.org ?? "org-1",
      next_eval_at: FUTURO,
      current_node_id: "message-1",
    },
  };
}

const proximo = (e: Linha[], org: string) => e.find((l) => l.organization_id === org)!.next_eval_at;

describe("acordarAutomacaoEmEspera", () => {
  it("inbound DEPOIS do último wait_started: next_eval_at vira agora", async () => {
    const { admin, enrollments, enr } = cenario();
    expect(
      await acordarAutomacaoEmEspera(admin, enr, { sent_at: DEPOIS, created_at: DEPOIS }, AGORA),
    ).toBe(true);
    expect(proximo(enrollments, "org-1")).toBe(AGORA.toISOString());
  });

  it("inbound ANTERIOR ao wait_started (já lido): não acorda", async () => {
    const { admin, enrollments, enr } = cenario();
    expect(
      await acordarAutomacaoEmEspera(admin, enr, { sent_at: ANTES, created_at: ANTES }, AGORA),
    ).toBe(false);
    expect(proximo(enrollments, "org-1")).toBe(FUTURO);
  });

  it("data do inbound vazia ou inválida: não acorda", async () => {
    const { admin, enrollments, enr } = cenario();
    expect(await acordarAutomacaoEmEspera(admin, enr, { sent_at: "" }, AGORA)).toBe(false);
    expect(await acordarAutomacaoEmEspera(admin, enr, { sent_at: "não é data" }, AGORA)).toBe(
      false,
    );
    expect(proximo(enrollments, "org-1")).toBe(FUTURO);
  });

  it("sem wait_started para o nó atual: não acorda", async () => {
    const { admin, enrollments, enr } = cenario();
    expect(
      await acordarAutomacaoEmEspera(
        admin,
        { ...enr, current_node_id: "outro-no" },
        { sent_at: DEPOIS, created_at: DEPOIS },
        AGORA,
      ),
    ).toBe(false);
    expect(proximo(enrollments, "org-1")).toBe(FUTURO);
  });

  it("nova espera (nova tentativa) grava wait_started mais recente: o inbound antigo deixa de acordar", async () => {
    const enrollments: Linha[] = [
      {
        id: "enr-1",
        organization_id: "org-1",
        lane: "automacao",
        status: "waiting_reply",
        next_eval_at: FUTURO,
      },
    ];
    const admin = criarBanco({
      followup_enrollments: enrollments,
      followup_enrollment_events: [
        {
          organization_id: "org-1",
          enrollment_id: "enr-1",
          node_id: "message-1",
          event_type: "wait_started",
          created_at: ESTACIONOU,
        },
        {
          organization_id: "org-1",
          enrollment_id: "enr-1",
          node_id: "message-1",
          event_type: "wait_started",
          created_at: "2026-11-03T11:45:00.000Z",
        },
      ],
    });
    const enr = {
      id: "enr-1",
      organization_id: "org-1",
      next_eval_at: FUTURO,
      current_node_id: "message-1",
    };
    expect(
      await acordarAutomacaoEmEspera(admin, enr, { sent_at: DEPOIS, created_at: DEPOIS }, AGORA),
    ).toBe(false);
    expect(enrollments[0]!.next_eval_at).toBe(FUTURO);
  });

  it("execução da lane followup não é tocada por esta função", async () => {
    const { admin, enrollments, enr } = cenario({ lane: "followup" });
    await acordarAutomacaoEmEspera(admin, enr, { sent_at: DEPOIS, created_at: DEPOIS }, AGORA);
    expect(proximo(enrollments, "org-1")).toBe(FUTURO);
  });

  it("outra organização com o mesmo id de execução não é tocada", async () => {
    const { admin, enrollments, enr } = cenario();
    await acordarAutomacaoEmEspera(admin, enr, { sent_at: DEPOIS, created_at: DEPOIS }, AGORA);
    expect(proximo(enrollments, "org-1")).toBe(AGORA.toISOString());
    expect(proximo(enrollments, "org-2")).toBe(FUTURO);
  });

  it("já vencida (next_eval_at <= agora): devolve true sem regravar", async () => {
    const { admin, enrollments, enr } = cenario();
    const vencida = { ...enr, next_eval_at: "2026-11-03T11:59:00.000Z" };
    enrollments[0]!.next_eval_at = vencida.next_eval_at;
    expect(
      await acordarAutomacaoEmEspera(
        admin,
        vencida,
        { sent_at: DEPOIS, created_at: DEPOIS },
        AGORA,
      ),
    ).toBe(true);
    expect(proximo(enrollments, "org-1")).toBe(vencida.next_eval_at);
  });
});
