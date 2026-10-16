import { describe, expect, it } from "vitest";

import {
  avisoDevido,
  chaveDoAviso,
  dataBr,
  dataDaExclusao,
  diasRestantes,
  interpretarDiasDeGuarda,
} from "@/lib/retencao/exclusao-de-organizacao/datas";

/**
 * A conta de datas da exclusão dos dados (migration 0959): fim da assinatura + N dias, os marcos D-30 e D-7 por
 * dia civil de São Paulo, a chave de idempotência do aviso e a leitura segura da configuração de N.
 */
const D = (iso: string) => new Date(iso);

describe("data da exclusão", () => {
  it("é o fim da assinatura mais N dias (90 por padrão da promessa)", () => {
    expect(dataDaExclusao(D("2026-07-01T12:00:00Z"), 90).toISOString()).toBe("2026-09-29T12:00:00.000Z");
  });

  it("dataBr usa o dia de São Paulo, não o UTC", () => {
    // 01h UTC do dia 2 ainda é dia 1 em São Paulo (UTC-3)
    expect(dataBr(D("2026-11-02T01:00:00Z"))).toBe("01/11/2026");
    expect(dataBr(D("2026-11-02T04:00:00Z"))).toBe("02/11/2026");
  });
});

describe("dias restantes (dia civil)", () => {
  it("conta datas, não horas", () => {
    // 23h59 de São Paulo de um dia e 00h01 do seguinte: 1 dia, não 2 minutos
    expect(diasRestantes(D("2026-11-02T03:01:00Z"), D("2026-11-02T02:59:00Z"))).toBe(1);
    expect(diasRestantes(D("2026-11-10T12:00:00Z"), D("2026-11-10T20:00:00Z"))).toBe(0);
    expect(diasRestantes(D("2026-11-10T12:00:00Z"), D("2026-11-12T12:00:00Z"))).toBe(-2);
  });
});

describe("qual aviso está devido", () => {
  const excluir = D("2026-12-31T08:00:00Z");
  const nada = { d30: false, d7: false };

  it("nada antes de 30 dias nem no dia da exclusão ou depois", () => {
    expect(avisoDevido(excluir, D("2026-11-20T12:00:00Z"), nada)).toBeNull(); // 41 dias
    expect(avisoDevido(excluir, D("2026-12-31T12:00:00Z"), nada)).toBeNull(); // hoje
    expect(avisoDevido(excluir, D("2027-01-02T12:00:00Z"), nada)).toBeNull(); // passou
  });

  it("D-30 de 30 a 8 dias antes, D-7 de 7 a 1 dia antes", () => {
    expect(avisoDevido(excluir, D("2026-12-01T12:00:00Z"), nada)).toBe("d30"); // 30
    expect(avisoDevido(excluir, D("2026-12-23T12:00:00Z"), nada)).toBe("d30"); // 8
    expect(avisoDevido(excluir, D("2026-12-24T12:00:00Z"), nada)).toBe("d7"); // 7
    expect(avisoDevido(excluir, D("2026-12-30T12:00:00Z"), nada)).toBe("d7"); // 1
  });

  it("não repete o que já foi enviado (idempotência)", () => {
    expect(avisoDevido(excluir, D("2026-12-10T12:00:00Z"), { d30: true, d7: false })).toBeNull();
    expect(avisoDevido(excluir, D("2026-12-28T12:00:00Z"), { d30: true, d7: true })).toBeNull();
  });

  it("programação com menos de 30 dias não manda o D-30 atrasado: só o D-7 quando chegar", () => {
    const curto = D("2026-12-10T08:00:00Z");
    expect(avisoDevido(curto, D("2026-11-30T12:00:00Z"), nada)).toBe("d30"); // 10 dias: ainda cabe no D-30
    expect(avisoDevido(curto, D("2026-12-05T12:00:00Z"), { d30: false, d7: false })).toBe("d7"); // 5 dias: só o D-7
  });

  it("a chave é por data de exclusão e marco: mesma data repete a chave, outra data não", () => {
    expect(chaveDoAviso(excluir, "d30")).toBe("exclusao:2026-12-31:d30");
    expect(chaveDoAviso(excluir, "d30")).toBe(chaveDoAviso(D("2026-12-31T20:00:00Z"), "d30"));
    expect(chaveDoAviso(D("2027-01-05T08:00:00Z"), "d30")).not.toBe(chaveDoAviso(excluir, "d30"));
    expect(chaveDoAviso(excluir, "d7")).not.toBe(chaveDoAviso(excluir, "d30"));
  });
});

describe("a configuração dos dias de guarda", () => {
  it("vazio vale o padrão de 90 (a instalação nunca configurou)", () => {
    for (const bruto of [undefined, null, "", "   "]) {
      expect(interpretarDiasDeGuarda(bruto), String(bruto)).toEqual({ ok: true, dias: 90 });
    }
  });

  it("lixo ou fora de 90 a 365 é INVÁLIDO, nunca cai para 90 (encurtaria um prazo alongado)", () => {
    for (const bruto of ["noventa", "30", "89", "366", "-90", "90.5", "9e1", "0"]) {
      expect(interpretarDiasDeGuarda(bruto), String(bruto)).toEqual({ ok: false });
    }
  });

  it("aceita de 90 a 365", () => {
    expect(interpretarDiasDeGuarda("90")).toEqual({ ok: true, dias: 90 });
    expect(interpretarDiasDeGuarda(" 120 ")).toEqual({ ok: true, dias: 120 });
    expect(interpretarDiasDeGuarda("365")).toEqual({ ok: true, dias: 365 });
  });
});
