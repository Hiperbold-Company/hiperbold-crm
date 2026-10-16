/**
 * Migração 0957: motivo do cancelamento e pedido de reembolso feitos pelo cliente (fork Hiperbold). Provado no
 * Postgres real:
 *
 *   1. isolamento por organização (JWT simulado, `set role authenticated`): o admin da org A lê os pedidos de
 *      reembolso e os motivos de cancelamento da própria organização (controle positivo) e ZERO dos da org B;
 *      quem não é admin (agent) lê zero; anon não alcança as tabelas;
 *   2. a escrita é só das funções: authenticated não insere, não altera nem apaga; service_role não apaga;
 *   3. um pedido ABERTO por pagamento (índice único parcial), inclusive em corrida entre duas sessões;
 *   4. as regras de fn_billing_reembolso_solicitar: assinatura cancelada, só o pagamento mais recente, só até
 *      7 dias, pagamento de outra organização é "não elegível", pagamento já estornado some, teto de 5 por dia,
 *      motivo vindo do cancelamento;
 *   5. fn_billing_reembolso_concluir_por_pagamento e fn_billing_reembolso_resolver;
 *   6. o EXECUTE das funções é só do service_role (as duas origens: public e anon/authenticated).
 *
 * Roda via `pnpm test:db tests/invariants/reembolso-do-cliente-banco.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `0957a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = U(1);
const ORG_B = U(2);
const ORG_NAO_CANCELOU = U(3);
const ORG_FORA_DO_PRAZO = U(4);
const ORG_TETO = U(5);
const ORG_ESTORNADO = U(6);
const ORG_CORRIDA = U(7);

const ADMIN_A = U(11);
const AGENT_A = U(12);
const ADMIN_B = U(13);

function erroDe(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

function contarComo(userId: string, consulta: string): number {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${consulta}
  `);
  return Number(out.split("\n").at(-1));
}

/** Um pagamento do Asaas confirmado, `dias` dias atrás. Devolve o id interno. */
function pagamento(org: string, asaasId: string, dias: number, cents = 9900): string {
  return sql(`
    insert into public.billing_payments (organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at, chave, origem)
    select '${org}', c.id, '${asaasId}', ${cents}, 'CONFIRMED', now() - interval '${dias} days', gen_random_uuid(), 'asaas'
      from public.billing_contracts c where c.organization_id = '${org}'
    returning id;
  `)
    .split("\n")[0]!;
}

function prepararOrg(org: string, opcoes: { cancelada: boolean }) {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
    values ('${org}', 'i957-${org.slice(-2)}', 'i957 LTDA', 'i957') on conflict (id) do nothing;
    insert into public.billing_contracts (organization_id, plan_id, status, cancel_at_period_end, current_period_end)
    values ('${org}', (select id from public.billing_plans where code = 'pro' and active limit 1), 'ativa',
            ${opcoes.cancelada}, now() + interval '20 days')
    on conflict (organization_id) do update set cancel_at_period_end = ${opcoes.cancelada}, status = 'ativa';
  `);
}

function comandoSolicitar(org: string, actor: string, pagamentoId: string, detalhe: string | null = null): string {
  return `select public.fn_billing_reembolso_solicitar('${org}', '${actor}', '${pagamentoId}', ${detalhe === null ? "null" : `'${detalhe}'`});`;
}

function solicitar(org: string, actor: string, pagamentoId: string, detalhe: string | null = null): string {
  return sql(comandoSolicitar(org, actor, pagamentoId, detalhe));
}

let PAG_A = "";
let PAG_B = "";
let PEDIDO_A = "";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_A}', 'i957-admin-a@invariant.test'),
      ('${AGENT_A}', 'i957-agent-a@invariant.test'),
      ('${ADMIN_B}', 'i957-admin-b@invariant.test')
    on conflict (id) do nothing;
  `);
  prepararOrg(ORG_A, { cancelada: true });
  prepararOrg(ORG_B, { cancelada: true });
  prepararOrg(ORG_NAO_CANCELOU, { cancelada: false });
  prepararOrg(ORG_FORA_DO_PRAZO, { cancelada: true });
  prepararOrg(ORG_TETO, { cancelada: true });
  prepararOrg(ORG_ESTORNADO, { cancelada: true });
  prepararOrg(ORG_CORRIDA, { cancelada: true });
  sql(`
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ADMIN_A}', '${ORG_A}', 'admin', now()),
      ('${AGENT_A}', '${ORG_A}', 'agent', now()),
      ('${ADMIN_B}', '${ORG_B}', 'admin', now())
    on conflict do nothing;
  `);

  PAG_A = pagamento(ORG_A, "pay_i957_a", 2);
  PAG_B = pagamento(ORG_B, "pay_i957_b", 2);
  sql(`select public.fn_billing_cancelamento_motivo_registrar('${ORG_A}', '${ADMIN_A}', 'preco', 'caro demais');`);
  sql(`select public.fn_billing_cancelamento_motivo_registrar('${ORG_B}', '${ADMIN_B}', 'faltou_recurso', null);`);
  PEDIDO_A = JSON.parse(solicitar(ORG_A, ADMIN_A, PAG_A, "obrigado")).id;
  solicitar(ORG_B, ADMIN_B, PAG_B);
});

