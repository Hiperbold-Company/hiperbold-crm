/**
 * Migração 1026: régua de cobrança do pedido de assinatura não pago. Provado no Postgres real, chamando as funções
 * com o relógio (`p_agora`) que o job usaria:
 *
 *   1. o gatilho grava `vence_em` na criação (cartão com período vigente, cartão sem período, parcelado, Pix);
 *   2. o caso real (pedido 10/11, vencimento 13/11, suspensão 20/11): cada marco sai uma vez, no dia certo, só o
 *      mais recente; a fatura NÃO sai no vencimento nem antes da suspensão, e sai depois dela;
 *   3. quem não chega a suspensa (pedido feito com a conta já suspensa, sem contrato com período, Pix adiantado):
 *      remoção em vencimento + carência do plano do pedido, nunca antes;
 *   4. pedido anterior à 1026 (sem `vence_em`): o substituto só erra para mais tarde;
 *   5. pago para a régua; pacote de tokens vencido continua saindo no dia seguinte;
 *   6. a régua: marco já enfileirado sai da lista, só da organização dona; outra organização não é afetada;
 *      organização inativa não recebe; `fn_billing_pedido_gravar_vencimento` só mexe no pedido da organização dada;
 *   7. as funções são só do servidor: anon e authenticated barrados;
 *   8. pedido superado (o contrato ganhou cancelamento, ou entrou pagamento por outro caminho, DEPOIS do pedido):
 *      sai já, sem marco; cancelamento anterior ao pedido e pagamento estornado não contam.
 *
 * Roda via `pnpm test:db tests/invariants/regua-de-cobranca-do-pedido.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `1026a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_REAL = U(1);
const ORG_JA_SUSPENSA = U(2);
const ORG_SEM_PERIODO = U(3);
const ORG_PIX_ADIANTADO = U(4);
const ORG_ANTIGO = U(5);
const ORG_PACOTE = U(6);
const ORG_FILA_A = U(7);
const ORG_FILA_B = U(8);
const ORG_INATIVA = U(9);
const ORG_GATILHO = U(10);
const ORG_CANCELOU = U(11);
const ORG_PAGOU_POR_FORA = U(12);
const ORG_CANCELADA_ANTES = U(13);
const ORGS = [
  ORG_REAL, ORG_JA_SUSPENSA, ORG_SEM_PERIODO, ORG_PIX_ADIANTADO, ORG_ANTIGO, ORG_PACOTE, ORG_FILA_A, ORG_FILA_B,
  ORG_INATIVA, ORG_GATILHO, ORG_CANCELOU, ORG_PAGOU_POR_FORA, ORG_CANCELADA_ANTES,
];

/** O horário do job (08:10 em São Paulo) num dia de novembro de 2026. */
const dia = (d: number) => `2026-11-${String(d).padStart(2, "0")} 11:10:00+00`;

let GRACE = 7;

