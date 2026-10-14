/**
 * Migração 0955: cupons de desconto na compra do plano (fork Hiperbold). Provado no Postgres real, pelo
 * mesmo caminho do processador (registrar evento, reservar com lease, aplicar com o objeto confirmado):
 *
 *   1. a conta do desconto: percentual (teto 99), valor, piso de 500 centavos, arredondamento;
 *   2. as restrições da tabela e das funções do admin (código, tipo, valor, planos, ciclos, validade, usos);
 *   3. fn_billing_criar_pedido com cupom de cada tipo, no mensal, no semestral à vista e parcelado (juros
 *      sobre o preço já descontado), e o cupom na identidade da chave idempotente;
 *   4. as recusas: inexistente, inativo, expirado, esgotado, plano errado, ciclo errado, organização que já
 *      usou, pacote de tokens;
 *   5. quem não manda cupom tem o comportamento de antes;
 *   6. fn_billing_cupom_simular (só leitura);
 *   7. a conciliação: a primeira cobrança com desconto bate com amount_cents e a renovação continua
 *      exigindo o preço cheio do ciclo;
 *   8. ACL e RLS: anon e authenticated não leem nem escrevem billing_cupons nem executam as funções.
 *
 * Roda via `pnpm test:db tests/invariants/cupons-banco.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { calcularParcelamento } from "@/lib/billing/asaas/parcelamento";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `0955a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_PEDIDOS = U(1);
const ORG_CARTAO_PAGO = U(2);
const ORG_PIX_PAGO = U(3);
const ORG_OUTRA = U(4);
const ORG_IDEMPOTENCIA = U(5);
const ORG_LIMITE_A = U(6);
const ORG_LIMITE_B = U(7);
const ORG_PAGADOR_X = U(8);
const ORG_PAGADOR_Y = U(9);
const ORG_PARCELAS = U(10);
const ORGS = [
  ORG_PEDIDOS, ORG_CARTAO_PAGO, ORG_PIX_PAGO, ORG_OUTRA, ORG_IDEMPOTENCIA, ORG_LIMITE_A, ORG_LIMITE_B,
  ORG_PAGADOR_X, ORG_PAGADOR_Y, ORG_PARCELAS,
];

/** Impressões de pagador (HMAC de 64 hexadecimais). O banco só vê isto, nunca o documento. */
const IMPRESSAO_A = "a".repeat(64);
const IMPRESSAO_B = "b".repeat(64);

/** Os parâmetros de parcelamento semeados (taxa de 1,99% ao mês, 3x sem juros, semestral até 6x, anual até 12x). */
const PARAMETROS = { taxaMensal: 0.0199, semJurosAte: 3, maxSemestral: 6, maxAnual: 12 };

const HOJE = "to_char(current_date, 'YYYY-MM-DD')";
const SEM_TEXTO = "'{}'::text[]";

let MENSAL = 0;
let SEMESTRAL = 0;
let ANUAL = 0;

