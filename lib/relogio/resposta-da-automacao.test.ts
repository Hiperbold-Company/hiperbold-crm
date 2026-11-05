/**
 * O relógio diante da resposta a um bloco de conversa:
 *  - acorda pela EXISTÊNCIA de inbound (áudio/imagem sem texto acordam);
 *  - reação e marca de tipo não suportado não acordam;
 *  - folga de 5 s só no relógio do provedor (`sent_at`), nunca no nosso;
 *  - a raia `automacao` vem primeiro no corte de 2000 por tick.
 *
 * Banco em memória que filtra de verdade (`tests/helpers/banco-em-memoria.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/v1/cron/recover-stuck-messages/route", () => ({
  recoverStuckMessages: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { criarBancoEmMemoria, type Linha } from "../../tests/helpers/banco-em-memoria";

import {
  acordarAutomacaoEmEspera,
  lerAguardandoResposta,
  TETO_DE_AGUARDANDO_RESPOSTA,
  ultimaRespostaDaAutomacao,
} from "./executar";

const ORG = "org-1";
const C = "c-1";
const ESTACIONOU = "2026-11-03T11:00:00.000Z";
const AGORA = new Date("2026-11-03T12:00:00.000Z");
const seg = (s: number) => new Date(Date.parse(ESTACIONOU) + s * 1000).toISOString();

function msg(over: Linha): Linha {
  return {
    organization_id: ORG,
    contact_id: C,
    direction: "inbound",
    type: "text",
    body: "oi",
    metadata: {},
    ...over,
  };
}

describe("ultimaRespostaDaAutomacao", () => {
  it("áudio sem texto conta: acorda pela existência", async () => {
    const b = criarBancoEmMemoria({
      messages: [
        msg({ id: "a", type: "audio", body: null, sent_at: seg(10), created_at: seg(10) }),
      ],
    });
    expect(await ultimaRespostaDaAutomacao(b as unknown as SupabaseClient, ORG, [C])).toEqual({
      sent_at: seg(10),
      created_at: seg(10),
    });
  });

  it("reação e marca de tipo não suportado não contam: vale a mensagem anterior a elas (ou nenhuma)", async () => {
    const b = criarBancoEmMemoria({
      messages: [
        msg({ id: "t", body: "2", sent_at: seg(10), created_at: seg(10) }),
        msg({ id: "r", type: "reaction", body: "👍", sent_at: seg(20), created_at: seg(20) }),
        msg({
          id: "u",
          body: "[tipo de mensagem não suportado: order]",
          sent_at: seg(30),
          created_at: seg(30),
        }),
      ],
    });
    expect(await ultimaRespostaDaAutomacao(b as unknown as SupabaseClient, ORG, [C])).toEqual({
      sent_at: seg(10),
      created_at: seg(10),
    });

    const so = criarBancoEmMemoria({
      messages: [
        msg({ id: "r", type: "reaction", body: "👍", sent_at: seg(20), created_at: seg(20) }),
      ],
    });
    expect(await ultimaRespostaDaAutomacao(so as unknown as SupabaseClient, ORG, [C])).toBeNull();
  });

  it("inclui os gêmeos passados e nunca outra organização", async () => {
    const b = criarBancoEmMemoria({
      messages: [
        msg({ id: "g", contact_id: "gemeo", sent_at: seg(10), created_at: seg(10) }),
        msg({ id: "o", organization_id: "org-2", sent_at: seg(50), created_at: seg(50) }),
      ],
    });
    expect(
      await ultimaRespostaDaAutomacao(b as unknown as SupabaseClient, ORG, [C, "gemeo"]),
    ).toEqual({ sent_at: seg(10), created_at: seg(10) });
  });
});

describe("acordarAutomacaoEmEspera: a folga de 5 s", () => {
  function cenario() {
    const enrollments: Linha[] = [
      {
        id: "enr-1",
        organization_id: ORG,
        lane: "automacao",
        status: "waiting_reply",
        next_eval_at: "2026-11-04T00:00:00.000Z",
      },
    ];
    const b = criarBancoEmMemoria({
      followup_enrollments: enrollments,
      followup_enrollment_events: [
        {
          organization_id: ORG,
          enrollment_id: "enr-1",
          node_id: "q",
          event_type: "wait_started",
          created_at: ESTACIONOU,
        },
      ],
    });
    const enr = {
      id: "enr-1",
      organization_id: ORG,
      next_eval_at: "2026-11-04T00:00:00.000Z",
      current_node_id: "q",
    };
    return { admin: b as unknown as SupabaseClient, enr };
  }

  it("relógio do provedor 4 s atrás, chegada depois da espera: acorda", async () => {
    const { admin, enr } = cenario();
    expect(
      await acordarAutomacaoEmEspera(admin, enr, { sent_at: seg(-4), created_at: seg(1) }, AGORA),
    ).toBe(true);
  });

  it("relógio do provedor 6 s atrás: não acorda (mensagem escrita antes da pergunta)", async () => {
    const { admin, enr } = cenario();
    expect(
      await acordarAutomacaoEmEspera(admin, enr, { sent_at: seg(-6), created_at: seg(1) }, AGORA),
    ).toBe(false);
  });

  it("chegou ANTES da espera, mesmo dentro dos 5 s (a mensagem que disparou a automação): não acorda", async () => {
    const { admin, enr } = cenario();
    expect(
      await acordarAutomacaoEmEspera(admin, enr, { sent_at: seg(-2), created_at: seg(-1) }, AGORA),
    ).toBe(false);
  });
});

describe("lerAguardandoResposta: a raia automacao vem primeiro no corte", () => {
  it("com mais follow-ups que o teto, nenhuma automação esperando fica de fora", async () => {
    const linhas: Linha[] = [];
    // ids dos follow-ups MENORES que os das automações: a ordem só por id as cortaria.
    for (let i = 0; i < TETO_DE_AGUARDANDO_RESPOSTA + 300; i++) {
      linhas.push({
        id: `a-${String(i).padStart(5, "0")}`,
        lane: "followup",
        status: "waiting_reply",
      });
    }
    for (let i = 0; i < 50; i++)
      linhas.push({ id: `z-${i}`, lane: "automacao", status: "waiting_reply" });
    const ordens: string[][] = [];
    const admin = {
      from: () => {
        const ordem: string[] = [];
        const q = {
          select: () => q,
          in: () => q,
          // corte das organizações paradas (embed `!inner` + status): todas operantes aqui.
          eq: () => q,
          order: (col: string) => {
            ordem.push(col);
            return q;
          },
          range: async (de: number, ate: number) => {
            ordens.push([...ordem]);
            const sorted = [...linhas].sort((x, y) => {
              for (const col of ordem) {
                const a = String(x[col]),
                  b = String(y[col]);
                if (a !== b) return a < b ? -1 : 1;
              }
              return 0;
            });
            return { data: sorted.slice(de, ate + 1), error: null };
          },
        };
        return q;
      },
    };
    const lidas = (await lerAguardandoResposta(admin as never)) as Linha[];
    expect(lidas).toHaveLength(TETO_DE_AGUARDANDO_RESPOSTA);
    expect(lidas.filter((l) => l.lane === "automacao")).toHaveLength(50);
    expect(ordens[0]).toEqual(["lane", "id"]);
  });
});
