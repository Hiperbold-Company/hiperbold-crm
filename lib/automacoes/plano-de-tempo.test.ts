import { describe, expect, it } from "vitest";

import {
  fraseDaEsperaAteAData,
  fraseDaEsperaAteODia,
  horaValida,
  instanteAteODia,
  instanteDaDataDoCampo,
} from "./plano-de-tempo";

const SP = "America/Sao_Paulo";
const NY = "America/New_York";
const iso = (d: Date) => d.toISOString();

// Terça-feira, 10/11/2026, 10:00 em São Paulo (UTC-3, sem horário de verão).
const TERCA_10H = new Date("2026-11-10T13:00:00.000Z");

describe("instanteAteODia — São Paulo", () => {
  it("hoje às 11:00, às 10:00: hoje mesmo", () => {
    expect(iso(instanteAteODia({ when: "today", time: "11:00" }, TERCA_10H, SP))).toBe(
      "2026-11-10T14:00:00.000Z",
    );
  });

  it("hoje às 09:00, às 10:00: já passou, segue NA HORA (devolve agora)", () => {
    expect(instanteAteODia({ when: "today", time: "09:00" }, TERCA_10H, SP).getTime()).toBe(
      TERCA_10H.getTime(),
    );
  });

  it("amanhã às 09:00", () => {
    expect(iso(instanteAteODia({ when: "tomorrow", time: "09:00" }, TERCA_10H, SP))).toBe(
      "2026-11-11T12:00:00.000Z",
    );
  });

  it("virada de dia: às 23:30 locais (já dia 11 em UTC), amanhã é o dia 11 local, não o 12", () => {
    const tarde = new Date("2026-11-11T02:30:00.000Z"); // 10/11 23:30 em SP
    expect(iso(instanteAteODia({ when: "tomorrow", time: "09:00" }, tarde, SP))).toBe(
      "2026-11-11T12:00:00.000Z",
    );
    // e "hoje às 23:45" ainda é hoje local
    expect(iso(instanteAteODia({ when: "today", time: "23:45" }, tarde, SP))).toBe(
      "2026-11-11T02:45:00.000Z",
    );
  });

  it("daqui a 3 dias atravessa o fim do mês", () => {
    const dia29 = new Date("2026-11-29T13:00:00.000Z");
    expect(iso(instanteAteODia({ when: "in_days", days: 3, time: "08:30" }, dia29, SP))).toBe(
      "2026-12-02T11:30:00.000Z",
    );
  });

  it("próximo domingo, a partir de uma terça", () => {
    expect(
      iso(instanteAteODia({ when: "next_weekday", weekday: 0, time: "09:00" }, TERCA_10H, SP)),
    ).toBe("2026-11-15T12:00:00.000Z");
  });

  it("próxima terça numa terça: hoje se o horário ainda não chegou; senão daqui a 7 dias", () => {
    expect(
      iso(instanteAteODia({ when: "next_weekday", weekday: 2, time: "11:00" }, TERCA_10H, SP)),
    ).toBe("2026-11-10T14:00:00.000Z");
    expect(
      iso(instanteAteODia({ when: "next_weekday", weekday: 2, time: "09:00" }, TERCA_10H, SP)),
    ).toBe("2026-11-17T12:00:00.000Z");
  });

  it("domingo: de um sábado, 'amanhã' é o domingo e 'próximo domingo' também", () => {
    const sabado = new Date("2026-11-14T15:00:00.000Z"); // sáb 12:00
    const amanha = instanteAteODia({ when: "tomorrow", time: "10:00" }, sabado, SP);
    const proximoDomingo = instanteAteODia(
      { when: "next_weekday", weekday: 0, time: "10:00" },
      sabado,
      SP,
    );
    expect(iso(amanha)).toBe("2026-11-15T13:00:00.000Z");
    expect(iso(proximoDomingo)).toBe(iso(amanha));
  });

  it("hora torta falha aberta: termina na hora", () => {
    expect(instanteAteODia({ when: "tomorrow", time: "25:00" }, TERCA_10H, SP).getTime()).toBe(
      TERCA_10H.getTime(),
    );
  });

  it("fuso inválido cai no padrão do produto (São Paulo)", () => {
    expect(
      iso(instanteAteODia({ when: "tomorrow", time: "09:00" }, TERCA_10H, "Marte/Olympus")),
    ).toBe("2026-11-11T12:00:00.000Z");
  });
});