function erroDe(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

/** A conta que o banco deve fazer, escrita de outro jeito (inteiros, half-up). */
function descontoEsperado(tipo: "percentual" | "valor", valor: number, preco: number): number {
  const noventaENove = Math.floor((preco * 99 + 50) / 100);
  const bruto = tipo === "percentual" ? Math.floor((preco * Math.min(valor, 99) + 50) / 100) : Math.min(valor, noventaENove);
  const total = Math.max(preco - bruto, Math.min(500, preco));
  return preco - total;
}

const reais = (cents: number) => (cents / 100).toFixed(2);

interface OpcoesCupom {
  planos?: string[];
  ciclos?: string[];
  validoAte?: string | null;
  maxUsos?: number | null;
}

function criarCupomSql(codigo: string, tipo: string, valor: number, o: OpcoesCupom = {}): string {
  const lista = (itens: string[] | undefined) => (itens && itens.length > 0 ? `array[${itens.map((i) => `'${i}'`).join(",")}]::text[]` : SEM_TEXTO);
  return `select public.fn_billing_cupom_criar('${codigo}', '${tipo}', ${valor}, ${lista(o.planos)}, ${lista(o.ciclos)}, ${o.validoAte ? `'${o.validoAte}'::timestamptz` : "null"}, ${o.maxUsos ?? "null"}, null, null);`;
}

function criarCupom(codigo: string, tipo: string, valor: number, o: OpcoesCupom = {}): string {
  return sql(criarCupomSql(codigo, tipo, valor, o));
}

interface OpcoesPedido {
  cupom?: string | null;
  parcelas?: number;
  total?: number | null;
  chave?: string;
  plano?: string;
  impressao?: string | null;
}

function chamadaDoPedido(org: string, ciclo: string, metodo: string, o: OpcoesPedido = {}): string {
  const chave = o.chave ? `'${o.chave}'::uuid` : "gen_random_uuid()";
  const cupom = o.cupom === undefined || o.cupom === null ? "null" : `'${o.cupom}'`;
  return `public.fn_billing_criar_pedido('${org}'::uuid, 'assinatura', '${o.plano ?? "pro"}', '${ciclo}', null, '${metodo}', 'sandbox', ${chave}, null, null, ${o.parcelas ?? 1}, ${o.total === undefined || o.total === null ? "null" : o.total}, ${cupom}, ${o.impressao ? `'${o.impressao}'` : "null"})`;
}

function tentarPedido(org: string, ciclo: string, metodo: string, o: OpcoesPedido = {}): string | null {
  return erroDe(`select ${chamadaDoPedido(org, ciclo, metodo, o)};`);
}

function pedir(org: string, ciclo: string, metodo: string, o: OpcoesPedido = {}): Record<string, unknown> {
  return JSON.parse(sql(`select ${chamadaDoPedido(org, ciclo, metodo, o)};`)) as Record<string, unknown>;
}

const abertos = (org: string) =>
  sql(`select count(*) from public.billing_orders where organization_id = '${org}' and status in ('criado', 'aguardando_pagamento', 'processando', 'inconclusivo');`);
const cancelarAbertos = (org: string) =>
  sql(`update public.billing_orders set status = 'cancelado' where organization_id = '${org}' and status in ('criado', 'aguardando_pagamento', 'processando', 'inconclusivo');`);
const colunasDoPedido = (pedido: string, colunas: string) =>
  sql(`select ${colunas} from public.billing_orders where id = '${pedido}';`);

function registrarEAplicar(eventId: string, tipo: string, pagamento: string, confirmacao: string): string {
  sql(`select public.fn_billing_asaas_registrar_evento('${eventId}', '${tipo}', '${pagamento}', 'sandbox', 'webhook', '{}'::jsonb);`);
  sql(`select public.fn_billing_asaas_reservar_eventos(50, 300);`);
  const linha = sql(`select id, lease_token from public.asaas_webhook_events where event_id = '${eventId}';`);
  const [id, lease] = linha.split("|");
  expect(id, `evento ${eventId} não foi reservado`).toBeTruthy();
  return sql(`select public.fn_billing_asaas_aplicar_evento('${(id ?? "").trim()}'::uuid, '${(lease ?? "").trim()}'::uuid, ${confirmacao});`);
}

function confirmacao(pagamento: string, status: string, valorEmReais: string, extra: string): string {
  return `jsonb_build_object('id','${pagamento}','status','${status}','value',${valorEmReais},'dueDate',${HOJE},'paymentDate',${HOJE}${extra})`;
}

describe("0955: setup", () => {
  it("cria as organizações, liga a compra e a venda do Pro e do Max, e lê os preços do Pro", () => {
    sql(`
      ${ORGS.map((id) => `insert into public.organizations (id, slug, legal_name, display_name) values ('${id}', 'i955-${id.slice(-2)}', 'i955 LTDA', 'i955') on conflict (id) do nothing;`).join("\n")}
      select public.fn_billing_definir_compra_pelo_cliente(true, null);
      select public.fn_billing_definir_a_venda('pro', true, null);
      select public.fn_billing_definir_a_venda('max', true, null);
      update public.billing_settings set asaas_sandbox_concede = true where id = 1;
      insert into public.billing_token_pacotes (codigo, nome, tokens, preco_cents, ativo)
        values ('pacote_teste', 'Pacote de teste', 1000, 5000, true) on conflict (codigo) do nothing;
    `);
    expect(sql(`select count(*) from public.organizations where id = any(array[${ORGS.map((id) => `'${id}'`).join(",")}]::uuid[]);`)).toBe(String(ORGS.length));
    const [m, s, a] = sql(`select price_monthly_cents || '|' || price_semiannual_cents || '|' || price_yearly_cents from public.billing_plans where code = 'pro' and active;`).split("|");
    MENSAL = Number(m);
    SEMESTRAL = Number(s);
    ANUAL = Number(a);
    expect(MENSAL).toBeGreaterThan(5000);
    expect(SEMESTRAL).toBeGreaterThan(MENSAL);
    expect(ANUAL).toBeGreaterThan(SEMESTRAL);
  });
});

describe("0955 item 1: a conta do desconto", () => {
  const conta = (tipo: string, valor: number, preco: number) => sql(`select public.fn_billing_cupom_desconto('${tipo}', ${valor}, ${preco});`);

  it("percentual e valor", () => {
    expect(conta("percentual", 10, 100000)).toBe("10000");
    expect(conta("percentual", 25, 104900)).toBe(String(descontoEsperado("percentual", 25, 104900)));
    expect(conta("valor", 5000, 104900)).toBe("5000");
  });

  it("arredonda para cima na metade (half-up)", () => {
    expect(conta("percentual", 15, 333)).toBe("0"); // preço abaixo do piso não recebe desconto
    expect(conta("percentual", 50, 1001)).toBe("501"); // 500,5 vira 501
    expect(conta("percentual", 15, 1010)).toBe("152"); // 151,5 vira 152
  });

  it("teto de 99% e piso de 500 centavos no total", () => {
    expect(conta("percentual", 99, 100000)).toBe("99000");
    expect(conta("percentual", 150, 100000)).toBe("99000"); // a função nunca passa de 99
    expect(conta("percentual", 99, 19900)).toBe("19400"); // 99% daria total 199; sobe para 500
    expect(conta("valor", 104900, 104900)).toBe("103851"); // valor fixo: no máximo 99% do preço
    expect(conta("valor", 999999, 100000)).toBe("99000");
    expect(conta("valor", 999999, 19900)).toBe("19400"); // 99% daria total 199; sobe para 500
  });

  it("preço igual ou menor que o piso não recebe desconto, e entrada inválida devolve zero", () => {
    expect(conta("valor", 100, 500)).toBe("0");
    expect(conta("percentual", 50, 400)).toBe("0");
    expect(conta("valor", 0, 10000)).toBe("0");
    expect(conta("percentual", 10, 0)).toBe("0");
    expect(conta("estranho", 10, 10000)).toBe("0");
  });

  it("bate com a conta de referência para vários preços, valores e tipos", () => {
    for (const preco of [MENSAL, SEMESTRAL, ANUAL, 501, 999, 12345]) {
      for (const valor of [1, 7, 10, 33, 50, 99]) {
        expect(conta("percentual", valor, preco), `${valor}% de ${preco}`).toBe(String(descontoEsperado("percentual", valor, preco)));
      }
      for (const valor of [1, 500, 5000, preco - 1, preco, preco * 2]) {
        expect(conta("valor", valor, preco), `${valor} de ${preco}`).toBe(String(descontoEsperado("valor", valor, preco)));
      }
    }
  });
});

describe("0955 item 2: tabela e funções do admin", () => {
  const inserir = (codigo: string, tipo: string, valor: number, extra = "") =>
    erroDe(`insert into public.billing_cupons (codigo, tipo, valor${extra ? ", " + extra.split("=")[0] : ""}) values ('${codigo}', '${tipo}', ${valor}${extra ? ", " + extra.split("=")[1] : ""});`);

  it("os checks da tabela recusam percentual fora de 1 a 99, valor sem centavos, código fora do formato e ciclo estranho", () => {
    expect(inserir("TESTE100", "percentual", 100)).toContain("billing_cupons_valor_coerente");
    expect(inserir("TESTE0", "percentual", 0)).toContain("billing_cupons_valor_coerente");
    expect(inserir("TESTEV0", "valor", 0)).toContain("billing_cupons_valor_coerente");
    expect(inserir("ab", "valor", 100)).toContain("billing_cupons_codigo_formato");
    expect(inserir("com espaco", "valor", 100)).toContain("billing_cupons_codigo_formato");
    expect(inserir("TESTEX", "frete", 100)).toContain("billing_cupons_tipo_valido");
    expect(inserir("TESTEC", "valor", 100, "ciclos='{semanal}'")).toContain("billing_cupons_ciclos_validos");
    expect(inserir("TESTEU", "valor", 100, "max_usos=0")).toContain("billing_cupons_max_usos_positivo");
    expect(sql(`select count(*) from public.billing_cupons where codigo::text like 'TESTE%';`)).toBe("0");
  });

  it("criar: cria, devolve o id e o código, e o código é único sem diferença de maiúsculas", () => {
    const r = JSON.parse(criarCupom("PCT10", "percentual", 10)) as { id: string; codigo: string };
    expect(r.codigo).toBe("PCT10");
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(erroDe(criarCupomSql("pct10", "valor", 100))).toContain("billing_cupom_codigo_em_uso");
    expect(erroDe(criarCupomSql("Pct10", "percentual", 5))).toContain("billing_cupom_codigo_em_uso");
  });

  it("criar: recusa entrada inválida com o código certo", () => {
    expect(erroDe(criarCupomSql("ab", "valor", 100))).toContain("billing_cupom_codigo_invalido");
    expect(erroDe(criarCupomSql("sem espaco!", "valor", 100))).toContain("billing_cupom_codigo_invalido");
    expect(erroDe(criarCupomSql("OKCODE1", "frete", 100))).toContain("billing_cupom_tipo_invalido");
    expect(erroDe(criarCupomSql("OKCODE2", "percentual", 100))).toContain("billing_cupom_valor_invalido");
    expect(erroDe(criarCupomSql("OKCODE3", "percentual", 0))).toContain("billing_cupom_valor_invalido");
    expect(erroDe(criarCupomSql("OKCODE4", "valor", 0))).toContain("billing_cupom_valor_invalido");
    expect(erroDe(criarCupomSql("OKCODE5", "valor", 100, { planos: ["nao_existe"] }))).toContain("billing_cupom_plano_inexistente");
    expect(erroDe(criarCupomSql("OKCODE6", "valor", 100, { ciclos: ["semanal"] }))).toContain("billing_cupom_ciclo_invalido");
    expect(erroDe(criarCupomSql("OKCODE7", "valor", 100, { validoAte: "2020-01-01T00:00:00Z" }))).toContain("billing_cupom_validade_invalida");
    expect(erroDe(criarCupomSql("OKCODE8", "valor", 100, { maxUsos: 0 }))).toContain("billing_cupom_max_usos_invalido");
    expect(sql(`select count(*) from public.billing_cupons where codigo::text like 'OKCODE%';`)).toBe("0");
  });

  it("criar: planos e ciclos repetidos são normalizados", () => {
    criarCupom("NORMALIZA", "valor", 100, { planos: ["pro", "max", "pro"], ciclos: ["yearly", "monthly", "yearly"] });
    expect(sql(`select array_to_string(planos, ',') || '|' || array_to_string(ciclos, ',') from public.billing_cupons where codigo = 'normaliza';`)).toBe("max,pro|monthly,yearly");
  });

  it("definir ativo: liga e desliga, e cupom inexistente é P0002", () => {
    const id = sql(`select id from public.billing_cupons where codigo = 'NORMALIZA';`);
    const off = JSON.parse(sql(`select public.fn_billing_cupom_definir_ativo('${id}'::uuid, false, null);`)) as Record<string, unknown>;
    expect(off).toMatchObject({ ativo_anterior: true, ativo_novo: false });
    const on = JSON.parse(sql(`select public.fn_billing_cupom_definir_ativo('${id}'::uuid, true, null);`)) as Record<string, unknown>;
    expect(on).toMatchObject({ ativo_anterior: false, ativo_novo: true });
    expect(erroDe(`select public.fn_billing_cupom_definir_ativo(gen_random_uuid(), true, null);`)).toContain("billing_cupom_nao_encontrado");
    expect(erroDe(`select public.fn_billing_cupom_definir_ativo('${id}'::uuid, null, null);`)).toContain("billing_cupom_ativo_obrigatorio");
  });
});

describe("0955 item 3: fn_billing_criar_pedido com cupom", () => {
  it("percentual no mensal, no cartão: amount_cents é o total com desconto e o pedido guarda cupom, desconto e preço cheio", () => {
    const desconto = descontoEsperado("percentual", 10, MENSAL);
    const r = pedir(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: "PCT10" });
    expect(r.amount_cents).toBe(MENSAL - desconto);
    expect(r.desconto_cents).toBe(desconto);
    expect(r.ja_existia).toBe(false);
    expect(colunasDoPedido(r.pedido_id as string, "amount_cents || '|' || desconto_cents || '|' || preco_cheio_cents || '|' || (cupom_id is not null)::text || '|' || parcelas")).toBe(
      `${MENSAL - desconto}|${desconto}|${MENSAL}|true|1`,
    );
    cancelarAbertos(ORG_PEDIDOS);
  });

  it("o código vale sem diferença de maiúsculas e minúsculas e ignora espaços nas pontas", () => {
    const r = pedir(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: "  pCt10 " });
    expect(r.desconto_cents).toBe(descontoEsperado("percentual", 10, MENSAL));
    cancelarAbertos(ORG_PEDIDOS);
  });

  it("valor fixo no semestral, no Pix", () => {
    criarCupom("VALOR50", "valor", 5000);
    const r = pedir(ORG_PEDIDOS, "semiannual", "PIX", { cupom: "VALOR50" });
    expect(r.amount_cents).toBe(SEMESTRAL - 5000);
    expect(r.desconto_cents).toBe(5000);
    cancelarAbertos(ORG_PEDIDOS);
  });

  it("o piso de R$ 5,00: percentual de 99 e valor gigante deixam o total em 500", () => {
    criarCupom("P99", "percentual", 99);
    criarCupom("GIGANTE", "valor", 99999999);
    for (const codigo of ["P99", "GIGANTE"]) {
      const r = pedir(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: codigo });
      expect(r.amount_cents, codigo).toBe(500);
      expect(r.desconto_cents, codigo).toBe(MENSAL - 500);
      cancelarAbertos(ORG_PEDIDOS);
    }
  });

  it("parcelado: os juros incidem sobre o preço já descontado, com ou sem o total informado", () => {
    const descontado = SEMESTRAL - descontoEsperado("percentual", 10, SEMESTRAL);
    const esperado = calcularParcelamento(descontado, 4, PARAMETROS).totalCents;
    const semJuros = calcularParcelamento(SEMESTRAL, 4, PARAMETROS).totalCents;
    expect(esperado).toBeLessThan(semJuros);

    expect(pedir(ORG_PEDIDOS, "semiannual", "CREDIT_CARD", { cupom: "PCT10", parcelas: 4 }).amount_cents).toBe(esperado);
    cancelarAbertos(ORG_PEDIDOS);
    expect(pedir(ORG_PEDIDOS, "semiannual", "CREDIT_CARD", { cupom: "PCT10", parcelas: 4, total: esperado }).amount_cents).toBe(esperado);
    cancelarAbertos(ORG_PEDIDOS);
    // O total informado é conferido: o do preço cheio não serve.
    expect(tentarPedido(ORG_PEDIDOS, "semiannual", "CREDIT_CARD", { cupom: "PCT10", parcelas: 4, total: semJuros })).toContain("billing_parcelamento_total_divergente");
    expect(abertos(ORG_PEDIDOS)).toBe("0");
  });

  it("parcelado até 3x é sem juros: o total é o preço descontado; o anual 12x também respeita o desconto", () => {
    const descontado = SEMESTRAL - descontoEsperado("percentual", 10, SEMESTRAL);
    expect(pedir(ORG_PEDIDOS, "semiannual", "CREDIT_CARD", { cupom: "PCT10", parcelas: 3 }).amount_cents).toBe(descontado);
    cancelarAbertos(ORG_PEDIDOS);
    const anualDescontado = ANUAL - descontoEsperado("percentual", 10, ANUAL);
    expect(pedir(ORG_PEDIDOS, "yearly", "CREDIT_CARD", { cupom: "PCT10", parcelas: 12 }).amount_cents).toBe(
      calcularParcelamento(anualDescontado, 12, PARAMETROS).totalCents,
    );
    cancelarAbertos(ORG_PEDIDOS);
  });

  it("cupom em pacote de tokens é recusado", () => {
    const erro = erroDe(`select public.fn_billing_criar_pedido('${ORG_PEDIDOS}'::uuid, 'pacote_tokens', null, null, 'pacote_teste', 'PIX', 'sandbox', gen_random_uuid(), null, null, 1, null, 'PCT10');`);
    expect(erro).toContain("billing_cupom_nao_vale_para_o_plano");
    expect(abertos(ORG_PEDIDOS)).toBe("0");
  });
});