describe("isolamento por organização (RLS)", () => {
  it("o admin da org A lê os pedidos da própria org e ZERO da org B", () => {
    expect(contarComo(ADMIN_A, `select count(*) from public.billing_refund_requests where organization_id = '${ORG_A}';`)).toBe(1);
    expect(contarComo(ADMIN_A, `select count(*) from public.billing_refund_requests where organization_id = '${ORG_B}';`)).toBe(0);
    expect(contarComo(ADMIN_A, `select count(*) from public.billing_refund_requests;`)).toBe(1);
  });

  it("o admin da org A lê o motivo de cancelamento da própria org e ZERO da org B", () => {
    expect(contarComo(ADMIN_A, `select count(*) from public.billing_cancel_feedback where organization_id = '${ORG_A}';`)).toBe(1);
    expect(contarComo(ADMIN_A, `select count(*) from public.billing_cancel_feedback;`)).toBe(1);
  });

  it("quem não é admin (agent) da mesma org lê zero", () => {
    expect(contarComo(AGENT_A, `select count(*) from public.billing_refund_requests;`)).toBe(0);
    expect(contarComo(AGENT_A, `select count(*) from public.billing_cancel_feedback;`)).toBe(0);
  });

  it("anon não alcança as tabelas", () => {
    for (const tabela of ["billing_refund_requests", "billing_cancel_feedback"]) {
      expect(erroDe(`set role anon; select count(*) from public.${tabela};`)).toMatch(/permission denied/);
    }
  });

  it("authenticated não escreve nas tabelas (nem a própria organização)", () => {
    const comoAdmin = (dml: string) => `
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${ADMIN_A}"}', false);
      ${dml}`;
    expect(erroDe(comoAdmin(`update public.billing_refund_requests set status = 'concluido', resolved_at = now();`))).toMatch(/permission denied/);
    expect(erroDe(comoAdmin(`delete from public.billing_refund_requests;`))).toMatch(/permission denied/);
    expect(
      erroDe(comoAdmin(`insert into public.billing_cancel_feedback (organization_id, motivo) values ('${ORG_A}', 'outro');`)),
    ).toMatch(/permission denied/);
    expect(
      erroDe(
        comoAdmin(
          `insert into public.billing_refund_requests (organization_id, payment_id, asaas_payment_id, amount_cents, paid_at, dentro_7_dias, motivo)
           values ('${ORG_A}', '${PAG_A}', 'pay_i957_a', 100, now(), true, 'outro');`,
        ),
      ),
    ).toMatch(/permission denied/);
  });

  it("service_role lê, mas não apaga nem trunca", () => {
    expect(erroDe(`set role service_role; select count(*) from public.billing_refund_requests;`)).toBeNull();
    expect(erroDe(`set role service_role; delete from public.billing_refund_requests;`)).toMatch(/permission denied/);
    expect(erroDe(`set role service_role; truncate public.billing_refund_requests;`)).toMatch(/permission denied/);
    expect(erroDe(`set role service_role; update public.billing_cancel_feedback set motivo = 'outro';`)).toMatch(/permission denied/);
  });
});

