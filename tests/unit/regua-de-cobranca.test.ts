/**
 * A régua de cobrança do pedido de assinatura não pago (migration 1026): quem entra e em que marco é do banco
 * (provado em tests/invariants/regua-de-cobranca-do-pedido.test.ts); aqui se mede o que a rodada faz com cada
 * linha: o GET no Asaas antes de enfileirar, o link, a chave, o destino e o texto do e-mail de cada marco.
 */
import { describe, expect, it, vi } from "vitest";

import type { ClienteAsaasHttp } from "@/lib/billing/asaas/cliente";
import type { MarcaDeSaida } from "@/lib/branding/saida";
import type { CobrancaAsaas } from "@/lib/billing/asaas/contratos";
import type { EmailParaEnfileirar } from "@/lib/email/conta-e-cobranca/fila";
import { montarEmailDeConta, validarDados } from "@/lib/email/conta-e-cobranca/montar";
import { avisarFaturasEmAberto, type PedidoDaRegua } from "@/lib/email/conta-e-cobranca/regua-de-cobranca";

const ORG_A = "0a000000-0000-4000-8000-000000000001";
const ORG_B = "0b000000-0000-4000-8000-000000000002";
const AGORA = new Date("2026-11-13T11:10:00Z");

function linha(overrides: Partial<PedidoDaRegua> = {}): PedidoDaRegua {
  return {
    pedido_id: "11111111-0000-4000-8000-000000000001",
    organization_id: ORG_A,
    ambiente: "producao",
    status: "aguardando_pagamento",
    plan_id: "plano-pro",
    asaas_payment_id: "pay_1",
    asaas_subscription_id: "sub_1",
    asaas_installment_id: null,
    invoice_url: "https://www.asaas.com/i/guardada",
    vence_em: "2026-11-13",
    vence_em_gravado: true,
    limite: "suspensao",
    limite_em: "2026-11-20",
    marco: "no_dia",
    marco_em: "2026-11-13",
    ...overrides,
  };
}

function cobranca(overrides: Partial<CobrancaAsaas> = {}): CobrancaAsaas {
  return {
    id: "pay_1",
    customer: "cus_1",
    status: "PENDING",
    billingType: "CREDIT_CARD",
    value: 199,
    dueDate: "2026-11-13",
    externalReference: "HC:ord:x",
    invoiceUrl: "https://www.asaas.com/i/da-cobranca",
    valorConfirmado: 199,
    ...overrides,
  };
}

/** Admin falso: as RPCs da régua e as duas leituras (nome do plano, "já pagou"). */
function adminFalso(opts: {
  pendentes: PedidoDaRegua[];
  relido?: PedidoDaRegua[];
  pagos?: Record<string, boolean>;
  paradas?: string[];
}) {
  const rpcs: Array<[string, Record<string, unknown>]> = [];
  const admin = {
    rpc: vi.fn(async (nome: string, args: Record<string, unknown>) => {
      rpcs.push([nome, args]);
      if (nome === "fn_billing_regua_de_cobranca_pendentes") return { data: opts.pendentes, error: null };
      if (nome === "fn_billing_pedido_gravar_vencimento") return { data: true, error: null };
      if (nome === "fn_billing_pedidos_de_assinatura_em_aberto") return { data: opts.relido ?? [], error: null };
      if (nome === "fn_billing_asaas_registrar_evento") return { data: { novo: true }, error: null };
      return { data: null, error: { message: `rpc inesperada ${nome}` } };
    }),
    from: (tabela: string) => {
      const filtros: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      for (const m of ["select", "in", "limit"]) b[m] = () => b;
      b.eq = (col: string, v: unknown) => {
        filtros[col] = v;
        return b;
      };
      b.maybeSingle = async () => ({
        data:
          tabela === "billing_plans"
            ? { name: "Pro" }
            : tabela === "organizations"
              ? { status: opts.paradas?.includes(filtros.id as string) ? "suspended" : "active" }
              : null,
        error: null,
      });
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({
          data: opts.pagos?.[filtros.organization_id as string] ? [{ id: "pago" }] : [],
          error: null,
        }).then(res);
      return b;
    },
  };
  return { admin: admin as never, rpcs };
}

function asaasFalso(c: CobrancaAsaas | { removido: true }): ClienteAsaasHttp {
  return {
    buscarCobranca: vi.fn(async () => c),
    listarCobrancasDaAssinatura: vi.fn(async () => ("removido" in c ? [] : [c])),
    listarCobrancasDoParcelamento: vi.fn(async () => ("removido" in c ? [] : [c])),
  } as unknown as ClienteAsaasHttp;
}

async function rodar(admin: never, asaas: ClienteAsaasHttp) {
  const enviadas: EmailParaEnfileirar[] = [];
  const resumo = await avisarFaturasEmAberto(admin, {
    asaas,
    ambiente: "producao",
    agora: () => AGORA,
    enfileirar: async (e) => {
      enviadas.push(e);
      return "enfileirado";
    },
  });
  return { resumo, enviadas };
}

const MARCA: MarcaDeSaida = {
  nome: "CRM",
  logoUrl: null,
  accent: "#0139B0",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};

