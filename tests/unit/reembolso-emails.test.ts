/**
 * Os e-mails do pedido de reembolso (migration 0957): COB-10 ao cliente e COB-11 ao financeiro da instalação.
 * Prova o que a pessoa lê, para quem cada um vai (o financeiro NUNCA vai aos admins da organização e o cliente
 * nunca recebe o do financeiro), a configuração `EMAIL_DO_FINANCEIRO` com a queda para a cópia dos avisos, e o
 * webhook de estorno fechando o pedido aberto como concluído. Doubles só nas bordas (roteador, banco em memória).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";
import {
  destinatariosDoFinanceiro,
  enviarFilaDeEmails,
  type DepsDoEnvio,
} from "@/lib/email/conta-e-cobranca/enviar";
import { enfileirarEmailDeConta } from "@/lib/email/conta-e-cobranca/fila";
import {
  concluirPedidoDeReembolsoDoPagamento,
  criarAvisoDePedidoDeReembolsoSobre,
} from "@/lib/email/conta-e-cobranca/gatilhos-de-reembolso";
import { criarAvisosDeCobrancaSobre } from "@/lib/email/conta-e-cobranca/gatilhos-de-cobranca";
import { montarEmailDeConta, type ContextoDoEmail } from "@/lib/email/conta-e-cobranca/montar";
import { CATALOGO_DA_INSTALACAO } from "@/lib/instalacao/catalogo";

import { clienteFalso, criarBancoFalso, type BancoFalso } from "./helpers/banco-de-emails-falso";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const ORG = "0957b000-0000-4000-8000-00000000000a";
const MARCA: MarcaDeSaida = {
  nome: "HiperCRM",
  logoUrl: null,
  accent: "#0139B0",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};

function ctx(idioma: "pt-BR" | "es" = "pt-BR", faixa?: string): ContextoDoEmail {
  return {
    organizationId: ORG,
    empresa: "Empresa A",
    idioma,
    marca: MARCA,
    appUrl: "https://crm.exemplo.com.br",
    nome: "Diego",
    ...(faixa ? { faixaDoOperador: faixa } : {}),
    base: (url) => ({ marca: MARCA, idioma, empresa: "Empresa A", url }),
  };
}

const PEDIDO = {
  organizationId: ORG,
  id: "55555555-5555-4555-8555-555555555555",
  asaasPaymentId: "pay_abc123",
  amountCents: 34900,
  paidAt: "2026-10-13T12:00:00+00:00",
  dentro7Dias: true,
  motivo: "preco" as const,
  motivoDetalhe: "caro demais",
  observacao: null,
  plano: "Pro",
  invoiceUrl: null,
  ambiente: "producao" as const,
};

describe("COB-10: o que o cliente lê", () => {
  const dados = { valor: 34900, plano: "Pro", pagoEm: "2026-10-13T12:00:00+00:00" };

  it("diz que recebeu, o valor, que responde em até 3 dias úteis e que avisa quando o estorno for concluído", () => {
    const m = montarEmailDeConta("COB-10", dados, ctx());
    expect(m.subject).toBe("Recebemos sua solicitação de reembolso");
    expect(m.text).toContain("R$ 349,00");
    expect(m.text).toContain("Nossa equipe responde em até 3 dias úteis.");
    expect(m.text).toContain("Assim que o estorno for concluído, avisamos por e-mail.");
    expect(m.text).not.toContain("2 dias");
    expect(m.html).toContain("13/10/2026");
  });

  it("em espanhol", () => {
    const m = montarEmailDeConta("COB-10", dados, ctx("es"));
    expect(m.subject).toBe("Recibimos tu solicitud de reembolso");
    expect(m.text).toContain("3 días hábiles");
  });

  it("pacote de tokens (plano nulo) não quebra", () => {
    const m = montarEmailDeConta("COB-10", { ...dados, plano: null }, ctx());
    expect(m.text).toContain("Pacote de tokens");
  });
});

describe("COB-11: o que o financeiro lê", () => {
  const dados = {
    valor: 34900,
    plano: "Pro",
    pagoEm: "2026-10-13T12:00:00+00:00",
    dentro7Dias: true,
    motivo: "preco" as const,
    detalhe: "No cancelamento: caro demais",
    faturaUrl: "https://www.asaas.com/i/abc123",
  };

  it("traz empresa, plano, valor, data, dentro dos 7 dias, motivo, detalhe, o link do Asaas e o da lista", () => {
    const m = montarEmailDeConta("COB-11", dados, ctx("pt-BR"));
    expect(m.subject).toBe("Pedido de reembolso: Empresa A");
    for (const trecho of [
      "Empresa A",
      "Pro",
      "R$ 349,00",
      "13/10/2026",
      "Dentro dos 7 dias",
      "Sim",
      "Preço",
      "caro demais",
      "https://www.asaas.com/i/abc123",
      "https://crm.exemplo.com.br/admin/sistema/reembolsos",
    ]) {
      expect(m.text).toContain(trecho);
    }
  });

  it("link que não é do Asaas não vira botão: cai na lista do admin", () => {
    const m = montarEmailDeConta("COB-11", { ...dados, faturaUrl: "https://evil.com/x" }, ctx());
    expect(m.text).not.toContain("evil.com");
    expect(m.text).toContain("https://crm.exemplo.com.br/admin/sistema/reembolsos");
  });

  it("fora dos 7 dias aparece como Não; texto do cliente é escapado no HTML", () => {
    const m = montarEmailDeConta("COB-11", { ...dados, dentro7Dias: false, detalhe: "<script>x</script>" }, ctx());
    expect(m.text).toContain("Não");
    expect(m.html).not.toContain("<script>x</script>");
  });

  it("recusa dados fora do formato (motivo desconhecido)", () => {
    expect(() => montarEmailDeConta("COB-11", { ...dados, motivo: "porque_sim" }, ctx())).toThrow();
  });
});

describe("os gatilhos do pedido", () => {
  it("enfileira os dois, com a mesma chave do pedido, e junta o texto do cancelamento com a observação", async () => {
    const enviadas: Array<Record<string, unknown>> = [];
    const aviso = criarAvisoDePedidoDeReembolsoSobre({} as never, {
      enfileirar: async (e) => {
        enviadas.push(e as never);
        return "enfileirado";
      },
    });
    await aviso({ ...PEDIDO, observacao: "obrigado" });
    expect(enviadas.map((e) => [e.emailId, e.destino, e.chave])).toEqual([
      ["COB-10", "admins", `reembolso:${PEDIDO.id}`],
      ["COB-11", "financeiro", `reembolso:${PEDIDO.id}`],
    ]);
    expect((enviadas[1]!.dados as { detalhe: string }).detalhe).toBe("No cancelamento: caro demais | No pedido: obrigado");
  });

  it("falha ao enfileirar um não impede o outro nem lança", async () => {
    const enviadas: string[] = [];
    const aviso = criarAvisoDePedidoDeReembolsoSobre({} as never, {
      enfileirar: async (e) => {
        if (e.emailId === "COB-10") throw new Error("banco fora");
        enviadas.push(e.emailId);
        return "enfileirado";
      },
    });
    await expect(aviso(PEDIDO)).resolves.toBeUndefined();
    expect(enviadas).toEqual(["COB-11"]);
  });
});

// ─── Envio: quem recebe cada um ─────────────────────────────────────────────

function mundo(): BancoFalso {
  return criarBancoFalso({
    tabelas: {
      organizations: [{ id: ORG, display_name: "Empresa A", locale: "pt-BR" }],
      user_organizations: [{ user_id: "a1", organization_id: ORG, role: "admin", revoked_at: null, created_at: "1" }],
      platform_admins: [{ user_id: "p1", scope: "full", revoked_at: null }],
    },
    usuarios: {
      a1: { id: "a1", email: "dono@empresa-a.com.br" },
      p1: { id: "p1", email: "operador@instalacao.test" },
    },
  });
}

function cenario() {
  const banco = mundo();
  const relogio = { agora: new Date("2026-10-15T12:00:00Z") };
  banco.agora = () => relogio.agora;
  const enviado = vi.fn(async (_a: { to: string; subject: string }) => ({ ok: true, id: "m", via: "smtp" as const }));
  const config = { copia: null as string | null, financeiro: null as string | null };
  const marcas: Array<string | null> = [];
  const deps: DepsDoEnvio = {
    admin: clienteFalso(banco),
    sendEmail: enviado as never,
    emailConfigurado: async () => true,
    marcaDaSaida: async (org) => {
      marcas.push(org);
      return MARCA;
    },
    appUrl: "https://crm.exemplo.com.br",
    configuracaoDaCopia: async () => config.copia,
    configuracaoDoFinanceiro: async () => config.financeiro,
    agora: () => relogio.agora,
  };
  return { banco, enviado, config, deps, marcas };
}

const DADOS_COB10 = { valor: 34900, plano: "Pro", pagoEm: "2026-10-13T12:00:00+00:00" };
const DADOS_COB11 = {
  valor: 34900,
  plano: "Pro",
  pagoEm: "2026-10-13T12:00:00+00:00",
  dentro7Dias: true,
  motivo: "preco",
  detalhe: null,
  faturaUrl: null,
};

async function enfileirarOsDois(c: ReturnType<typeof cenario>) {
  const base = { organizationId: ORG, chave: `reembolso:${PEDIDO.id}`, copiaParaOperador: false };
  await enfileirarEmailDeConta({ ...base, emailId: "COB-10", destino: "admins", dados: DADOS_COB10 }, c.deps.admin);
  await enfileirarEmailDeConta(
    { ...base, emailId: "COB-11", destino: "financeiro", dados: DADOS_COB11 } as never,
    c.deps.admin,
  );
}

const para = (c: ReturnType<typeof cenario>) => c.enviado.mock.calls.map((x) => `${x[0].to} | ${x[0].subject}`);

describe("para quem cada e-mail vai", () => {
  let c: ReturnType<typeof cenario>;
  beforeEach(() => {
    c = cenario();
  });

  it("COB-10 só aos admins da organização; COB-11 só ao financeiro configurado", async () => {
    c.config.financeiro = "financeiro@hiperbold.test, contas@hiperbold.test";
    c.config.copia = "copia@hiperbold.test";
    await enfileirarOsDois(c);
    const r = await enviarFilaDeEmails(c.deps);
    expect(r).toMatchObject({ reservados: 2, enviados: 2 });

    const enviados = para(c);
    expect(enviados).toContain("dono@empresa-a.com.br | Recebemos sua solicitação de reembolso");
    expect(enviados).toContain("financeiro@hiperbold.test | Pedido de reembolso: Empresa A");
    expect(enviados).toContain("contas@hiperbold.test | Pedido de reembolso: Empresa A");
    // o financeiro não vai ao admin da organização, e o cliente não recebe o do financeiro
    expect(enviados.filter((e) => e.startsWith("dono@"))).toHaveLength(1);
    expect(enviados.join("\n")).not.toContain("copia@hiperbold.test");
    expect(enviados.join("\n")).not.toContain("operador@instalacao.test");
  });

  it("sem EMAIL_DO_FINANCEIRO, cai na cópia dos avisos; sem as duas, nos administradores da plataforma", async () => {
    c.config.copia = "copia@hiperbold.test";
    await enfileirarOsDois(c);
    await enviarFilaDeEmails(c.deps);
    expect(para(c)).toContain("copia@hiperbold.test | Pedido de reembolso: Empresa A");

    const d = cenario();
    await enfileirarOsDois(d);
    await enviarFilaDeEmails(d.deps);
    expect(para(d)).toContain("operador@instalacao.test | Pedido de reembolso: Empresa A");
  });

  it("o financeiro vem com a marca da INSTALAÇÃO e o do cliente com a da organização", async () => {
    await enfileirarOsDois(c);
    await enviarFilaDeEmails(c.deps);
    expect(c.marcas).toContain(null);
    expect(c.marcas).toContain(ORG);
  });

  it("endereço inválido na configuração é ignorado; sem dep de financeiro, usa a cópia", async () => {
    c.config.financeiro = "isso-nao-e-email";
    c.config.copia = "copia@hiperbold.test";
    expect(await destinatariosDoFinanceiro(c.deps)).toEqual(["copia@hiperbold.test"]);
    const { configuracaoDoFinanceiro: _fora, ...semDep } = c.deps;
    expect(await destinatariosDoFinanceiro(semDep as DepsDoEnvio)).toEqual(["copia@hiperbold.test"]);
  });

  it("nenhum endereço fixo no código: sem configuração e sem admin da plataforma, ninguém recebe", async () => {
    c.banco.tabelas.platform_admins = [];
    expect(await destinatariosDoFinanceiro(c.deps)).toEqual([]);
  });
});

describe("a configuração EMAIL_DO_FINANCEIRO", () => {
  it("existe no catálogo da instalação, editável, no grupo de e-mail", () => {
    const item = CATALOGO_DA_INSTALACAO.find((i) => i.chave === "EMAIL_DO_FINANCEIRO");
    expect(item).toMatchObject({
      rotulo: "E-mail do financeiro (pedidos de reembolso)",
      grupo: "email",
      natureza: "texto",
      controle: "edita",
    });
  });
});

// ─── O webhook de estorno fecha o pedido ────────────────────────────────────

describe("webhook PAYMENT_REFUNDED fecha o pedido aberto como concluído", () => {
  function adminComRpc(retorno: { data?: unknown; error?: unknown }) {
    const chamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];
    const admin = {
      rpc: async (nome: string, args: Record<string, unknown>) => {
        chamadas.push({ nome, args });
        return { data: retorno.data ?? 1, error: retorno.error ?? null };
      },
    };
    return { admin: admin as never, chamadas };
  }

  it("concluirPedidoDeReembolsoDoPagamento chama a função do banco com organização e id do Asaas", async () => {
    const { admin, chamadas } = adminComRpc({ data: 1 });
    expect(await concluirPedidoDeReembolsoDoPagamento(admin, ORG, "pay_abc123")).toBe(1);
    expect(chamadas).toEqual([
      { nome: "fn_billing_reembolso_concluir_por_pagamento", args: { p_org: ORG, p_asaas_payment_id: "pay_abc123" } },
    ]);
  });

  it("erro do banco devolve 0 e não lança", async () => {
    const { admin } = adminComRpc({ error: { message: "boom" } });
    expect(await concluirPedidoDeReembolsoDoPagamento(admin, ORG, "pay_abc123")).toBe(0);
  });

  function avisosComRpc() {
    const banco = criarBancoFalso({
      tabelas: {
        billing_plans: [{ id: "plano-pro", code: "pro", name: "Pro", grace_days: 7 }],
        billing_contracts: [
          { organization_id: ORG, plan_id: "plano-pro", status: "ativa", cycle: "monthly", current_period_end: "2026-11-01T03:00:00+00:00" },
        ],
        billing_orders: [],
        billing_payments: [
          { id: "bp-1", organization_id: ORG, order_id: null, contract_id: "c-1", asaas_payment_id: "pay_abc123", gross_cents: 34900, status: "CONFIRMED", paid_at: "2026-10-13T12:00:00+00:00", billing_period_start: null, billing_period_end: null, estorna_pagamento_id: null },
          { id: "bp-est", organization_id: ORG, order_id: null, contract_id: "c-1", asaas_payment_id: null, gross_cents: 34900, status: "REFUNDED", paid_at: "2026-10-14T12:00:00+00:00", created_at: "2026-10-14T15:00:00+00:00", billing_period_start: null, billing_period_end: null, estorna_pagamento_id: "bp-1" },
        ],
      },
    });
    const base = clienteFalso(banco) as unknown as Record<string, unknown>;
    const chamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];
    const admin = {
      ...base,
      rpc: async (nome: string, args: Record<string, unknown>) => {
        chamadas.push({ nome, args });
        return { data: 1, error: null };
      },
    };
    const enfileiradas: string[] = [];
    const avisos = criarAvisosDeCobrancaSobre(admin as never, {
      enfileirar: async (e) => {
        enfileiradas.push(e.emailId);
        return "enfileirado";
      },
    });
    return { avisos, chamadas, enfileiradas };
  }

  const refund = (extra: Record<string, unknown> = {}) => ({
    eventType: "PAYMENT_REFUNDED",
    resultado: "aplicado" as const,
    organizationId: ORG,
    alarmes: ["estorno_confirmado"],
    idDoPagamento: "pay_abc123",
    cobranca: null,
    ...extra,
  });

  it("estorno total confirmado: fecha o pedido e o e-mail de estorno feito (COB-08) também sai", async () => {
    const { avisos, chamadas, enfileiradas } = avisosComRpc();
    await avisos.aoAplicar(refund());
    expect(chamadas).toEqual([
      { nome: "fn_billing_reembolso_concluir_por_pagamento", args: { p_org: ORG, p_asaas_payment_id: "pay_abc123" } },
    ]);
    expect(enfileiradas).toEqual(["COB-08"]);
  });

  it("evento já aplicado antes, ou sem estorno confirmado, não mexe no pedido", async () => {
    const { avisos, chamadas } = avisosComRpc();
    await avisos.aoAplicar(refund({ resultado: "ja_aplicado", alarmes: [] }));
    await avisos.aoAplicar(refund({ alarmes: [] }));
    await avisos.aoAplicar({ ...refund(), eventType: "PAYMENT_PARTIALLY_REFUNDED" });
    expect(chamadas).toEqual([]);
  });
});