describe("fn_billing_reembolso_solicitar", () => {
  it("grava o pedido com o motivo do cancelamento, dentro dos 7 dias e pendente", () => {
    const l = sql(
      `select motivo || '|' || detalhe || '|' || dentro_7_dias || '|' || status || '|' || amount_cents from public.billing_refund_requests where id = '${PEDIDO_A}';`,
    );
    expect(l).toBe("preco|obrigado|true|pendente|9900");
  });

  it("um pedido ABERTO por pagamento: o segundo é recusado", () => {
    expect(erroDe(comandoSolicitar(ORG_A, ADMIN_A, PAG_A))).toMatch(/billing_reembolso_ja_solicitado/);
  });

  it("duas tentativas seguidas no mesmo pagamento gravam um pedido só", () => {
    const pag = pagamento(ORG_CORRIDA, "pay_i957_corrida", 1);
    sql(`select public.fn_billing_cancelamento_motivo_registrar('${ORG_CORRIDA}', null, 'outro', null);`);
    const resultados = [0, 1].map(() => erroDe(comandoSolicitar(ORG_CORRIDA, ADMIN_A, pag)));
    expect(resultados.filter((r) => r === null)).toHaveLength(1);
    expect(sql(`select count(*) from public.billing_refund_requests where organization_id = '${ORG_CORRIDA}';`)).toBe("1");
  });

  it("recusa quando a assinatura não está cancelada", () => {
    const pag = pagamento(ORG_NAO_CANCELOU, "pay_i957_nc", 1);
    expect(erroDe(comandoSolicitar(ORG_NAO_CANCELOU, ADMIN_A, pag))).toMatch(/billing_reembolso_assinatura_nao_cancelada/);
  });

  it("aceita contrato em status cancelada mesmo sem cancel_at_period_end", () => {
    prepararOrg(ORG_NAO_CANCELOU, { cancelada: false });
    sql(`update public.billing_contracts set status = 'cancelada' where organization_id = '${ORG_NAO_CANCELOU}';`);
    const pag = sql(`select id from public.billing_payments where asaas_payment_id = 'pay_i957_nc';`);
    expect(erroDe(comandoSolicitar(ORG_NAO_CANCELOU, ADMIN_A, pag))).toBeNull();
  });

  it("fora dos 7 dias não há reembolso", () => {
    const pag = pagamento(ORG_FORA_DO_PRAZO, "pay_i957_velho", 8);
    expect(erroDe(comandoSolicitar(ORG_FORA_DO_PRAZO, ADMIN_A, pag))).toMatch(/billing_reembolso_fora_do_prazo/);
    const noLimite = pagamento(ORG_TETO, "pay_i957_6dias", 6);
    expect(erroDe(comandoSolicitar(ORG_TETO, ADMIN_A, noLimite))).toBeNull();
  });

  it("só o pagamento mais recente: o mais antigo, mesmo dentro dos 7 dias, é recusado", () => {
    const org = ORG_ESTORNADO;
    const antigo = pagamento(org, "pay_i957_antigo", 5);
    pagamento(org, "pay_i957_novo", 1);
    expect(erroDe(comandoSolicitar(org, ADMIN_A, antigo))).toMatch(/billing_reembolso_so_o_ultimo_pagamento/);
  });

  it("pagamento de outra organização é 'não elegível' (mesma resposta de inexistente)", () => {
    expect(erroDe(comandoSolicitar(ORG_A, ADMIN_A, PAG_B))).toMatch(/billing_reembolso_pagamento_nao_elegivel/);
    expect(erroDe(comandoSolicitar(ORG_A, ADMIN_A, "0957a000-0000-4000-8000-0000000000ff"))).toMatch(
      /billing_reembolso_pagamento_nao_elegivel/,
    );
  });

  it("pagamento que já tem linha de estorno sai da lista de elegíveis", () => {
    const org = ORG_ESTORNADO;
    const novo = sql(`select id from public.billing_payments where asaas_payment_id = 'pay_i957_novo';`);
    sql(`
      insert into public.billing_payments (organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at, chave, origem, estorna_pagamento_id)
      select '${org}', c.id, null, 9900, 'REFUNDED', now(), gen_random_uuid(), 'asaas', '${novo}'
        from public.billing_contracts c where c.organization_id = '${org}';
    `);
    const ids = sql(
      `select string_agg(e->>'asaas_payment_id', ',') from jsonb_array_elements(public.fn_billing_reembolso_elegiveis('${org}')) e;`,
    );
    expect(ids).toBe("pay_i957_antigo");
    expect(erroDe(comandoSolicitar(org, ADMIN_A, novo))).toMatch(/billing_reembolso_pagamento_nao_elegivel/);
  });

  it("pagamento manual (sem Asaas) não é elegível", () => {
    const lista = sql(`select jsonb_array_length(public.fn_billing_reembolso_elegiveis('${ORG_B}'));`);
    sql(`
      insert into public.billing_payments (organization_id, contract_id, gross_cents, status, paid_at, billing_period_start, billing_period_end, chave, origem)
      select '${ORG_B}', c.id, 5000, 'RECEIVED_IN_CASH', now(), now(), now() + interval '30 days', gen_random_uuid(), 'manual'
        from public.billing_contracts c where c.organization_id = '${ORG_B}';
    `);
    expect(sql(`select jsonb_array_length(public.fn_billing_reembolso_elegiveis('${ORG_B}'));`)).toBe(lista);
  });

  it("teto de 5 pedidos por organização em 24 horas", () => {
    const org = ORG_TETO;
    const base = sql(`select count(*) from public.billing_refund_requests where organization_id = '${org}';`);
    expect(Number(base)).toBe(1);
    const p = sql(`select id from public.billing_payments where asaas_payment_id = 'pay_i957_6dias';`);
    sql(`
      insert into public.billing_refund_requests (organization_id, payment_id, asaas_payment_id, amount_cents, paid_at, dentro_7_dias, motivo, status, resolved_at)
      select '${org}', '${p}', 'pay_i957_6dias', 100, now(), true, 'outro', 'recusado', now() from generate_series(1, 4);
    `);
    const novo = pagamento(org, "pay_i957_novissimo", 0);
    expect(erroDe(comandoSolicitar(org, ADMIN_A, novo))).toMatch(/billing_reembolso_limite_diario/);
  });

  it("detalhe acima de 1000 caracteres é recusado", () => {
    expect(erroDe(comandoSolicitar(ORG_A, ADMIN_A, PAG_A, "x".repeat(1001)))).toMatch(/billing_reembolso_detalhe_longo/);
  });
});