describe("0955 item 4: as recusas", () => {
  it("código inexistente ou fora do formato é billing_cupom_invalido", () => {
    expect(tentarPedido(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: "NAOEXISTE" })).toContain("billing_cupom_invalido");
    expect(tentarPedido(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: "x" })).toContain("billing_cupom_invalido");
    expect(tentarPedido(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: "a b c" })).toContain("billing_cupom_invalido");
    expect(abertos(ORG_PEDIDOS)).toBe("0");
  });

  it("cupom inativo responde o mesmo que inexistente, e volta a valer quando reativado", () => {
    criarCupom("INATIVO1", "percentual", 10);
    const id = sql(`select id from public.billing_cupons where codigo = 'INATIVO1';`);
    sql(`select public.fn_billing_cupom_definir_ativo('${id}'::uuid, false, null);`);
    expect(tentarPedido(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: "INATIVO1" })).toContain("billing_cupom_invalido");
    sql(`select public.fn_billing_cupom_definir_ativo('${id}'::uuid, true, null);`);
    expect(tentarPedido(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: "INATIVO1" })).toBeNull();
    cancelarAbertos(ORG_PEDIDOS);
  });

  it("cupom expirado", () => {
    criarCupom("EXPIRA1", "percentual", 10, { validoAte: new Date(Date.now() + 86_400_000).toISOString() });
    expect(tentarPedido(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: "EXPIRA1" })).toBeNull();
    cancelarAbertos(ORG_PEDIDOS);
    sql(`update public.billing_cupons set valido_ate = now() - interval '1 minute' where codigo = 'EXPIRA1';`);
    expect(tentarPedido(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: "EXPIRA1" })).toContain("billing_cupom_expirado");
    expect(abertos(ORG_PEDIDOS)).toBe("0");
  });

  it("plano e ciclo permitidos", () => {
    criarCupom("SOMEMAX", "percentual", 10, { planos: ["max"] });
    criarCupom("SOANUAL", "percentual", 10, { ciclos: ["yearly"] });
    expect(tentarPedido(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: "SOMEMAX", plano: "pro" })).toContain("billing_cupom_nao_vale_para_o_plano");
    expect(tentarPedido(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: "SOMEMAX", plano: "max" })).toBeNull();
    cancelarAbertos(ORG_PEDIDOS);
    expect(tentarPedido(ORG_PEDIDOS, "monthly", "CREDIT_CARD", { cupom: "SOANUAL" })).toContain("billing_cupom_nao_vale_para_o_ciclo");
    expect(tentarPedido(ORG_PEDIDOS, "semiannual", "PIX", { cupom: "SOANUAL" })).toContain("billing_cupom_nao_vale_para_o_ciclo");
    expect(tentarPedido(ORG_PEDIDOS, "yearly", "PIX", { cupom: "SOANUAL" })).toBeNull();
    cancelarAbertos(ORG_PEDIDOS);
  });

  it("limite de usos: pedido aberto de outra organização segura a vaga, e solta quando o pedido cai", () => {
    criarCupom("LIMITE1", "percentual", 10, { maxUsos: 1 });
    expect(tentarPedido(ORG_LIMITE_A, "monthly", "CREDIT_CARD", { cupom: "LIMITE1" })).toBeNull();
    expect(tentarPedido(ORG_LIMITE_B, "monthly", "CREDIT_CARD", { cupom: "LIMITE1" })).toContain("billing_cupom_esgotado");
    // A própria organização que segura a vaga não se bloqueia ao tentar de novo (outra chave: retoma o aberto).
    expect(tentarPedido(ORG_LIMITE_A, "monthly", "CREDIT_CARD", { cupom: "LIMITE1" })).toContain("billing_pedido_aberto_existe");
    cancelarAbertos(ORG_LIMITE_A);
    expect(tentarPedido(ORG_LIMITE_B, "monthly", "CREDIT_CARD", { cupom: "LIMITE1" })).toBeNull();
    cancelarAbertos(ORG_LIMITE_B);
  });

  it("a janela de 24 horas conta da CRIAÇÃO: pedido criado há mais de 24 h não segura a vaga, mesmo mexido agora; mexer não renova", () => {
    expect(tentarPedido(ORG_LIMITE_A, "monthly", "CREDIT_CARD", { cupom: "LIMITE1" })).toBeNull();
    // Criado há 25 h, mas atualizado agora (updated_at recente): a vaga já está livre.
    sql(`set session_replication_role = replica;
         update public.billing_orders set created_at = now() - interval '25 hours'
          where organization_id = '${ORG_LIMITE_A}' and status = 'criado';`);
    expect(sql(`select (updated_at > now() - interval '1 hour')::text from public.billing_orders where organization_id = '${ORG_LIMITE_A}' and status = 'criado';`)).toBe("true");
    expect(tentarPedido(ORG_LIMITE_B, "monthly", "CREDIT_CARD", { cupom: "LIMITE1" })).toBeNull();
    cancelarAbertos(ORG_LIMITE_A);
    cancelarAbertos(ORG_LIMITE_B);
  });

  it("pedido pago de outra organização esgota o cupom para sempre (Pix semestral pago)", () => {
    criarCupom("PAGO1", "valor", 5000, { maxUsos: 1 });
    const r = pedir(ORG_PIX_PAGO, "semiannual", "PIX", { cupom: "PAGO1" });
    const pedido = r.pedido_id as string;
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_PIX_PAGO}'::uuid, '${pedido}'::uuid, 'pay_i955_pix', null, null);`);
    const aplicado = registrarEAplicar(
      "evt-i955-pix",
      "PAYMENT_RECEIVED",
      "pay_i955_pix",
      confirmacao("pay_i955_pix", "RECEIVED", reais(SEMESTRAL - 5000), `,'externalReference','HC:ord:${pedido}'`),
    );
    expect(aplicado).toContain('"resultado": "aplicado"');
    expect(colunasDoPedido(pedido, "status")).toBe("pago");
    expect(tentarPedido(ORG_OUTRA, "semiannual", "PIX", { cupom: "PAGO1" })).toContain("billing_cupom_esgotado");
    // E a organização que pagou não usa de novo (o ja_usado vem antes do esgotado).
    expect(tentarPedido(ORG_PIX_PAGO, "semiannual", "PIX", { cupom: "PAGO1" })).toContain("billing_cupom_ja_usado");
    expect(abertos(ORG_OUTRA)).toBe("0");
  });
});

