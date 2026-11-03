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
import { semRespostaDesde, varrerSemResposta, type SemRespostaDb } from "./varredura-sem-resposta";

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
      ultimaSaida: async () => ({ id: "msg-out-1", pointer_id: null }),
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
    const d2 = { ...d, ultimaSaida: async () => ({ id: "msg-out-2", pointer_id: null }) };
    expect((await varrerSemResposta(d2, AGORA)).iniciadas).toBe(1);
  });
  it("a última mensagem foi da própria automação: não se rearma (anti-laço); de outra automação, arma", async () => {
    const propria = db({ ultimaSaida: async () => ({ id: "m", pointer_id: "ptr-1" }) });
    expect((await varrerSemResposta(propria.d, AGORA)).iniciadas).toBe(0);
    const outra = db({ ultimaSaida: async () => ({ id: "m", pointer_id: "ptr-9" }) });
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
