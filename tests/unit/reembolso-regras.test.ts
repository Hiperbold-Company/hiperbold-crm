/**
 * As regras do pedido de reembolso do cliente (migration 0957), na forma que a tela as usa: quando existe o botão
 * "Solicitar reembolso", quando aparece o aviso de prazo vencido, o pedido em análise, a garantia de 7 dias e o
 * link da cobrança no Asaas. O banco repete a mesma regra (provada em `tests/invariants/reembolso-do-cliente-banco.test.ts`).
 */
import { describe, expect, it } from "vitest";

import { linkDaCobrancaNoAsaas } from "@/lib/billing/reembolso/link-asaas";
import { MOTIVOS_DE_CANCELAMENTO, motivoValido, rotuloDoMotivo } from "@/lib/billing/reembolso/motivos";
import {
  assinaturaCancelada,
  dentroDaGarantia,
  estadoDoReembolso,
  type PagamentoReembolsavel,
} from "@/lib/billing/reembolso/regras";

const AGORA = new Date("2026-10-15T12:00:00Z");
const DIA = 24 * 60 * 60 * 1000;
const diasAtras = (d: number) => new Date(AGORA.getTime() - d * DIA).toISOString();

function pagamento(extra: Partial<PagamentoReembolsavel> = {}): PagamentoReembolsavel {
  return {
    paymentId: "11111111-1111-4111-8111-111111111111",
    asaasPaymentId: "pay_abc123",
    amountCents: 34900,
    paidAt: diasAtras(2),
    plano: "Pro",
    pacote: false,
    pendente: false,
    invoiceUrl: null,
    ambiente: "producao",
    ...extra,
  };
}

const CANCELADO = { cancelAtPeriodEnd: true, status: "ativa" };

describe("a garantia de 7 dias", () => {
  it("vale até 7 dias exatos e não passa disso", () => {
    expect(dentroDaGarantia(diasAtras(0), AGORA)).toBe(true);
    expect(dentroDaGarantia(diasAtras(6.9), AGORA)).toBe(true);
    expect(dentroDaGarantia(diasAtras(7), AGORA)).toBe(true);
    expect(dentroDaGarantia(new Date(AGORA.getTime() - 7 * DIA - 1000).toISOString(), AGORA)).toBe(false);
    expect(dentroDaGarantia(diasAtras(8), AGORA)).toBe(false);
  });

  it("data ilegível nunca dá garantia", () => {
    expect(dentroDaGarantia("não é data", AGORA)).toBe(false);
  });
});

describe("assinatura cancelada", () => {
  it("é cancel_at_period_end ligado ou contrato cancelado", () => {
    expect(assinaturaCancelada({ cancelAtPeriodEnd: true, status: "ativa" })).toBe(true);
    expect(assinaturaCancelada({ cancelAtPeriodEnd: false, status: "cancelada" })).toBe(true);
    expect(assinaturaCancelada({ cancelAtPeriodEnd: false, status: "ativa" })).toBe(false);
    expect(assinaturaCancelada(null)).toBe(false);
  });
});

describe("o que a tela mostra sobre reembolso", () => {
  it("assinatura ativa (não cancelada): nada, mesmo com pagamento recente", () => {
    const e = estadoDoReembolso({ contrato: { cancelAtPeriodEnd: false, status: "ativa" }, elegiveis: [pagamento()], agora: AGORA });
    expect(e).toEqual({ tipo: "oculto" });
  });

  it("cancelada e sem pagamento elegível: nada", () => {
    expect(estadoDoReembolso({ contrato: CANCELADO, elegiveis: [], agora: AGORA })).toEqual({ tipo: "oculto" });
  });

  it("cancelada e pagamento mais recente dentro dos 7 dias: o botão", () => {
    const p = pagamento();
    expect(estadoDoReembolso({ contrato: CANCELADO, elegiveis: [p], agora: AGORA })).toEqual({ tipo: "pode_pedir", pagamento: p });
  });

  it("cancelada e pagamento mais recente com mais de 7 dias: sem botão, só o aviso de prazo", () => {
    const p = pagamento({ paidAt: diasAtras(9) });
    expect(estadoDoReembolso({ contrato: CANCELADO, elegiveis: [p], agora: AGORA })).toEqual({ tipo: "fora_do_prazo", pagamento: p });
  });

  it("só o pagamento mais recente conta: um mais antigo dentro do prazo não reabre o botão", () => {
    const recente = pagamento({ paidAt: diasAtras(9) });
    const antigoMasNaoVale = pagamento({ paymentId: "22222222-2222-4222-8222-222222222222", paidAt: diasAtras(3) });
    // a lista vem do mais novo ao mais antigo: o primeiro manda
    const e = estadoDoReembolso({ contrato: CANCELADO, elegiveis: [recente, antigoMasNaoVale], agora: AGORA });
    expect(e.tipo).toBe("fora_do_prazo");
  });

  it("pedido já aberto: em análise, sem segundo botão", () => {
    const p = pagamento({ pendente: true });
    expect(estadoDoReembolso({ contrato: CANCELADO, elegiveis: [p], agora: AGORA })).toEqual({ tipo: "em_analise", pagamento: p });
  });

  it("contrato cancelado (status) também vale", () => {
    const e = estadoDoReembolso({ contrato: { cancelAtPeriodEnd: false, status: "cancelada" }, elegiveis: [pagamento()], agora: AGORA });
    expect(e.tipo).toBe("pode_pedir");
  });
});

describe("o link da cobrança no Asaas", () => {
  it("usa o invoice_url do pedido quando é do Asaas", () => {
    expect(linkDaCobrancaNoAsaas({ asaasPaymentId: "pay_abc123", invoiceUrl: "https://www.asaas.com/i/zzz999" })).toBe(
      "https://www.asaas.com/i/zzz999",
    );
  });

  it("sem invoice_url (ou com um que não é do Asaas), monta pelo id sem o pay_", () => {
    expect(linkDaCobrancaNoAsaas({ asaasPaymentId: "pay_abc123" })).toBe("https://www.asaas.com/i/abc123");
    expect(linkDaCobrancaNoAsaas({ asaasPaymentId: "pay_abc123", invoiceUrl: "https://evil.com/i/x" })).toBe(
      "https://www.asaas.com/i/abc123",
    );
    expect(linkDaCobrancaNoAsaas({ asaasPaymentId: "pay_abc123", ambiente: "sandbox" })).toBe("https://sandbox.asaas.com/i/abc123");
  });

  it("id fora do formato não vira link", () => {
    expect(linkDaCobrancaNoAsaas({ asaasPaymentId: "pay_../../x" })).toBeNull();
  });
});

describe("o vocabulário de motivos", () => {
  it("são cinco, com rótulo em português", () => {
    expect(MOTIVOS_DE_CANCELAMENTO).toHaveLength(5);
    expect(MOTIVOS_DE_CANCELAMENTO.map(rotuloDoMotivo)).toEqual([
      "Não usei como esperava",
      "Preço",
      "Faltou um recurso",
      "Contratei por engano",
      "Outro",
    ]);
    expect(motivoValido("preco")).toBe(true);
    expect(motivoValido("porque_sim")).toBe(false);
    expect(rotuloDoMotivo("desconhecido")).toBe("desconhecido");
  });
});