function renderizar(e: EmailParaEnfileirar, idioma: "pt-BR" | "es" = "pt-BR") {
  return montarEmailDeConta(e.emailId, e.dados, {
    organizationId: e.organizationId,
    empresa: "Empresa",
    idioma,
    marca: MARCA,
    appUrl: "https://crm.exemplo.com.br",
    nome: null,
    base: (url: string) => ({ idioma, marca: MARCA, empresa: "Empresa", url }),
  });
}

describe("régua de cobrança: o marco vigente vira COB-05 com o link da fatura", () => {
  it("enfileira COB-05 aos admins com cópia ao operador, chave pedido:<id>:<marco>, link atual do Asaas", async () => {
    const { admin } = adminFalso({ pendentes: [linha()] });
    const { resumo, enviadas } = await rodar(admin, asaasFalso(cobranca()));

    expect(resumo.enfileirados).toBe(1);
    expect(enviadas).toHaveLength(1);
    const e = enviadas[0]!;
    expect(e).toMatchObject({
      organizationId: ORG_A,
      emailId: "COB-05",
      chave: "pedido:11111111-0000-4000-8000-000000000001:no_dia",
      destino: "admins",
      copiaParaOperador: true,
    });
    expect(e.dados).toMatchObject({
      plano: "Pro",
      valor: 19900,
      faturaUrl: "https://www.asaas.com/i/da-cobranca",
      nuncaPagou: true,
      marco: "no_dia",
      venceEm: "2026-11-13",
      limite: "suspensao",
      limiteEm: "2026-11-20",
    });
    // O formato passa pelo schema da fila.
    expect(() => validarDados("COB-05", e.dados)).not.toThrow();
    const m = renderizar(e);
    expect(m.subject).toBe("Sua fatura vence em 13/11/2026");
    expect(m.text).toContain("Pagar agora: https://www.asaas.com/i/da-cobranca");
    expect(m.text).toContain("concluir sua assinatura");
    expect(m.text).toContain("suspensa em 20/11/2026");
    expect(m.text).not.toContain("Assinar de novo");
  });

  it("cada marco tem o seu título; remoção diz até quando a fatura fica disponível", async () => {
    const casos: Array<[Partial<PedidoDaRegua>, string, string]> = [
      [{ marco: "antes" }, "Sua fatura vence em 13/11/2026", "suspensa em 20/11/2026"],
      [{ marco: "depois" }, "Sua fatura venceu em 13/11/2026", "suspensa em 20/11/2026"],
      [{ marco: "ultimo_dia" }, "Sua assinatura será suspensa em 20/11/2026", "suspensa em 20/11/2026"],
      [{ marco: "ultimo_dia", limite: "remocao", limite_em: "2026-11-21" }, "Último dia para pagar sua fatura", "disponível até 20/11/2026"],
    ];
    for (const [over, titulo, prazo] of casos) {
      const { admin } = adminFalso({ pendentes: [linha(over)], pagos: { [ORG_A]: true } });
      const { enviadas } = await rodar(admin, asaasFalso(cobranca()));
      const m = renderizar(enviadas[0]!);
      expect(m.subject).toBe(titulo);
      expect(m.text).toContain(prazo);
      expect(m.text).toContain("manter seu plano");
      expect(enviadas[0]!.chave).toBe(`pedido:11111111-0000-4000-8000-000000000001:${over.marco}`);
    }
    const { admin } = adminFalso({ pendentes: [linha({ marco: "depois" })] });
    const { enviadas } = await rodar(admin, asaasFalso(cobranca()));
    expect(renderizar(enviadas[0]!, "es").subject).toBe("Tu factura venció el 13/11/2026");
  });

  it("cobrança já paga no Asaas (o aviso se perdeu): não enfileira e registra o evento sintético de pago", async () => {
    const eventos: Record<string, string> = {
      RECEIVED: "PAYMENT_RECEIVED",
      CONFIRMED: "PAYMENT_CONFIRMED",
      RECEIVED_IN_CASH: "PAYMENT_RECEIVED_IN_CASH",
    };
    for (const [status, evento] of Object.entries(eventos)) {
      const { admin, rpcs } = adminFalso({ pendentes: [linha()] });
      const c = cobranca({ status });
      const { resumo, enviadas } = await rodar(admin, asaasFalso(c));
      expect(enviadas).toEqual([]);
      expect(resumo.pagos).toBe(1);
      expect(resumo.pagamentosRegistrados).toBe(1);
      expect(rpcs.find(([n]) => n === "fn_billing_asaas_registrar_evento")?.[1]).toEqual({
        p_event_id: `conc:${c.id}:${status}`,
        p_event_type: evento,
        p_resource_id: c.id,
        p_ambiente: "producao",
        p_origem: "conciliacao",
        p_payload: { id: `conc:${c.id}:${status}`, event: evento, payment: c },
      });
    }
  });

  it("cartão em análise antifraude: não enfileira e não inventa evento", async () => {
    const { admin, rpcs } = adminFalso({ pendentes: [linha()] });
    const { resumo, enviadas } = await rodar(admin, asaasFalso(cobranca({ status: "AWAITING_RISK_ANALYSIS" })));
    expect(enviadas).toEqual([]);
    expect(resumo.pagos).toBe(1);
    expect(rpcs.some(([n]) => n === "fn_billing_asaas_registrar_evento")).toBe(false);
  });

  it("cobrança removida, fora de aberto ou sem link válido: não manda link morto", async () => {
    const casos: Array<CobrancaAsaas | { removido: true }> = [
      { removido: true },
      cobranca({ status: "REFUNDED" }),
      cobranca({ invoiceUrl: "https://phishing.example.com/i/1" }),
    ];
    for (const c of casos) {
      const { admin } = adminFalso({ pendentes: [linha({ invoice_url: null })] });
      const { resumo, enviadas } = await rodar(admin, asaasFalso(c));
      expect(enviadas).toEqual([]);
      expect(resumo.semFatura).toBe(1);
    }
  });

  it("o vencimento do Asaas difere do gravado: grava, relê o marco do banco e usa o novo", async () => {
    const relido = linha({ vence_em: "2026-11-11", marco: "depois", marco_em: "2026-11-13" });
    const { admin, rpcs } = adminFalso({ pendentes: [linha({ vence_em_gravado: false })], relido: [relido] });
    const { resumo, enviadas } = await rodar(admin, asaasFalso(cobranca({ dueDate: "2026-11-11" })));

    expect(rpcs.find(([n]) => n === "fn_billing_pedido_gravar_vencimento")?.[1]).toEqual({
      p_org: ORG_A,
      p_pedido: "11111111-0000-4000-8000-000000000001",
      p_vence_em: "2026-11-11",
    });
    expect(rpcs.find(([n]) => n === "fn_billing_pedidos_de_assinatura_em_aberto")?.[1]).toMatchObject({
      p_org: ORG_A,
      p_pedido: "11111111-0000-4000-8000-000000000001",
    });
    expect(resumo.vencimentosGravados).toBe(1);
    expect(enviadas[0]!.chave).toBe("pedido:11111111-0000-4000-8000-000000000001:depois");
    expect(enviadas[0]!.dados).toMatchObject({ venceEm: "2026-11-11", marco: "depois" });
  });

  it("vencimento gravado agora, mas nenhum marco vale hoje: não enfileira", async () => {
    const { admin } = adminFalso({ pendentes: [linha({ vence_em_gravado: false, marco: null })], relido: [linha({ marco: null })] });
    const { resumo, enviadas } = await rodar(admin, asaasFalso(cobranca()));
    expect(enviadas).toEqual([]);
    expect(resumo.foraDoMarco).toBe(1);
  });

  it("pedido de outro ambiente do Asaas: nem GET nem aviso", async () => {
    const { admin } = adminFalso({ pendentes: [linha({ ambiente: "sandbox" })] });
    const asaas = asaasFalso(cobranca());
    const { resumo, enviadas } = await rodar(admin, asaas);
    expect(enviadas).toEqual([]);
    expect(asaas.buscarCobranca).not.toHaveBeenCalled();
    expect(resumo.outroAmbiente).toBe(1);
  });

  it("cada organização recebe só o aviso do próprio pedido", async () => {
    const pedidoB = linha({ pedido_id: "22222222-0000-4000-8000-000000000002", organization_id: ORG_B, marco: "antes" });
    const { admin } = adminFalso({ pendentes: [linha(), pedidoB], pagos: { [ORG_B]: true } });
    const { enviadas } = await rodar(admin, asaasFalso(cobranca()));

    expect(enviadas.map((e) => [e.organizationId, e.chave])).toEqual([
      [ORG_A, "pedido:11111111-0000-4000-8000-000000000001:no_dia"],
      [ORG_B, "pedido:22222222-0000-4000-8000-000000000002:antes"],
    ]);
    // "Já pagou" é por organização: A nunca pagou, B já.
    expect((enviadas[0]!.dados as { nuncaPagou: boolean }).nuncaPagou).toBe(true);
    expect((enviadas[1]!.dados as { nuncaPagou: boolean }).nuncaPagou).toBe(false);
  });

  it("organização parada (status fora de active): nem GET nem aviso", async () => {
    const { admin } = adminFalso({ pendentes: [linha()], paradas: [ORG_A] });
    const asaas = asaasFalso(cobranca());
    const { resumo, enviadas } = await rodar(admin, asaas);
    expect(enviadas).toEqual([]);
    expect(asaas.buscarCobranca).not.toHaveBeenCalled();
    expect(resumo.orgParada).toBe(1);
  });

  it("pedido de assinatura sem id de cobrança (primeira ainda não gerada): lê pela assinatura", async () => {
    const { admin } = adminFalso({ pendentes: [linha({ asaas_payment_id: null })] });
    const asaas = asaasFalso(cobranca());
    const { enviadas } = await rodar(admin, asaas);
    expect(asaas.listarCobrancasDaAssinatura).toHaveBeenCalledWith("sub_1");
    expect(enviadas).toHaveLength(1);
  });
});
