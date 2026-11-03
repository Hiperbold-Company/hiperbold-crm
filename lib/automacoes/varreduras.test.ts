/**
 * Varreduras de relógio das automações: "Contato sem resposta" e "Data de um
 * campo do negócio". Idempotência pela origem determinística, anti-laço da
 * própria mensagem, janela do horário e a data com antecedência.
 */
import { describe, expect, it } from "vitest";

import { uuidDeterministico } from "./armadas";
import type { InicioDaAutomacao } from "./iniciar";
import {
  dataProcurada,
  dentroDoHorario,
  varrerDatasDasAutomacoes,
  type DataDoNegocioDb,
} from "./varredura-de-data";
import {
  conversaElegivelSemResposta,
  saidaDeCampanha,
  semRespostaDesde,
  TETO_DE_CONVERSAS_SEM_RESPOSTA,
  varrerSemResposta,
  type ConversaCandidata,
  type SemRespostaDb,
  type UltimaSaida,
} from "./varredura-sem-resposta";
import { TETO_POR_ORGANIZACAO } from "@/lib/automation/cron-de-data";

const ORG = "org-1";
const AGORA = new Date("2026-11-03T12:30:00.000Z"); // 09:30 em São Paulo

/** Banco falso do `fn_automacao_iniciar`: `duplicada` quando a origem já abriu execução. */
function motor() {
  const origens = new Set<string>();
  const chamadas: Array<{
    contactId: string;
    originEventId?: string | null;
    vars: Record<string, unknown>;
  }> = [];
  return {
    origens,
    chamadas,
    jaIniciadas: async (_o: string, _p: string, lista: string[]) =>
      new Set(lista.filter((x) => origens.has(x))),
    iniciar: async (input: {
      contactId: string;
      originEventId?: string | null;
      vars: Record<string, unknown>;
    }): Promise<InicioDaAutomacao> => {
      chamadas.push(input);
      if (input.originEventId && origens.has(input.originEventId))
        return { resultado: "duplicada", enrollment_id: null };
      if (input.originEventId) origens.add(input.originEventId);
      return { resultado: "iniciada", enrollment_id: "e" };
    },
  };
}