describe("0955 item 5: a chave idempotente e a compra sem cupom", () => {
  const CHAVE = "0955c000-0000-4000-8000-000000000001";
  const CHAVE_SEM = "0955c000-0000-4000-8000-000000000002";

  it("a mesma chave com o mesmo cupom devolve o mesmo pedido, mesmo com o cupom desativado depois", () => {
    const primeiro = pedir(ORG_IDEMPOTENCIA, "semiannual", "PIX", { cupom: "PCT10", chave: CHAVE });
    expect(primeiro.ja_existia).toBe(false);
    const id = sql(`select id from public.billing_cupons where codigo = 'PCT10';`);
    sql(`select public.fn_billing_cupom_definir_ativo('${id}'::uuid, false, null);`);
    const segundo = pedir(ORG_IDEMPOTENCIA, "semiannual", "PIX", { cupom: "pct10", chave: CHAVE });
    sql(`select public.fn_billing_cupom_definir_ativo('${id}'::uuid, true, null);`);
    expect(segundo.ja_existia).toBe(true);
    expect(segundo.pedido_id).toBe(primeiro.pedido_id);
    expect(segundo.amount_cents).toBe(primeiro.amount_cents);
    expect(segundo.desconto_cents).toBe(primeiro.desconto_cents);
  });

  it("a mesma chave com OUTRO cupom, ou sem cupom, é valores diferentes", () => {
    expect(tentarPedido(ORG_IDEMPOTENCIA, "semiannual", "PIX", { cupom: "VALOR50", chave: CHAVE })).toContain("billing_chave_com_valores_diferentes");
    expect(tentarPedido(ORG_IDEMPOTENCIA, "semiannual", "PIX", { chave: CHAVE })).toContain("billing_chave_com_valores_diferentes");
    cancelarAbertos(ORG_IDEMPOTENCIA);
  });

  it("a mesma chave sem cupom, depois COM cupom, também é valores diferentes", () => {
    const primeiro = pedir(ORG_IDEMPOTENCIA, "semiannual", "PIX", { chave: CHAVE_SEM });
    expect(primeiro.amount_cents).toBe(SEMESTRAL);
    expect(tentarPedido(ORG_IDEMPOTENCIA, "semiannual", "PIX", { cupom: "PCT10", chave: CHAVE_SEM })).toContain("billing_chave_com_valores_diferentes");
    cancelarAbertos(ORG_IDEMPOTENCIA);
  });

  it("sem cupom o comportamento é o de antes: preço cheio, sem cupom, desconto zero e preço cheio nulo", () => {
    const r = pedir(ORG_IDEMPOTENCIA, "monthly", "CREDIT_CARD");
    expect(r.amount_cents).toBe(MENSAL);
    expect(r.desconto_cents).toBe(0);
    expect(r.cupom_id).toBeNull();
    expect(colunasDoPedido(r.pedido_id as string, "desconto_cents || '|' || coalesce(preco_cheio_cents::text, 'nulo') || '|' || coalesce(cupom_id::text, 'nulo')")).toBe("0|nulo|nulo");
    cancelarAbertos(ORG_IDEMPOTENCIA);
  });

  it("a chamada antiga, com 12 argumentos, continua funcionando", () => {
    const erro = erroDe(`select public.fn_billing_criar_pedido('${ORG_IDEMPOTENCIA}'::uuid, 'assinatura', 'pro', 'monthly', null, 'CREDIT_CARD', 'sandbox', gen_random_uuid(), null, null, 1, null);`);
    expect(erro).toBeNull();
    expect(sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'fn_billing_criar_pedido';`)).toBe("1");
    cancelarAbertos(ORG_IDEMPOTENCIA);
  });
});

describe("0955 item 6: fn_billing_cupom_simular", () => {
  const simular = (org: string, codigo: string, plano: string, ciclo: string, parcelas = 1) =>
    JSON.parse(sql(`select public.fn_billing_cupom_simular('${org}'::uuid, '${codigo}', '${plano}', '${ciclo}', ${parcelas});`)) as Record<string, unknown>;

  it("à vista: preço cheio, desconto e total", () => {
    const desconto = descontoEsperado("percentual", 10, SEMESTRAL);
    expect(simular(ORG_OUTRA, "pct10", "pro", "semiannual")).toEqual({
      ok: true,
      codigo: "PCT10",
      tipo: "percentual",
      valor: 10,
      preco_cheio_cents: SEMESTRAL,
      desconto_cents: desconto,
      total_cents: SEMESTRAL - desconto,
      parcelas: 1,
      total_final_cents: SEMESTRAL - desconto,
    });
  });

  it("parcelado: o total final tem os juros sobre o preço descontado, igual ao do pedido", () => {
    const descontado = SEMESTRAL - descontoEsperado("percentual", 10, SEMESTRAL);
    const r = simular(ORG_OUTRA, "PCT10", "pro", "semiannual", 4);
    expect(r.total_cents).toBe(descontado);
    expect(r.total_final_cents).toBe(calcularParcelamento(descontado, 4, PARAMETROS).totalCents);
    const pedido = pedir(ORG_OUTRA, "semiannual", "CREDIT_CARD", { cupom: "PCT10", parcelas: 4 });
    expect(pedido.amount_cents).toBe(r.total_final_cents);
    cancelarAbertos(ORG_OUTRA);
  });

  it("devolve o código do erro, sem lançar, e não cria pedido nem consome nada", () => {
    expect(simular(ORG_OUTRA, "NAOEXISTE", "pro", "monthly")).toEqual({ ok: false, erro: "billing_cupom_invalido" });
    expect(simular(ORG_OUTRA, "EXPIRA1", "pro", "monthly")).toEqual({ ok: false, erro: "billing_cupom_expirado" });
    expect(simular(ORG_OUTRA, "SOMEMAX", "pro", "monthly")).toEqual({ ok: false, erro: "billing_cupom_nao_vale_para_o_plano" });
    expect(simular(ORG_OUTRA, "SOANUAL", "pro", "monthly")).toEqual({ ok: false, erro: "billing_cupom_nao_vale_para_o_ciclo" });
    expect(simular(ORG_OUTRA, "PAGO1", "pro", "semiannual")).toEqual({ ok: false, erro: "billing_cupom_esgotado" });
    expect(simular(ORG_PIX_PAGO, "PAGO1", "pro", "semiannual")).toEqual({ ok: false, erro: "billing_cupom_ja_usado" });
    expect(simular(ORG_OUTRA, "PCT10", "pro", "monthly", 2)).toEqual({ ok: false, erro: "billing_parcelamento_indisponivel" });
    expect(simular(ORG_OUTRA, "PCT10", "pro", "semiannual", 7)).toEqual({ ok: false, erro: "billing_parcelas_acima_do_teto" });
    expect(simular(ORG_OUTRA, "PCT10", "pro", "semiannual", 13)).toEqual({ ok: false, erro: "billing_parcelas_invalidas" });
    expect(simular(ORG_OUTRA, "PCT10", "plano_que_nao_existe", "monthly")).toEqual({ ok: false, erro: "plano_nao_encontrado_ou_inativo" });
    expect(simular(ORG_OUTRA, "PCT10", "pro", "semanal")).toEqual({ ok: false, erro: "billing_dados_invalidos" });
    expect(abertos(ORG_OUTRA)).toBe("0");
  });

  it("não trava nem altera o cupom", () => {
    const antes = sql(`select updated_at::text from public.billing_cupons where codigo = 'PCT10';`);
    simular(ORG_OUTRA, "PCT10", "pro", "monthly");
    expect(sql(`select updated_at::text from public.billing_cupons where codigo = 'PCT10';`)).toBe(antes);
  });
});

describe("0955 item 7: conciliação, primeira cobrança com desconto e renovação no preço cheio", () => {
  const SUB = "sub_i955_cartao";
  const descontoDoCupom = descontoEsperado;
  let pedido = "";

  it("a primeira cobrança com o valor descontado é aplicada (não fica divergente) e grava o valor descontado", () => {
    const desconto = descontoDoCupom("percentual", 10, SEMESTRAL);
    const r = pedir(ORG_CARTAO_PAGO, "semiannual", "CREDIT_CARD", { cupom: "PCT10" });
    pedido = r.pedido_id as string;
    sql(`select public.fn_billing_pedido_registrar_cobranca('${ORG_CARTAO_PAGO}'::uuid, '${pedido}'::uuid, 'pay_i955_c1', '${SUB}', null);`);

    // Controle: abaixo do total descontado continua divergente.
    const abaixo = registrarEAplicar(
      "evt-i955-c0",
      "PAYMENT_CONFIRMED",
      "pay_i955_c0",
      confirmacao("pay_i955_c0", "CONFIRMED", reais(SEMESTRAL - desconto - 1), `,'subscription','${SUB}','externalReference','HC:ord:${pedido}'`),
    );
    expect(abaixo).toContain('"resultado": "divergente"');

    const r1 = registrarEAplicar(
      "evt-i955-c1",
      "PAYMENT_CONFIRMED",
      "pay_i955_c1",
      confirmacao("pay_i955_c1", "CONFIRMED", reais(SEMESTRAL - desconto), `,'subscription','${SUB}','externalReference','HC:ord:${pedido}'`),
    );
    expect(r1).toContain('"resultado": "aplicado"');
    expect(r1).not.toContain("divergente_valor");
    expect(colunasDoPedido(pedido, "status")).toBe("pago");
    expect(sql(`select gross_cents from public.billing_payments where asaas_payment_id = 'pay_i955_c1';`)).toBe(String(SEMESTRAL - desconto));
  });

  it("a renovação da mesma assinatura pelo valor DESCONTADO é divergente e não estende o período", () => {
    const desconto = descontoDoCupom("percentual", 10, SEMESTRAL);
    const fimAntes = sql(`select current_period_end from public.billing_contracts where organization_id = '${ORG_CARTAO_PAGO}';`);
    const r = registrarEAplicar(
      "evt-i955-c2",
      "PAYMENT_CONFIRMED",
      "pay_i955_c2",
      confirmacao("pay_i955_c2", "CONFIRMED", reais(SEMESTRAL - desconto), `,'subscription','${SUB}','assinatura_status','ACTIVE'`),
    );
    expect(r).toContain('"resultado": "divergente"');
    expect(r).toContain("renovacao_valor_abaixo_do_ciclo");
    expect(sql(`select current_period_end from public.billing_contracts where organization_id = '${ORG_CARTAO_PAGO}';`)).toBe(fimAntes);
    expect(sql(`select count(*) from public.billing_payments where asaas_payment_id = 'pay_i955_c2';`)).toBe("0");
  });

  it("controle: a renovação pelo preço cheio do ciclo estende o período", () => {
    const r = registrarEAplicar(
      "evt-i955-c3",
      "PAYMENT_CONFIRMED",
      "pay_i955_c3",
      confirmacao("pay_i955_c3", "CONFIRMED", reais(SEMESTRAL), `,'subscription','${SUB}','assinatura_status','ACTIVE'`),
    );
    expect(r).toContain('"resultado": "aplicado"');
  });

  it("a organização que pagou com o cupom não o usa de novo", () => {
    expect(tentarPedido(ORG_CARTAO_PAGO, "semiannual", "PIX", { cupom: "PCT10" })).toContain("billing_cupom_ja_usado");
  });
});

describe("0955 item 8: listagem, ACL e RLS", () => {
  it("listar devolve os cupons com os usos pagos", () => {
    const lista = JSON.parse(sql(`select public.fn_billing_cupom_listar();`)) as Array<Record<string, unknown>>;
    const pct10 = lista.find((c) => c.codigo === "PCT10");
    const pago1 = lista.find((c) => c.codigo === "PAGO1");
    expect(pct10).toMatchObject({ tipo: "percentual", valor: 10, ativo: true, usos_pagos: 1 });
    expect(pago1).toMatchObject({ tipo: "valor", valor: 5000, max_usos: 1, usos_pagos: 1 });
    expect(Array.isArray(pct10?.planos)).toBe(true);
    expect(lista.length).toBeGreaterThanOrEqual(8);
  });

  it("a tabela tem RLS ligada e nenhuma policy", () => {
    expect(sql(`select relrowsecurity::text from pg_class where oid = 'public.billing_cupons'::regclass;`)).toBe("true");
    expect(sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = 'billing_cupons';`)).toBe("0");
  });

  it("anon e authenticated não leem nem escrevem billing_cupons", () => {
    for (const papel of ["anon", "authenticated"]) {
      for (const comando of [
        "select * from public.billing_cupons",
        "select codigo from public.billing_cupons",
        "insert into public.billing_cupons (codigo, tipo, valor) values ('HACK1', 'valor', 100)",
        "update public.billing_cupons set ativo = false",
        "delete from public.billing_cupons",
        "truncate public.billing_cupons",
      ]) {
        const erro = erroDe(`set role ${papel};\n${comando};`);
        expect(erro, `${papel}: ${comando}`).toContain("permission denied");
      }
    }
    expect(sql(`select count(*) from public.billing_cupons where codigo = 'HACK1';`)).toBe("0");
  });

  it("anon e authenticated não leem as colunas novas de billing_orders", () => {
    for (const papel of ["anon", "authenticated"]) {
      expect(erroDe(`set role ${papel};\nselect cupom_id, desconto_cents from public.billing_orders limit 1;`), papel).toContain("permission denied");
    }
  });

  it("anon e authenticated não executam nenhuma função de cupom nem criam pedido", () => {
    const chamadas = [
      `public.fn_billing_cupom_criar('HACK2', 'valor', 100, ${SEM_TEXTO}, ${SEM_TEXTO}, null, null, null, null)`,
      "public.fn_billing_cupom_definir_ativo(gen_random_uuid(), true, null)",
      "public.fn_billing_cupom_listar()",
      `public.fn_billing_cupom_simular('${ORG_OUTRA}'::uuid, 'PCT10', 'pro', 'monthly', 1)`,
      chamadaDoPedido(ORG_OUTRA, "monthly", "CREDIT_CARD", { cupom: "PCT10" }),
      "public.fn_billing_cupom_desconto('valor', 100, 10000)",
      `public.fn_billing_cupom_resolver('${ORG_OUTRA}'::uuid, 'PCT10', 'pro', 'monthly', 10000)`,
    ];
    for (const papel of ["anon", "authenticated"]) {
      for (const chamada of chamadas) {
        expect(erroDe(`set role ${papel};\nselect ${chamada};`), `${papel}: ${chamada}`).toContain("permission denied");
      }
    }
    expect(sql(`select count(*) from public.billing_cupons where codigo = 'HACK2';`)).toBe("0");
  });

  it("service_role só lê a tabela, executa as funções de borda e não executa as internas", () => {
    expect(erroDe(`set role service_role;\nselect count(*) from public.billing_cupons;`)).toBeNull();
    for (const comando of [
      "insert into public.billing_cupons (codigo, tipo, valor) values ('HACK3', 'valor', 100)",
      "update public.billing_cupons set ativo = false",
      "delete from public.billing_cupons",
    ]) {
      expect(erroDe(`set role service_role;\n${comando};`), comando).toContain("permission denied");
    }
    expect(erroDe(`set role service_role;\nselect public.fn_billing_cupom_listar();`)).toBeNull();
    expect(erroDe(`set role service_role;\nselect public.fn_billing_cupom_simular('${ORG_OUTRA}'::uuid, 'PCT10', 'pro', 'monthly', 1);`)).toBeNull();
    for (const interna of [
      "public.fn_billing_cupom_desconto('valor', 100, 10000)",
      `public.fn_billing_cupom_resolver('${ORG_OUTRA}'::uuid, 'PCT10', 'pro', 'monthly', 10000)`,
    ]) {
      expect(erroDe(`set role service_role;\nselect ${interna};`), interna).toContain("permission denied");
    }
  });

  it("nenhuma função de cupom é executável por anon ou authenticated (varredura no catálogo)", () => {
    const expostas = sql(`
      select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and (p.proname like 'fn_billing_cupom_%' or p.proname = 'fn_billing_criar_pedido')
         and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
    `);
    expect(expostas).toBe("0");
  });
});