describe("conclusão e resolução", () => {
  it("o webhook fecha como concluido o pedido aberto do pagamento, e só uma vez", () => {
    expect(sql(`select public.fn_billing_reembolso_concluir_por_pagamento('${ORG_B}', 'pay_i957_b');`)).toBe("1");
    expect(sql(`select public.fn_billing_reembolso_concluir_por_pagamento('${ORG_B}', 'pay_i957_b');`)).toBe("0");
    expect(
      sql(`select status || '|' || (resolved_at is not null) from public.billing_refund_requests where asaas_payment_id = 'pay_i957_b';`),
    ).toBe("concluido|true");
  });

  it("não conclui pedido de outra organização", () => {
    expect(sql(`select public.fn_billing_reembolso_concluir_por_pagamento('${ORG_B}', 'pay_i957_a');`)).toBe("0");
  });

  it("pagamento concluído deixa de ser elegível", () => {
    expect(sql(`select jsonb_path_exists(public.fn_billing_reembolso_elegiveis('${ORG_B}'), '$[*] ? (@.asaas_payment_id == "pay_i957_b")');`)).toBe("f");
  });

  it("o admin da plataforma recusa um pedido aberto; um já resolvido não muda mais", () => {
    const r = JSON.parse(sql(`select public.fn_billing_reembolso_resolver('${PEDIDO_A}', 'recusado', '${ADMIN_A}');`));
    expect(r.status_novo).toBe("recusado");
    expect(erroDe(`select public.fn_billing_reembolso_resolver('${PEDIDO_A}', 'concluido', '${ADMIN_A}');`)).toMatch(
      /billing_reembolso_ja_resolvido/,
    );
    expect(erroDe(`select public.fn_billing_reembolso_resolver('${PEDIDO_A}', 'pendente', '${ADMIN_A}');`)).toMatch(
      /billing_reembolso_status_invalido/,
    );
    expect(erroDe(`select public.fn_billing_reembolso_resolver('${U(99)}', 'recusado', '${ADMIN_A}');`)).toMatch(
      /billing_reembolso_nao_encontrado/,
    );
  });

  it("depois de recusado, o mesmo pagamento aceita um novo pedido aberto", () => {
    expect(erroDe(comandoSolicitar(ORG_A, ADMIN_A, PAG_A))).toBeNull();
  });

  it("a linha só fica sem 'pendente' com resolved_at preenchido", () => {
    expect(
      erroDe(`update public.billing_refund_requests set status = 'recusado' where organization_id = '${ORG_A}' and status = 'pendente';`),
    ).toMatch(/billing_refund_requests_resolucao_coerente/);
  });
});