describe("uuid determinístico", () => {
  it("mesmas partes, mesmo uuid; partes diferentes, outro; formato válido", () => {
    const a = uuidDeterministico("x", "y");
    expect(a).toBe(uuidDeterministico("x", "y"));
    expect(a).not.toBe(uuidDeterministico("x", "z"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

/** Toda conversa pedida tem a mesma última saída. */
function saidaUnica(saida: UltimaSaida): SemRespostaDb["ultimasSaidas"] {
  return async (_o, cs) => new Map(cs.map((c) => [c.id, saida]));
}

describe("sem resposta", () => {
  const conversa = {
    id: "c1",
    contact_id: "ct1",
    last_outbound_at: "2026-11-03T11:00:00.000Z",
    last_inbound_at: "2026-11-03T10:00:00.000Z",
  };
  function db(over: Partial<SemRespostaDb> = {}, m = motor()) {
    const d: SemRespostaDb = {
      automacoesArmadas: async () => [
        {
          id: "ptr-1",
          organization_id: ORG,
          active_version_id: "v1",
          gatilhos: [{ kind: "no_reply", after_minutes: 60, only_if_last_was_outbound: true }],
        },
      ],
      modoLeitura: async () => false,
      conversasCandidatas: async () => [conversa],
      ultimasSaidas: async (_o, cs) =>
        new Map(cs.map((c) => [c.id, { id: "msg-out-1", pointer_id: null }])),
      jaIniciadas: m.jaIniciadas,
      iniciar: m.iniciar,
      ...over,
    };
    return { d, m };
  }
  it("contato que respondeu depois da nossa mensagem não entra", () => {
    expect(semRespostaDesde(conversa)).toBe(true);
    expect(semRespostaDesde({ ...conversa, last_inbound_at: "2026-11-03T11:05:00.000Z" })).toBe(
      false,
    );
    expect(semRespostaDesde({ ...conversa, last_inbound_at: null })).toBe(true);
  });
  it("inicia uma vez por conversa + última mensagem, idempotente entre rodadas", async () => {
    const { d, m } = db();
    expect((await varrerSemResposta(d, AGORA)).iniciadas).toBe(1);
    expect((await varrerSemResposta(d, new Date(AGORA.getTime() + 60_000))).iniciadas).toBe(0);
    expect(m.chamadas).toHaveLength(1);
    expect(m.chamadas[0]!.vars).toMatchObject({
      gatilho: { tipo: "no_reply", conversation_id: "c1", last_message_id: "msg-out-1" },
    });
    // Mensagem nossa NOVA: outra espera.
    const d2 = { ...d, ultimasSaidas: saidaUnica({ id: "msg-out-2", pointer_id: null }) };
    expect((await varrerSemResposta(d2, AGORA)).iniciadas).toBe(1);
  });
  it("a última mensagem foi da própria automação: não se rearma (anti-laço); de outra automação, arma", async () => {
    const propria = db({ ultimasSaidas: saidaUnica({ id: "m", pointer_id: "ptr-1" }) });
    expect((await varrerSemResposta(propria.d, AGORA)).iniciadas).toBe(0);
    const outra = db({ ultimasSaidas: saidaUnica({ id: "m", pointer_id: "ptr-9" }) });
    expect((await varrerSemResposta(outra.d, AGORA)).iniciadas).toBe(1);
  });
  it("organização em modo leitura não inicia; uma automação que falha não cala as outras", async () => {
    expect(
      (await varrerSemResposta(db({ modoLeitura: async () => true }).d, AGORA)).iniciadas,
    ).toBe(0);
    const r = await varrerSemResposta(
      db({
        conversasCandidatas: async () => {
          throw new Error("x");
        },
      }).d,
      AGORA,
    );
    expect(r.falhas).toBe(1);
  });
  it("a janela pedida ao banco termina em agora − after_minutes", async () => {
    let janela: [string, string] | null = null;
    await varrerSemResposta(
      db({ conversasCandidatas: async (_o, desde, ate) => ((janela = [desde, ate]), []) }).d,
      AGORA,
    );
    expect(janela).toEqual(["2026-11-03T10:30:00.000Z", "2026-11-03T11:30:00.000Z"]);
  });
});

describe("data de um campo do negócio", () => {
  it("horário: a partir de HH:MM, dentro da janela", () => {
    expect(dentroDoHorario(9, 30, "09:00")).toBe(true);
    expect(dentroDoHorario(8, 59, "09:00")).toBe(false);
    expect(dentroDoHorario(12, 0, "09:00")).toBe(false);
  });
  it("antecedência: -3 procura a data daqui a 3 dias; 2 procura a de 2 dias atrás", () => {
    expect(dataProcurada("2026-11-03", -3)).toBe("2026-11-06");
    expect(dataProcurada("2026-11-03", 2)).toBe("2026-11-01");
  });
  function db(time: string, m = motor(), valor: unknown = "06/11/2026") {
    const pedidos: string[] = [];
    const d: DataDoNegocioDb = {
      automacoesArmadas: async () => [
        {
          id: "ptr-1",
          organization_id: ORG,
          active_version_id: "v1",
          gatilhos: [
            {
              kind: "date_field",
              field: { scope: "lead_custom", key: "casamento" },
              offset_days: -3,
              time,
            },
          ],
        },
      ],
      fusoDaOrganizacao: async () => "America/Sao_Paulo",
      modoLeitura: async () => false,
      negociosNaData: async (_o, _c, dia) => (
        pedidos.push(dia),
        [
          { id: "l1", contact_id: "ct1", valor },
          { id: "l2", contact_id: null, valor },
        ]
      ),
      jaIniciadas: m.jaIniciadas,
      iniciar: m.iniciar,
    };
    return { d, m, pedidos };
  }
  it("inicia no horário, para o negócio cuja data casa (formato brasileiro), uma vez só", async () => {
    const { d, m, pedidos } = db("09:00");
    expect((await varrerDatasDasAutomacoes(d, AGORA)).iniciadas).toBe(1);
    expect(pedidos).toEqual(["2026-11-06"]);
    expect(m.chamadas[0]).toMatchObject({
      contactId: "ct1",
      vars: { _lead_id: "l1", gatilho: { tipo: "date_field", data: "2026-11-06" } },
    });
    expect(
      (await varrerDatasDasAutomacoes(d, new Date(AGORA.getTime() + 3_600_000))).iniciadas,
    ).toBe(0);
  });
  it("antes do horário não faz nada; data que não casa não inicia", async () => {
    expect((await varrerDatasDasAutomacoes(db("10:00").d, AGORA)).iniciadas).toBe(0);
    expect(
      (await varrerDatasDasAutomacoes(db("09:00", motor(), "2026-11-07").d, AGORA)).iniciadas,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Correções da revisão (itens 4, 5, 9)
// ---------------------------------------------------------------------------

const ENR_A = "a0000000-0000-4000-8000-000000000001";

/**
 * O `fn_automacao_iniciar` em memória com a guarda de CICLO: a execução nova
 * recusa quando o pointer dela aparece na cadeia de mães (A → B → A).
 */
function motorComCiclo() {
  const execucoes = new Map<string, { pointer: string; mae: string | null }>();
  const origens = new Set<string>();
  let n = 0;
  return {
    execucoes,
    jaIniciadas: async (_o: string, _p: string, lista: string[]) => new Set(lista.filter((x) => origens.has(x))),
    iniciar: async (input: {
      pointerId: string;
      originEventId?: string | null;
      parentEnrollmentId?: string | null;
    }): Promise<InicioDaAutomacao> => {
      for (let m = input.parentEnrollmentId ?? null; m; m = execucoes.get(m)?.mae ?? null) {
        if (execucoes.get(m)?.pointer === input.pointerId) return { resultado: "ciclo", enrollment_id: null };
      }
      if (input.originEventId) origens.add(input.originEventId);
      const id = `b0000000-0000-4000-8000-00000000000${++n}`;
      execucoes.set(id, { pointer: input.pointerId, mae: input.parentEnrollmentId ?? null });
      return { resultado: "iniciada", enrollment_id: id };
    },
  };
}

describe("sem resposta: laço A ↔ B (item 4)", () => {
  const armada = (id: string) => ({
    id,
    organization_id: ORG,
    active_version_id: "v",
    gatilhos: [{ kind: "no_reply" as const, after_minutes: 60, only_if_last_was_outbound: true as const }],
  });
  const conversa: ConversaCandidata = {
    id: "c1",
    contact_id: "ct1",
    last_outbound_at: "2026-11-03T11:00:00.000Z",
    last_inbound_at: null,
  };
  it("a última saída veio de outra automação: a execução dela é a mãe, e A → B → A é barrado", async () => {
    const m = motorComCiclo();
    m.execucoes.set(ENR_A, { pointer: "ptr-A", mae: null });
    const pedidos: Array<string | null | undefined> = [];
    const iniciar: SemRespostaDb["iniciar"] = async (input) => {
      pedidos.push(input.parentEnrollmentId);
      return m.iniciar(input);
    };
    // 1) A falou e o contato não respondeu: B começa, filha da execução de A.
    const rodada1: SemRespostaDb = {
      automacoesArmadas: async () => [armada("ptr-B")],
      modoLeitura: async () => false,
      conversasCandidatas: async () => [conversa],
      ultimasSaidas: saidaUnica({ id: "out-a", pointer_id: "ptr-A", enrollment_id: ENR_A, status: "sent" }),
      jaIniciadas: m.jaIniciadas,
      iniciar,
    };
    expect((await varrerSemResposta(rodada1, AGORA)).iniciadas).toBe(1);
    expect(pedidos[0]).toBe(ENR_A);
    const execB = [...m.execucoes.entries()].find(([, e]) => e.pointer === "ptr-B")![0];
    // 2) B falou e o contato não respondeu: A NÃO recomeça (ciclo).
    const rodada2: SemRespostaDb = {
      ...rodada1,
      automacoesArmadas: async () => [armada("ptr-A")],
      ultimasSaidas: saidaUnica({ id: "out-b", pointer_id: "ptr-B", enrollment_id: execB, status: "sent" }),
    };
    const r = await varrerSemResposta(rodada2, AGORA);
    expect(pedidos[1]).toBe(execB);
    expect(r.iniciadas).toBe(0);
    expect(r.ignoradas).toBe(1);
  });
});

describe("sem resposta: quem não entra, e a paginação (item 9)", () => {
  const base: ConversaCandidata = {
    id: "c1",
    contact_id: "ct1",
    last_outbound_at: "2026-11-03T11:00:00.000Z",
    last_inbound_at: null,
    status: "open",
  };
  it("conversa fechada ou com humano no comando não é elegível", () => {
    expect(conversaElegivelSemResposta(base, AGORA)).toBe(true);
    expect(conversaElegivelSemResposta({ ...base, status: "resolved" }, AGORA)).toBe(false);
    expect(conversaElegivelSemResposta({ ...base, status: "archived" }, AGORA)).toBe(false);
    expect(conversaElegivelSemResposta({ ...base, assignee_kind: "user" }, AGORA)).toBe(false);
    expect(conversaElegivelSemResposta({ ...base, force_human: true }, AGORA)).toBe(false);
    expect(
      conversaElegivelSemResposta({ ...base, bot_silenced_until: "2026-11-03T13:00:00.000Z" }, AGORA),
    ).toBe(false);
    expect(
      conversaElegivelSemResposta({ ...base, bot_silenced_until: "2026-11-03T12:00:00.000Z" }, AGORA),
    ).toBe(true);
  });
  it("marca de campanha: source campaign/campaign_test ou campaign_id", () => {
    expect(saidaDeCampanha({ source: "campaign", campaign_id: "x" })).toBe(true);
    expect(saidaDeCampanha({ source: "campaign_test" })).toBe(true);
    expect(saidaDeCampanha({ campaign_id: "x" })).toBe(true);
    expect(saidaDeCampanha({ origem_automacao: { pointer_id: "p" } })).toBe(false);
    expect(saidaDeCampanha(null)).toBe(false);
  });
  function dbSemResposta(conversas: ConversaCandidata[], saidas: (c: ConversaCandidata) => UltimaSaida) {
    const m = motor();
    let leiturasDeSaida = 0;
    const d: SemRespostaDb = {
      automacoesArmadas: async () => [
        {
          id: "ptr-1",
          organization_id: ORG,
          active_version_id: "v1",
          gatilhos: [{ kind: "no_reply", after_minutes: 60, only_if_last_was_outbound: true }],
        },
      ],
      modoLeitura: async () => false,
      conversasCandidatas: async (_o, _d, _a, pagina) =>
        conversas.slice(pagina?.offset ?? 0, (pagina?.offset ?? 0) + (pagina?.limite ?? 200)),
      ultimasSaidas: async (_o, cs) => {
        leiturasDeSaida++;
        return new Map(cs.map((c) => [c.id, saidas(c)]));
      },
      jaIniciadas: m.jaIniciadas,
      iniciar: m.iniciar,
    };
    return { d, m, leituras: () => leiturasDeSaida };
  }
  it("saída que falhou e saída de campanha não iniciam", async () => {
    const conversas = [base, { ...base, id: "c2" }, { ...base, id: "c3" }];
    const { d, m } = dbSemResposta(conversas, (c) =>
      c.id === "c1"
        ? { id: "o1", pointer_id: null, status: "failed" }
        : c.id === "c2"
          ? { id: "o2", pointer_id: null, status: "sent", campanha: true }
          : { id: "o3", pointer_id: null, status: "sent" },
    );
    expect((await varrerSemResposta(d, AGORA)).iniciadas).toBe(1);
    expect(m.chamadas.map((c) => (c.vars.gatilho as { conversation_id: string }).conversation_id)).toEqual(["c3"]);
  });
  it("mais candidatas que uma página: todas iniciam (sem starvation) e a saída é lida uma vez por página", async () => {
    const total = TETO_DE_CONVERSAS_SEM_RESPOSTA * 2 + 50;
    const conversas = Array.from({ length: total }, (_, i) => ({ ...base, id: `c${i}`, contact_id: `ct${i}` }));
    const { d, m, leituras } = dbSemResposta(conversas, (c) => ({ id: `o-${c.id}`, pointer_id: null, status: "sent" }));
    expect((await varrerSemResposta(d, AGORA)).iniciadas).toBe(total);
    expect(new Set(m.chamadas.map((c) => c.contactId)).size).toBe(total);
    expect(leituras()).toBe(3);
    // Na rodada seguinte, todas já iniciadas: nenhuma de novo.
    expect((await varrerSemResposta(d, new Date(AGORA.getTime() + 60_000))).iniciadas).toBe(0);
  });
});

describe("data do negócio: paginação e só abertos (item 5)", () => {
  function dbData(total: number, comAbertos?: (aberto: boolean) => void) {
    const m = motor();
    const negocios = Array.from({ length: total }, (_, i) => ({
      id: `l${String(i).padStart(4, "0")}`,
      contact_id: `ct${i}`,
      valor: "2026-11-06",
    }));
    const d: DataDoNegocioDb = {
      automacoesArmadas: async () => [
        {
          id: "ptr-1",
          organization_id: ORG,
          active_version_id: "v1",
          gatilhos: [
            { kind: "date_field", field: { scope: "lead", key: "expected_close_date" }, offset_days: -3, time: "09:00" },
          ],
        },
      ],
      fusoDaOrganizacao: async () => "America/Sao_Paulo",
      modoLeitura: async () => false,
      negociosNaData: async (_o, _c, _dia, pagina) => {
        comAbertos?.(pagina?.apenasAbertos ?? true);
        const de = pagina?.offset ?? 0;
        return negocios.slice(de, de + (pagina?.limite ?? TETO_POR_ORGANIZACAO));
      },
      jaIniciadas: m.jaIniciadas,
      iniciar: m.iniciar,
    };
    return { d, m };
  }
  it("acima de uma página, nenhum negócio fica de fora", async () => {
    const total = TETO_POR_ORGANIZACAO + 37;
    const { d, m } = dbData(total);
    expect((await varrerDatasDasAutomacoes(d, AGORA)).iniciadas).toBe(total);
    expect(new Set(m.chamadas.map((c) => c.contactId)).size).toBe(total);
  });
  it("only_open ausente pede só abertos; only_open: false pede todos", async () => {
    const vistos: boolean[] = [];
    await varrerDatasDasAutomacoes(dbData(1, (a) => vistos.push(a)).d, AGORA);
    const todos = dbData(1, (a) => vistos.push(a));
    const armadas = await todos.d.automacoesArmadas();
    todos.d.automacoesArmadas = async () => [
      { ...armadas[0]!, gatilhos: [{ ...armadas[0]!.gatilhos[0]!, only_open: false }] },
    ];
    await varrerDatasDasAutomacoes(todos.d, AGORA);
    expect(vistos).toEqual([true, false]);
  });
});