describe("0955: valor fixo limitado a 99% do preço", () => {
  it("o valor fixo gigante tira no máximo 99%: no semestral o total é 1% do preço, acima do piso de 500", () => {
    const r = pedir(ORG_PEDIDOS, "semiannual", "PIX", { cupom: "GIGANTE" });
    const desconto = descontoEsperado("valor", 99999999, SEMESTRAL);
    expect(desconto).toBe(Math.floor((SEMESTRAL * 99 + 50) / 100));
    expect(r.desconto_cents).toBe(desconto);
    expect(r.amount_cents).toBe(SEMESTRAL - desconto);
    cancelarAbertos(ORG_PEDIDOS);
  });
});

describe("0955: parcela mínima de R$ 5,00 com cupom", () => {
  it("no pedido: 2x passa e 3x (e 4x, com juros) é recusado com o erro próprio, sem pedido criado", () => {
    // Total descontado de 1% do semestral (1049): 2x = 524 por parcela, 3x = 349.
    expect(tentarPedido(ORG_PARCELAS, "semiannual", "CREDIT_CARD", { cupom: "GIGANTE", parcelas: 2 })).toBeNull();
    cancelarAbertos(ORG_PARCELAS);
    expect(tentarPedido(ORG_PARCELAS, "semiannual", "CREDIT_CARD", { cupom: "GIGANTE", parcelas: 3 })).toContain("billing_cupom_parcela_minima");
    expect(tentarPedido(ORG_PARCELAS, "semiannual", "CREDIT_CARD", { cupom: "GIGANTE", parcelas: 4 })).toContain("billing_cupom_parcela_minima");
    expect(abertos(ORG_PARCELAS)).toBe("0");
  });

  it("na simulação: o mesmo erro, para a tela avisar", () => {
    const sim = (parcelas: number) =>
      JSON.parse(sql(`select public.fn_billing_cupom_simular('${ORG_PARCELAS}'::uuid, 'GIGANTE', 'pro', 'semiannual', ${parcelas});`)) as Record<string, unknown>;
    expect(sim(2)).toMatchObject({ ok: true, parcelas: 2 });
    expect(sim(3)).toEqual({ ok: false, erro: "billing_cupom_parcela_minima" });
    expect(sim(6)).toEqual({ ok: false, erro: "billing_cupom_parcela_minima" });
  });

  it("um desconto normal parcela no máximo sem tropeçar na regra", () => {
    expect(tentarPedido(ORG_PARCELAS, "yearly", "CREDIT_CARD", { cupom: "PCT10", parcelas: 12 })).toBeNull();
    cancelarAbertos(ORG_PARCELAS);
  });
});