describe("instanteAteODia — horário de verão (Nova York)", () => {
  it("amanhã 09:00 atravessando o FIM do horário de verão (01/11/2026) continua 09:00 na parede", () => {
    const sabado = new Date("2026-10-31T13:00:00.000Z"); // 09:00 EDT (UTC-4)
    // 24 h depois seria 13:00Z = 08:00 EST. O certo é 09:00 EST = 14:00Z.
    expect(iso(instanteAteODia({ when: "tomorrow", time: "09:00" }, sabado, NY))).toBe(
      "2026-11-01T14:00:00.000Z",
    );
  });

  it("amanhã 09:00 atravessando o INÍCIO do horário de verão (08/03/2026)", () => {
    const sabado = new Date("2026-03-07T14:00:00.000Z"); // 09:00 EST (UTC-5)
    expect(iso(instanteAteODia({ when: "tomorrow", time: "09:00" }, sabado, NY))).toBe(
      "2026-03-08T13:00:00.000Z",
    );
  });

  it("a hora que não existe (02:30 de 08/03) vira um instante real daquele dia, nunca Invalid Date", () => {
    const sabado = new Date("2026-03-07T14:00:00.000Z");
    const r = instanteAteODia({ when: "tomorrow", time: "02:30" }, sabado, NY);
    expect(Number.isNaN(r.getTime())).toBe(false);
    const parede = new Intl.DateTimeFormat("en-CA", {
      timeZone: NY,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(r);
    expect(parede).toBe("2026-03-08");
  });
});

describe("instanteDaDataDoCampo", () => {
  const cfg = { offset_days: -2, time: "09:00" };

  it("ISO e dd/mm/aaaa dão o mesmo instante; 2 dias antes, às 09:00 locais", () => {
    expect(iso(instanteDaDataDoCampo("2026-11-20", cfg, SP)!)).toBe("2026-11-18T12:00:00.000Z");
    expect(iso(instanteDaDataDoCampo("20/11/2026", cfg, SP)!)).toBe("2026-11-18T12:00:00.000Z");
    expect(iso(instanteDaDataDoCampo("2026-11-20T03:00:00Z", cfg, SP)!)).toBe(
      "2026-11-18T12:00:00.000Z",
    );
  });

  it("no dia e depois", () => {
    expect(iso(instanteDaDataDoCampo("2026-11-20", { offset_days: 0, time: "18:00" }, SP)!)).toBe(
      "2026-11-20T21:00:00.000Z",
    );
    expect(iso(instanteDaDataDoCampo("2026-12-31", { offset_days: 1, time: "08:00" }, SP)!)).toBe(
      "2027-01-01T11:00:00.000Z",
    );
  });

  it("vazio, texto, data impossível e hora torta: null (a espera sai por 'Sem data')", () => {
    expect(instanteDaDataDoCampo("", cfg, SP)).toBeNull();
    expect(instanteDaDataDoCampo(undefined, cfg, SP)).toBeNull();
    expect(instanteDaDataDoCampo("amanhã", cfg, SP)).toBeNull();
    expect(instanteDaDataDoCampo("30/02/2026", cfg, SP)).toBeNull();
    expect(instanteDaDataDoCampo("2026-11-20", { offset_days: 0, time: "" }, SP)).toBeNull();
  });
});

describe("frases e hora", () => {
  it("frases legíveis", () => {
    expect(fraseDaEsperaAteODia({ when: "tomorrow", time: "09:00" })).toBe("até amanhã, 09:00");
    expect(fraseDaEsperaAteODia({ when: "today", time: "18:00" })).toBe("até hoje, 18:00");
    expect(fraseDaEsperaAteODia({ when: "in_days", days: 1, time: "09:00" })).toBe(
      "até daqui a 1 dia, 09:00",
    );
    expect(fraseDaEsperaAteODia({ when: "next_weekday", weekday: 1, time: "09:00" })).toBe(
      "até a próxima segunda-feira, 09:00",
    );
    expect(fraseDaEsperaAteODia({ when: "next_weekday", weekday: 6, time: "09:00" })).toBe(
      "até o próximo sábado, 09:00",
    );
    expect(
      fraseDaEsperaAteAData(
        { field_key: "visita", offset_days: -2, time: "09:00" },
        "Data da visita",
      ),
    ).toBe("até 2 dias antes de “Data da visita”, 09:00");
    expect(fraseDaEsperaAteAData({ field_key: "visita", offset_days: 0, time: "09:00" })).toBe(
      "até a data de “visita”, 09:00",
    );
  });

  it("horaValida", () => {
    expect(horaValida("09:00")).toBe(true);
    expect(horaValida("23:59")).toBe(true);
    expect(horaValida("24:00")).toBe(false);
    expect(horaValida("9:00")).toBe(false);
    expect(horaValida("")).toBe(false);
  });
});