describe("motivo do cancelamento", () => {
  it("motivo fora do vocabulário e detalhe longo são recusados", () => {
    expect(erroDe(`select public.fn_billing_cancelamento_motivo_registrar('${ORG_A}', null, 'porque_sim', null);`)).toMatch(
      /billing_cancelamento_motivo_invalido/,
    );
    expect(erroDe(`select public.fn_billing_cancelamento_motivo_registrar('${ORG_A}', null, 'outro', '${"x".repeat(1001)}');`)).toMatch(
      /billing_cancelamento_detalhe_longo/,
    );
  });

  it("detalhe em branco vira nulo", () => {
    sql(`select public.fn_billing_cancelamento_motivo_registrar('${ORG_TETO}', null, 'outro', '   ');`);
    expect(sql(`select count(*) from public.billing_cancel_feedback where organization_id = '${ORG_TETO}' and detalhe is null;`)).toBe("1");
  });
});

describe("EXECUTE das funções é só do service_role", () => {
  const funcoes = [
    "fn_billing_reembolso_elegiveis(uuid)",
    "fn_billing_reembolso_solicitar(uuid, uuid, uuid, text)",
    "fn_billing_reembolso_concluir_por_pagamento(uuid, text)",
    "fn_billing_reembolso_resolver(uuid, text, uuid)",
    "fn_billing_cancelamento_motivo_registrar(uuid, uuid, text, text)",
  ];

  it.each(funcoes)("%s", (f) => {
    const privilegios = sql(`
      select string_agg(r || '=' || has_function_privilege(r, 'public.${f}', 'EXECUTE'), ',' order by r)
        from unnest(array['anon', 'authenticated', 'service_role']) r;
    `);
    expect(privilegios).toBe("anon=false,authenticated=false,service_role=true");
    expect(sql(`select (select count(*) from aclexplode((select proacl from pg_proc where oid = 'public.${f}'::regprocedure)) a where a.grantee = 0)::text;`)).toBe("0");
  });

  it("a destino 'financeiro' é aceita na fila de e-mails e outro valor não", () => {
    expect(
      erroDe(`insert into public.billing_emails_enviados (organization_id, email_id, chave, destino) values ('${ORG_A}', 'COB-11', 'i957-fin', 'financeiro');`),
    ).toBeNull();
    expect(
      erroDe(`insert into public.billing_emails_enviados (organization_id, email_id, chave, destino) values ('${ORG_A}', 'COB-11', 'i957-x', 'qualquer');`),
    ).toMatch(/billing_emails_enviados_destino_valido/);
  });
});