describe("0955: o mesmo pagador usa o cupom uma vez, em qualquer organização", () => {
  const pagar = (org: string, pedido: string, pagamento: string, evento: string, cents: number) => {
    sql(`select public.fn_billing_pedido_registrar_cobranca('${org}'::uuid, '${pedido}'::uuid, '${pagamento}', null, null);`);
    return registrarEAplicar(evento, "PAYMENT_RECEIVED", pagamento, confirmacao(pagamento, "RECEIVED", reais(cents), `,'externalReference','HC:ord:${pedido}'`));
  };

  it("setup: uma organização paga com o cupom e a impressão A", () => {
    criarCupom("UMPAGADOR", "percentual", 10);
    const r = pedir(ORG_PAGADOR_X, "semiannual", "PIX", { cupom: "UMPAGADOR", impressao: IMPRESSAO_A });
    expect(sql(`select pagador_impressao from public.billing_orders where id = '${r.pedido_id as string}';`)).toBe(IMPRESSAO_A);
    const aplicado = pagar(ORG_PAGADOR_X, r.pedido_id as string, "pay_i955_pagx", "evt-i955-pagx", r.amount_cents as number);
    expect(aplicado).toContain('"resultado": "aplicado"');
  });

  it("outra organização com a MESMA impressão é recusada como já usado; com outra impressão passa", () => {
    expect(tentarPedido(ORG_PAGADOR_Y, "semiannual", "PIX", { cupom: "UMPAGADOR", impressao: IMPRESSAO_A })).toContain("billing_cupom_ja_usado");
    expect(abertos(ORG_PAGADOR_Y)).toBe("0");
    expect(tentarPedido(ORG_PAGADOR_Y, "semiannual", "PIX", { cupom: "UMPAGADOR", impressao: IMPRESSAO_B })).toBeNull();
    cancelarAbertos(ORG_PAGADOR_Y);
  });

  it("sem impressão e sem histórico a regra do pagador não se aplica (só a da organização)", () => {
    expect(tentarPedido(ORG_PAGADOR_Y, "semiannual", "PIX", { cupom: "UMPAGADOR" })).toBeNull();
    cancelarAbertos(ORG_PAGADOR_Y);
  });

  it("sem impressão, vale a da última compra com cupom da própria organização", () => {
    // A organização Y teve um pedido com cupom e a impressão A (para outro cupom); agora pede UMPAGADOR sem mandar impressão.
    criarCupom("OUTROCUPOM", "percentual", 5);
    expect(tentarPedido(ORG_PAGADOR_Y, "monthly", "CREDIT_CARD", { cupom: "OUTROCUPOM", impressao: IMPRESSAO_A })).toBeNull();
    cancelarAbertos(ORG_PAGADOR_Y);
    expect(tentarPedido(ORG_PAGADOR_Y, "semiannual", "PIX", { cupom: "UMPAGADOR" })).toContain("billing_cupom_ja_usado");
  });

  it("impressão fora do formato é recusada, e a impressão só é gravada em pedido com cupom", () => {
    expect(tentarPedido(ORG_PAGADOR_Y, "monthly", "CREDIT_CARD", { cupom: "OUTROCUPOM", impressao: "12345678901" })).toContain("billing_pagador_impressao_invalida");
    const semCupom = pedir(ORG_OUTRA, "monthly", "CREDIT_CARD", { impressao: IMPRESSAO_B });
    expect(sql(`select coalesce(pagador_impressao, 'nulo') from public.billing_orders where id = '${semCupom.pedido_id as string}';`)).toBe("nulo");
    cancelarAbertos(ORG_OUTRA);
    // O banco também recusa impressão em pedido sem cupom.
    expect(
      erroDe(`update public.billing_orders set pagador_impressao = '${IMPRESSAO_A}' where id = '${semCupom.pedido_id as string}';`),
    ).toContain("billing_orders_pagador_impressao_formato");
  });

  it("a repetição da mesma chave não revalida o pagador", () => {
    const chave = "0955c000-0000-4000-8000-0000000000aa";
    const primeiro = pedir(ORG_PAGADOR_Y, "semiannual", "PIX", { cupom: "UMPAGADOR", impressao: IMPRESSAO_B, chave });
    const segundo = pedir(ORG_PAGADOR_Y, "semiannual", "PIX", { cupom: "UMPAGADOR", impressao: IMPRESSAO_A, chave });
    expect(segundo.ja_existia).toBe(true);
    expect(segundo.pedido_id).toBe(primeiro.pedido_id);
    cancelarAbertos(ORG_PAGADOR_Y);
  });
});

describe("0955: a listagem vem do mais novo para o mais antigo", () => {
  it("a ordem de fn_billing_cupom_listar é a de created_at decrescente", () => {
    const lista = JSON.parse(sql(`select public.fn_billing_cupom_listar();`)) as Array<{ codigo: string }>;
    const esperado = sql(`select codigo::text from public.billing_cupons order by created_at desc, id;`).split("\n");
    expect(lista.map((c) => c.codigo)).toEqual(esperado);
    expect(lista.length).toBeGreaterThan(5);
    // O primeiro criado neste arquivo (PCT10) é o último da lista.
    expect(lista[lista.length - 1]?.codigo).toBe("PCT10");
  });
});
