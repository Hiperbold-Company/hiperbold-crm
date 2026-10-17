/**
 * A data do QR do Pix vem do Asaas como "AAAA-MM-DD HH:mm:ss" SEM fuso. Lida com `new Date(texto)` ela muda com o
 * fuso de quem olha; aqui é lida à mão como horário de São Paulo, em qualquer fuso da máquina.
 */
import { describe, expect, it } from "vitest";

import { formatarDataDoAsaas, instanteDaDataDoAsaas } from "@/lib/billing/asaas/data-do-asaas";

describe("instanteDaDataDoAsaas", () => {
  it("23:59:59 de São Paulo é 02:59:59Z do dia seguinte, não importa o fuso da máquina", () => {
    expect(instanteDaDataDoAsaas("2026-10-17 23:59:59")?.toISOString()).toBe("2026-10-18T02:59:59.000Z");
    expect(instanteDaDataDoAsaas("2026-10-17T08:00:00")?.toISOString()).toBe("2026-10-17T11:00:00.000Z");
  });

  it("só a data vale meia-noite de São Paulo", () => {
    expect(instanteDaDataDoAsaas("2026-10-17")?.toISOString()).toBe("2026-10-17T03:00:00.000Z");
  });

  it("texto que já carrega fuso respeita o fuso dele", () => {
    expect(instanteDaDataDoAsaas("2026-10-17T10:00:00Z")?.toISOString()).toBe("2026-10-17T10:00:00.000Z");
    expect(instanteDaDataDoAsaas("2026-10-17T10:00:00-03:00")?.toISOString()).toBe("2026-10-17T13:00:00.000Z");
  });

  it("lixo, vazio e data impossível viram null (a tela some com a linha em vez de mostrar 'Invalid Date')", () => {
    for (const x of ["", null, undefined, "amanhã", "2026-13-40 99:99:99", "17/10/2026 10:00"]) {
      expect(instanteDaDataDoAsaas(x as never)).toBeNull();
    }
  });
});

describe("formatarDataDoAsaas", () => {
  it("escreve sempre o horário de São Paulo", () => {
    expect(formatarDataDoAsaas("2026-10-17 23:59:59", "pt-BR")).toBe("17/10/2026, 23:59:59");
    expect(formatarDataDoAsaas("lixo", "pt-BR")).toBeNull();
  });
});
