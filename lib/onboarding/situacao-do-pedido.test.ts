import { describe, expect, it } from "vitest";

import { PEDIDO_PARADO_APOS_MS, podeEscolherOutraForma, situacaoDoPedido } from "./situacao-do-pedido";

describe("situacaoDoPedido: o que o passo 'Plano' faz com o status do pedido", () => {
  it("Pix gerado ou cartão no Asaas = aguardando (o wizard não avança)", () => {
    for (const s of ["criado", "processando", "aguardando_pagamento", "inconclusivo"]) {
      expect(situacaoDoPedido(s)).toBe("aguardando");
    }
  });

  it("pago = confirmado", () => {
    expect(situacaoDoPedido("pago")).toBe("confirmado");
  });

  it("vencido, cancelado, falhou, estornado, desconhecido ou ausente = encerrado (volta o formulário, nunca avança)", () => {
    for (const s of ["vencido", "cancelado", "falhou", "estornado", "qualquer-coisa", "", null, undefined]) {
      expect(situacaoDoPedido(s)).toBe("encerrado");
    }
  });
});

describe("podeEscolherOutraForma: a saída de quem ficou preso em 'aguardando'", () => {
  const AGORA = Date.parse("2026-10-15T12:00:00Z");
  const ha = (ms: number) => new Date(AGORA - ms).toISOString();
  const HORA = 60 * 60 * 1000;

  it("pedido recente com fatura (Pix/cartão a pagar): continua esperando, o formulário NÃO volta", () => {
    for (const status of ["criado", "processando", "aguardando_pagamento", "inconclusivo"]) {
      expect(podeEscolherOutraForma({ status, invoiceUrl: "https://asaas.test/i/1", criadoEm: ha(HORA) }, AGORA)).toBe(false);
    }
  });

  it("inconclusivo SEM fatura (o POST ao Asaas deu timeout): o formulário volta, mesmo recente", () => {
    expect(podeEscolherOutraForma({ status: "inconclusivo", invoiceUrl: null, criadoEm: ha(60_000) }, AGORA)).toBe(true);
  });

  it("outro estado aberto sem fatura (criado/processando) e recente NÃO libera: o POST pode estar em voo", () => {
    for (const status of ["criado", "processando"]) {
      expect(podeEscolherOutraForma({ status, invoiceUrl: null, criadoEm: ha(60_000) }, AGORA)).toBe(false);
    }
  });

  it("pedido aberto há mais de 24 h libera; até 24 h exatas, não", () => {
    const base = { status: "aguardando_pagamento", invoiceUrl: "https://asaas.test/i/1" };
    expect(podeEscolherOutraForma({ ...base, criadoEm: ha(PEDIDO_PARADO_APOS_MS + 1000) }, AGORA)).toBe(true);
    expect(podeEscolherOutraForma({ ...base, criadoEm: ha(PEDIDO_PARADO_APOS_MS) }, AGORA)).toBe(false);
  });

  it("data ausente ou ilegível nunca libera (não se adivinha idade)", () => {
    const base = { status: "aguardando_pagamento", invoiceUrl: "https://asaas.test/i/1" };
    expect(podeEscolherOutraForma({ ...base, criadoEm: null }, AGORA)).toBe(false);
    expect(podeEscolherOutraForma({ ...base, criadoEm: "ontem" }, AGORA)).toBe(false);
  });

  it("pedido PAGO nunca libera o formulário, por mais velho que seja (senão cobraria em dobro)", () => {
    expect(podeEscolherOutraForma({ status: "pago", invoiceUrl: null, criadoEm: ha(100 * 24 * HORA) }, AGORA)).toBe(false);
  });
});