function erroDe(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

function contrato(org: string, c: { status: string; fim: string | null }): void {
  sql(`
    update public.billing_contracts
       set plan_id = (select id from public.billing_plans where code = 'pro' and active limit 1),
           status = '${c.status}',
           cycle = 'monthly',
           gateway = 'asaas',
           current_period_end = ${c.fim === null ? "null" : `'${c.fim}'::timestamptz`},
           cancel_at_period_end = false
     where organization_id = '${org}';
  `);
}

interface Pedido {
  status?: string;
  tipo?: "assinatura" | "pacote_tokens";
  metodo?: "CREDIT_CARD" | "PIX";
  parcelas?: number;
  criadoEm: string;
  venceEm?: string | null;
  pay?: string | null;
  sub?: string | null;
}

/** Insere o pedido como o banco o teria (sem passar pelo Asaas) e devolve o id. */
function pedido(org: string, p: Pedido): string {
  const tipo = p.tipo ?? "assinatura";
  const plano = tipo === "assinatura" ? "(select id from public.billing_plans where code = 'pro' and active limit 1)" : "null";
  const pacote = tipo === "pacote_tokens" ? "(select id from public.billing_token_pacotes where codigo = 'r1026pacote')" : "null";
  return sql(`
    insert into public.billing_orders
      (organization_id, ambiente, tipo, plan_id, ciclo, pacote_id, tokens, metodo, amount_cents, status, chave,
       asaas_payment_id, asaas_subscription_id, created_at, vence_em, parcelas)
    values
      ('${org}', 'producao', '${tipo}', ${plano}, ${tipo === "assinatura" ? ((p.parcelas ?? 1) > 1 ? "'yearly'" : "'monthly'") : "null"}, ${pacote},
       ${tipo === "pacote_tokens" ? "1000" : "null"}, '${p.metodo ?? "CREDIT_CARD"}', 19900, '${p.status ?? "aguardando_pagamento"}',
       gen_random_uuid(), ${p.pay === null ? "null" : `'${p.pay ?? `pay_${Math.random().toString(36).slice(2, 10)}`}'`},
       ${p.sub ? `'${p.sub}'` : "null"}, '${p.criadoEm}'::timestamptz,
       ${p.venceEm === undefined ? "null" : p.venceEm === null ? "null" : `'${p.venceEm}'::date`}, ${p.parcelas ?? 1})
    returning id;
  `).split("\n")[0]!;
}

/** `limite|limite_em|pode_remover|marco` do pedido no instante dado. */
function prazo(id: string, agora: string): string {
  return sql(`
    select limite || '|' || limite_em || '|' || pode_remover::text || '|' || coalesce(marco, '-')
      from public.fn_billing_pedidos_de_assinatura_em_aberto('${agora}'::timestamptz, null, '${id}'::uuid);
  `);
}

const naRemocao = (id: string, agora: string) =>
  sql(`select count(*) from public.fn_billing_pedidos_vencidos_para_remocao('${agora}'::timestamptz, 10000) where pedido_id = '${id}';`) === "1";

const naRegua = (id: string, agora: string) =>
  sql(`select coalesce(string_agg(marco, ','), '-') from public.fn_billing_regua_de_cobranca_pendentes('${agora}'::timestamptz, 10000) where pedido_id = '${id}';`);

function suspender(org: string, quando: string): void {
  sql(`
    update public.billing_contracts set status = 'suspensa' where organization_id = '${org}';
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor, criado_em)
    select '${org}', id, 'conferidor', 'atrasada', 'suspensa', 'conferidor', null, '${quando}'::timestamptz
      from public.billing_contracts where organization_id = '${org}';
  `);
}

beforeAll(() => {
  for (const [i, org] of ORGS.entries()) {
    sql(
      `insert into public.organizations (id, slug, legal_name, display_name) values ('${org}', 'regua-1026-${i}', 'r LTDA', 'r') on conflict (id) do nothing;`,
    );
  }
  GRACE = Number(sql(`select grace_days from public.billing_plans where code = 'pro' and active limit 1;`));
  sql(
    `insert into public.billing_token_pacotes (codigo, nome, tokens, preco_cents, ativo) values ('r1026pacote', 'Pacote 1026', 1000, 990, true) on conflict (codigo) do nothing;`,
  );
});

afterAll(() => {
  sql(`delete from public.organizations where id in (${ORGS.map((o) => `'${o}'`).join(",")});`);
});

describe("1026: o gatilho grava vence_em na criação", () => {
  it("cartão com período vigente: o fim do período; cartão sem período: hoje; parcelado: hoje; Pix: amanhã", () => {
    contrato(ORG_GATILHO, { status: "ativa", fim: "2099-01-10 00:00:00-03" });
    const hoje = sql(`select (now() at time zone 'America/Sao_Paulo')::date;`);
    const amanha = sql(`select (now() at time zone 'America/Sao_Paulo')::date + 1;`);
    const venc = (id: string) => sql(`select vence_em from public.billing_orders where id = '${id}';`);

    expect(venc(pedido(ORG_GATILHO, { criadoEm: "now()", status: "cancelado" }))).toBe("2099-01-10");
    expect(venc(pedido(ORG_GATILHO, { criadoEm: "now()", status: "cancelado", metodo: "PIX" }))).toBe(amanha);
    expect(venc(pedido(ORG_GATILHO, { criadoEm: "now()", status: "cancelado", parcelas: 3 }))).toBe(hoje);
    contrato(ORG_GATILHO, { status: "atrasada", fim: "2020-01-10 00:00:00-03" });
    expect(venc(pedido(ORG_GATILHO, { criadoEm: "now()", status: "cancelado" }))).toBe(hoje);
    // Quem insere com a data não é sobrescrito.
    expect(venc(pedido(ORG_GATILHO, { criadoEm: "now()", status: "cancelado", venceEm: "2030-05-05" }))).toBe("2030-05-05");
  });
});

describe("1026: o caso real (pedido 10/11, vencimento 13/11, contrato acabando em 13/11)", () => {
  let id = "";

  it("prepara o contrato em avaliação até 13/11 e o pedido no cartão de 10/11", () => {
    contrato(ORG_REAL, { status: "avaliacao", fim: "2026-11-13 00:00:00-03" });
    id = pedido(ORG_REAL, { criadoEm: "2026-11-10 15:00:00-03", venceEm: "2026-11-13", sub: "sub_real" });
    const suspensao = `2026-11-${13 + GRACE}`;
    expect(prazo(id, dia(10))).toBe(`suspensao|${suspensao}|false|-`);
  });

  it("dia a dia: cada marco sai uma vez, no dia certo, e só o mais recente", () => {
    const primeiroDia = new Map<string, number>();
    for (let d = 10; d <= 13 + GRACE + 1; d++) {
      const marco = prazo(id, dia(d)).split("|")[3]!;
      if (marco !== "-" && !primeiroDia.has(marco)) primeiroDia.set(marco, d);
    }
    expect(Object.fromEntries(primeiroDia)).toEqual({ antes: 11, no_dia: 13, depois: 15, ultimo_dia: 13 + GRACE - 1 });
    // No dia da suspensão em diante não há marco (a fatura ainda existe, mas a régua acabou).
    expect(prazo(id, dia(13 + GRACE)).split("|")[3]).toBe("-");
  });

  it("vencido (PAYMENT_OVERDUE) e o contrato atrasado: a fatura NÃO sai, nem no vencimento nem na carência", () => {
    sql(`update public.billing_orders set status = 'vencido' where id = '${id}';`);
    sql(`update public.billing_contracts set status = 'atrasada' where organization_id = '${ORG_REAL}';`);
    for (let d = 13; d <= 13 + GRACE; d++) expect(naRemocao(id, dia(d))).toBe(false);
    // A régua continua com o pedido vencido.
    expect(prazo(id, dia(15)).split("|")[3]).toBe("depois");
  });

  it("contrato suspenso (20/11): a fatura sai na conciliação seguinte", () => {
    suspender(ORG_REAL, `2026-11-${13 + GRACE} 05:40:00+00`);
    expect(naRemocao(id, dia(13 + GRACE + 1))).toBe(true);
    expect(prazo(id, dia(13 + GRACE + 1))).toBe(`suspensao|2026-11-${13 + GRACE}|true|-`);
  });

  it("pago: sai da régua e da remoção", () => {
    sql(`update public.billing_orders set status = 'pago' where id = '${id}';`);
    expect(prazo(id, dia(15))).toBe("");
    expect(naRemocao(id, dia(25))).toBe(false);
  });
});

describe("1026: quem não chega a suspensa remove em vencimento + carência do plano do pedido", () => {
  it("pedido feito com a conta JÁ suspensa: não remove pela suspensão antiga", () => {
    contrato(ORG_JA_SUSPENSA, { status: "atrasada", fim: "2026-10-01 00:00:00-03" });
    suspender(ORG_JA_SUSPENSA, "2026-10-08 05:40:00+00");
    const id = pedido(ORG_JA_SUSPENSA, { criadoEm: "2026-11-05 10:00:00-03", venceEm: "2026-11-05", status: "vencido", sub: "sub_js" });
    const limite = `2026-11-${String(5 + GRACE).padStart(2, "0")}`;
    expect(prazo(id, dia(6)).split("|").slice(0, 3).join("|")).toBe(`remocao|${limite}|false`);
    expect(naRemocao(id, dia(5 + GRACE - 1))).toBe(false);
    expect(naRemocao(id, dia(5 + GRACE))).toBe(true);
  });

  it("sem período no contrato: remoção em vencimento + carência", () => {
    contrato(ORG_SEM_PERIODO, { status: "ativa", fim: null });
    const id = pedido(ORG_SEM_PERIODO, { criadoEm: "2026-11-02 10:00:00-03", venceEm: "2026-11-02", status: "vencido", sub: "sub_sp" });
    expect(prazo(id, dia(3)).split("|")[0]).toBe("remocao");
    expect(naRemocao(id, dia(2 + GRACE - 1))).toBe(false);
    expect(naRemocao(id, dia(2 + GRACE))).toBe(true);
  });

  it("Pix adiantado (período vai longe): remoção em vencimento + carência, não espera a suspensão", () => {
    contrato(ORG_PIX_ADIANTADO, { status: "ativa", fim: "2026-12-20 00:00:00-03" });
    const id = pedido(ORG_PIX_ADIANTADO, { metodo: "PIX", criadoEm: "2026-11-01 10:00:00-03", venceEm: "2026-11-02", status: "vencido" });
    expect(prazo(id, dia(3)).split("|").slice(0, 2).join("|")).toBe(`remocao|2026-11-${String(2 + GRACE).padStart(2, "0")}`);
    expect(naRemocao(id, dia(2 + GRACE))).toBe(true);
  });
});

describe("1026: pedido anterior à migration (sem vence_em) e pacote de tokens", () => {
  it("sem vence_em, o substituto nunca é antes do vencimento real (dia seguinte à criação ou fim do período)", () => {
    contrato(ORG_ANTIGO, { status: "atrasada", fim: "2026-11-08 00:00:00-03" });
    const id = pedido(ORG_ANTIGO, { criadoEm: "2026-11-03 10:00:00-03", status: "vencido", sub: "sub_antigo" });
    sql(`update public.billing_orders set vence_em = null where id = '${id}';`);
    const linha = sql(`select vence_em || '|' || vence_em_gravado::text from public.fn_billing_pedidos_de_assinatura_em_aberto('${dia(9)}'::timestamptz, null, '${id}'::uuid);`);
    expect(linha).toBe("2026-11-08|false");
    // Entra na régua (sem marco ainda) para o vencimento ser lido no Asaas e gravado.
    expect(
      sql(`select count(*) from public.fn_billing_regua_de_cobranca_pendentes('${dia(4)}'::timestamptz, 10000) where pedido_id = '${id}' and not vence_em_gravado;`),
    ).toBe("1");
  });

  it("pacote de tokens vencido continua na remoção, como antes", () => {
    const id = pedido(ORG_PACOTE, { tipo: "pacote_tokens", criadoEm: "2026-11-01 10:00:00-03", status: "vencido" });
    expect(naRemocao(id, dia(2))).toBe(true);
    expect(prazo(id, dia(2))).toBe("");
  });
});

describe("1026: a lista da régua e o isolamento entre organizações", () => {
  let a = "";
  let b = "";

  it("prepara dois pedidos no mesmo marco, em organizações diferentes", () => {
    for (const org of [ORG_FILA_A, ORG_FILA_B]) contrato(org, { status: "avaliacao", fim: "2026-11-13 00:00:00-03" });
    a = pedido(ORG_FILA_A, { criadoEm: "2026-11-10 10:00:00-03", venceEm: "2026-11-13", sub: "sub_a" });
    b = pedido(ORG_FILA_B, { criadoEm: "2026-11-10 10:00:00-03", venceEm: "2026-11-13", sub: "sub_b" });
    expect(naRegua(a, dia(13))).toBe("no_dia");
    expect(naRegua(b, dia(13))).toBe("no_dia");
  });

  it("marco já enfileirado sai da lista só para a organização dona", () => {
    sql(
      `insert into public.billing_emails_enviados (organization_id, email_id, chave, destino, dados) values ('${ORG_FILA_A}', 'COB-05', 'pedido:${a}:no_dia', 'admins', '{}'::jsonb);`,
    );
    expect(naRegua(a, dia(13))).toBe("-");
    expect(naRegua(b, dia(13))).toBe("no_dia");
    // A chave do pedido A gravada na organização B não silencia o pedido B.
    sql(
      `insert into public.billing_emails_enviados (organization_id, email_id, chave, destino, dados) values ('${ORG_FILA_B}', 'COB-05', 'pedido:${a}:depois', 'admins', '{}'::jsonb);`,
    );
    expect(naRegua(a, dia(15))).toBe("depois");
  });

  it("o filtro por organização não devolve pedido de outra", () => {
    const n = sql(`select count(*) from public.fn_billing_pedidos_de_assinatura_em_aberto('${dia(13)}'::timestamptz, '${ORG_FILA_A}'::uuid, '${b}'::uuid);`);
    expect(n).toBe("0");
  });

  it("gravar o vencimento com a organização errada não muda nada", () => {
    expect(sql(`select public.fn_billing_pedido_gravar_vencimento('${ORG_FILA_A}'::uuid, '${b}'::uuid, '2026-11-20');`)).toBe("f");
    expect(sql(`select vence_em from public.billing_orders where id = '${b}';`)).toBe("2026-11-13");
    expect(sql(`select public.fn_billing_pedido_gravar_vencimento('${ORG_FILA_B}'::uuid, '${b}'::uuid, '2026-11-14');`)).toBe("t");
    expect(sql(`select vence_em from public.billing_orders where id = '${b}';`)).toBe("2026-11-14");
  });

  it("organização inativa não entra na régua", () => {
    contrato(ORG_INATIVA, { status: "avaliacao", fim: "2026-11-13 00:00:00-03" });
    const id = pedido(ORG_INATIVA, { criadoEm: "2026-11-10 10:00:00-03", venceEm: "2026-11-13", sub: "sub_i" });
    expect(naRegua(id, dia(13))).toBe("no_dia");
    sql(`update public.organizations set status = 'suspended' where id = '${ORG_INATIVA}';`);
    expect(naRegua(id, dia(13))).toBe("-");
  });
});

describe("1026 (M3): pedido superado por cancelamento ou por pagamento de outro caminho sai já, sem marco", () => {
  function cancelarNoFim(org: string, quando: string): void {
    sql(`
      update public.billing_contracts set cancel_at_period_end = true where organization_id = '${org}';
      insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor, criado_em)
      select '${org}', id, 'cancelar_no_fim', 'false', 'true', 'teste_1026', null, '${quando}'::timestamptz
        from public.billing_contracts where organization_id = '${org}';
    `);
  }

  it("cancelamento no fim do período DEPOIS do pedido: remover já, em qualquer status, sem e-mail", () => {
    contrato(ORG_CANCELOU, { status: "avaliacao", fim: "2026-11-13 00:00:00-03" });
    const id = pedido(ORG_CANCELOU, { criadoEm: "2026-11-10 10:00:00-03", venceEm: "2026-11-13", sub: "sub_cancelou" });
    expect(prazo(id, dia(11)).split("|")[3]).toBe("antes");
    cancelarNoFim(ORG_CANCELOU, "2026-11-11 15:00:00-03");
    expect(prazo(id, dia(12))).toBe("superado|2026-11-12|true|-");
    expect(naRemocao(id, dia(12))).toBe(true);
    expect(naRegua(id, dia(13))).toBe("-");
  });

  it("cancelamento ANTES do pedido (quem cancelou e voltou a assinar): segue a régua", () => {
    contrato(ORG_CANCELADA_ANTES, { status: "avaliacao", fim: "2026-11-13 00:00:00-03" });
    cancelarNoFim(ORG_CANCELADA_ANTES, "2026-11-05 15:00:00-03");
    const id = pedido(ORG_CANCELADA_ANTES, { criadoEm: "2026-11-10 10:00:00-03", venceEm: "2026-11-13", sub: "sub_antes" });
    expect(prazo(id, dia(13)).split("|")[0]).not.toBe("superado");
    expect(naRegua(id, dia(13))).toBe("no_dia");
    expect(naRemocao(id, dia(13))).toBe(false);
  });

  it("pagamento por outro caminho depois do pedido: remover já; estornado ou sem período não conta", () => {
    contrato(ORG_PAGOU_POR_FORA, { status: "atrasada", fim: "2026-11-13 00:00:00-03" });
    const id = pedido(ORG_PAGOU_POR_FORA, { criadoEm: "2026-11-10 10:00:00-03", venceEm: "2026-11-13", status: "vencido", sub: "sub_fora" });
    const pagar = (status: string, estorna: string | null, comPeriodo = true): string =>
      sql(`
        insert into public.billing_payments
          (organization_id, contract_id, gross_cents, status, paid_at, billing_period_start, billing_period_end, chave, origem, estorna_pagamento_id)
        select '${ORG_PAGOU_POR_FORA}', c.id, 19900, '${status}', '2026-11-14 12:00:00-03',
               ${comPeriodo ? "'2026-11-13 00:00:00-03'" : "null"}, ${comPeriodo ? "'2026-12-13 00:00:00-03'" : "null"},
               gen_random_uuid(), '${comPeriodo ? "manual" : "asaas"}', ${estorna ? `'${estorna}'::uuid` : "null"}
          from public.billing_contracts c where c.organization_id = '${ORG_PAGOU_POR_FORA}'
        returning id;
      `).split("\n")[0]!;
    expect(prazo(id, dia(15)).split("|")[3]).toBe("depois");
    // Pagamento que já foi estornado (com a linha de estorno apontando para ele): não supera.
    const estornado = pagar("RECEIVED_IN_CASH", null);
    pagar("REFUNDED", estornado);
    expect(prazo(id, dia(15)).split("|")[3]).toBe("depois");
    // Pacote de tokens ou parcela seguinte de parcelado pago (sem período concedido): não supera.
    pagar("RECEIVED", null, false);
    expect(prazo(id, dia(15)).split("|")[3]).toBe("depois");
    pagar("RECEIVED_IN_CASH", null);
    expect(prazo(id, dia(15))).toBe("superado|2026-11-15|true|-");
    expect(naRemocao(id, dia(15))).toBe(true);
    expect(naRegua(id, dia(15))).toBe("-");
  });
});

describe("1026: as funções são só do servidor", () => {
  const chamadas = [
    `select * from public.fn_billing_pedidos_de_assinatura_em_aberto(now(), null, null)`,
    `select * from public.fn_billing_pedidos_vencidos_para_remocao(now(), 1)`,
    `select * from public.fn_billing_regua_de_cobranca_pendentes(now(), 1)`,
    `select public.fn_billing_pedido_gravar_vencimento('${U(99)}'::uuid, '${U(98)}'::uuid, '2026-01-01')`,
  ];
  for (const papel of ["anon", "authenticated"]) {
    it(`${papel} não executa nenhuma`, () => {
      for (const c of chamadas) {
        const erro = erroDe(`set role ${papel};\n${c};\nreset role;`);
        expect(erro, c).toMatch(/permission denied/);
      }
    });
  }
});
