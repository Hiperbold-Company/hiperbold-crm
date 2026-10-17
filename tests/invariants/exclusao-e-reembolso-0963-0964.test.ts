/**
 * Migrações 0963 e 0964 (fork Hiperbold), provadas no Postgres real:
 *
 *   0963  a garantia de 7 dias do reembolso conta por DIA CIVIL de São Paulo: pago às 00:30 do 8º dia atrás ainda
 *         vale (7 dias e quase 24 h), pago às 23:59 do dia anterior a isso não. A versão antiga (168 horas) errava
 *         nos dois sentidos.
 *   0964  a exclusão dos dados: (a) programação automática vencida SEM o aviso de 7 dias não fica presa: o banco
 *         empurra `excluir_em` para daqui a 7 dias e zera os marcadores; a que já foi avisada não é tocada;
 *         (b) `fn_exclusao_iniciar` reconfere a guarda com o contrato travado e marca `executando`; depois disso o
 *         contrato NÃO sai de cancelada/suspensa (trigger), a programação não se cancela nem se reprograma, e a
 *         execução termina normalmente; (c) antes da marca, a reativação passa e a guarda recusa; (d) o ACL das
 *         funções novas é só do service_role.
 *
 * Roda via `pnpm test:db tests/invariants/exclusao-e-reembolso-0963-0964.test.ts`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `0963a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_REEMB = U(1);
const ORG_SEM_AVISO = U(2);
const ORG_AVISADA = U(3);
const ORG_PRONTA = U(4);
const ORG_NO_PRAZO = U(5);
const ORG_REATIVADA = U(6);
const ORG_EXECUTANDO = U(7);
const ADMIN = U(11);

function erroDe(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

function um(consulta: string): string {
  return sql(consulta).split("\n").at(-1) ?? "";
}

function criarOrg(org: string, nome: string) {
  sql(`insert into public.organizations (id, slug, legal_name, display_name)
       values ('${org}', 'i963-${org.slice(-2)}', '${nome} LTDA', '${nome}') on conflict (id) do nothing;`);
}

function contratoCancelado(org: string, dias: number) {
  sql(`
    update public.billing_contracts
       set plan_id = (select id from public.billing_plans where code = 'pro' and active limit 1),
           status = 'cancelada', cycle = 'monthly', current_period_end = now() - interval '40 days'
     where organization_id = '${org}';
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, criado_em)
    select '${org}', id, 'conferidor', 'ativa', 'cancelada', 'conferidor', now() - interval '${dias} days'
      from public.billing_contracts where organization_id = '${org}';
  `);
}

function pagamentoDoAsaas(org: string, asaasId: string) {
  sql(`
    with pedido as (
      insert into public.billing_orders (organization_id, ambiente, tipo, plan_id, ciclo, metodo, amount_cents, status, chave, pago_em)
      values ('${org}', 'producao', 'assinatura', (select id from public.billing_plans where code = 'pro' and active limit 1),
              'monthly', 'PIX', 9900, 'pago', gen_random_uuid(), now() - interval '130 days')
      returning id
    )
    insert into public.billing_payments (organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at, chave, origem, order_id)
    select '${org}', c.id, '${asaasId}', 9900, 'CONFIRMED', now() - interval '130 days', gen_random_uuid(), 'asaas', (select id from pedido)
      from public.billing_contracts c where c.organization_id = '${org}';
  `);
}

const estado = (org: string) =>
  um(`select coalesce((select estado from public.org_exclusoes_programadas where organization_id = '${org}'), 'SEM');`);
const guarda = (org: string) => um(`select public.fn_exclusao_pode_executar('${org}', false);`);

beforeAll(() => {
  sql(`insert into auth.users (id, email) values ('${ADMIN}', 'i963-admin@invariant.test') on conflict (id) do nothing;`);
  for (const [org, nome] of [
    [ORG_REEMB, "Reemb"], [ORG_SEM_AVISO, "SemAviso"], [ORG_AVISADA, "Avisada"], [ORG_PRONTA, "Pronta"],
    [ORG_NO_PRAZO, "NoPrazo"], [ORG_REATIVADA, "Reativada"], [ORG_EXECUTANDO, "Executando"],
  ] as const) criarOrg(org, nome);

  for (const org of [ORG_SEM_AVISO, ORG_AVISADA, ORG_PRONTA, ORG_NO_PRAZO, ORG_REATIVADA, ORG_EXECUTANDO]) {
    contratoCancelado(org, 50);
    pagamentoDoAsaas(org, `pay_i963_${org.slice(-2)}`);
  }
  sql(`select public.fn_exclusao_sincronizar(90);`);
  // Venceram ontem (a data de hoje exigiria esperar): SemAviso nunca foi avisada; Avisada e Pronta já foram.
  sql(`
    update public.org_exclusoes_programadas set excluir_em = now() - interval '1 hour', aviso_30_dias_em = null, aviso_7_dias_em = null
     where organization_id = '${ORG_SEM_AVISO}';
    update public.org_exclusoes_programadas set excluir_em = now() - interval '1 hour', aviso_30_dias_em = now() - interval '25 days', aviso_7_dias_em = now() - interval '8 days'
     where organization_id in ('${ORG_AVISADA}', '${ORG_PRONTA}', '${ORG_REATIVADA}', '${ORG_EXECUTANDO}');
    update public.org_exclusoes_programadas set aviso_30_dias_em = now() - interval '2 days'
     where organization_id = '${ORG_NO_PRAZO}';
  `);
});

describe("0963. a garantia de 7 dias é por dia civil de São Paulo", () => {
  function reembolsar(paidAtSql: string): string | null {
    sql(`
      update public.billing_contracts set status = 'ativa', cancel_at_period_end = true, current_period_end = now() + interval '20 days'
       where organization_id = '${ORG_REEMB}';
      delete from public.billing_refund_requests where organization_id = '${ORG_REEMB}';
      delete from public.billing_payments where organization_id = '${ORG_REEMB}';
    `);
    const pagamento = sql(`
      insert into public.billing_payments (organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at, chave, origem)
      select '${ORG_REEMB}', c.id, 'pay_i963_r' || substr(gen_random_uuid()::text, 1, 6), 9900, 'CONFIRMED', ${paidAtSql}, gen_random_uuid(), 'asaas'
        from public.billing_contracts c where c.organization_id = '${ORG_REEMB}'
      returning id;
    `).split("\n")[0]!;
    return erroDe(`select public.fn_billing_reembolso_solicitar('${ORG_REEMB}', '${ADMIN}', '${pagamento}', null);`);
  }

  // O 8º dia atrás às 00:30 de SP: 7 dias CIVIS (e 7 dias + 8 a 9 horas de relógio, que a regra de 168 h recusava).
  const hojeSP = `(now() at time zone 'America/Sao_Paulo')::date`;

  it("pago no começo do dia, sete dias civis atrás, vale mesmo com mais de 168 horas", () => {
    expect(reembolsar(`((${hojeSP} - 7) + time '00:30') at time zone 'America/Sao_Paulo'`)).toBeNull();
  });

  it("pago no fim do dia anterior a isso (8 dias civis) está fora, mesmo com menos de 168 horas + 24", () => {
    expect(reembolsar(`((${hojeSP} - 8) + time '23:59') at time zone 'America/Sao_Paulo'`)).toMatch(/billing_reembolso_fora_do_prazo/);
  });

  it("pago hoje vale", () => {
    expect(reembolsar(`now()`)).toBeNull();
  });
});

describe("0964. programação vencida sem aviso não fica presa", () => {
  it("antes: a guarda recusa por falta do aviso de 7 dias", () => {
    expect(guarda(ORG_SEM_AVISO)).toBe("exclusao_sem_aviso_de_7_dias");
  });

  it("fn_exclusao_adiar_para_avisar empurra a data para daqui a 7 dias, zera os marcadores e só mexe nas sem aviso", () => {
    expect(Number(um(`select public.fn_exclusao_adiar_para_avisar();`))).toBeGreaterThanOrEqual(1);
    expect(um(`select (excluir_em > now() + interval '6 days 23 hours' and excluir_em < now() + interval '7 days 1 hour'
                       and aviso_7_dias_em is null and aviso_30_dias_em is null)::text
                 from public.org_exclusoes_programadas where organization_id = '${ORG_SEM_AVISO}';`)).toBe("true");
    // a que já tinha o aviso de 7 dias continua vencida e intocada
    expect(um(`select (excluir_em < now() and aviso_7_dias_em is not null)::text
                 from public.org_exclusoes_programadas where organization_id = '${ORG_AVISADA}';`)).toBe("true");
    // e agora a guarda diz que ainda não venceu (a exclusão NUNCA acontece sem o aviso)
    expect(guarda(ORG_SEM_AVISO)).toBe("exclusao_ainda_nao_venceu");
    expect(erroDe(`select public.fn_exclusao_executar('${ORG_SEM_AVISO}', null, false);`)).toMatch(/exclusao_ainda_nao_venceu/);
  });

  it("rodar de novo não adia outra vez (idempotente)", () => {
    const antes = um(`select excluir_em from public.org_exclusoes_programadas where organization_id = '${ORG_SEM_AVISO}';`);
    sql(`select public.fn_exclusao_adiar_para_avisar();`);
    expect(um(`select excluir_em from public.org_exclusoes_programadas where organization_id = '${ORG_SEM_AVISO}';`)).toBe(antes);
  });
});

describe("0964. o banco decide primeiro e a exclusão em andamento não volta atrás", () => {
  it("no prazo: fn_exclusao_iniciar recusa e não marca nada", () => {
    expect(um(`select public.fn_exclusao_iniciar('${ORG_NO_PRAZO}', false);`)).toBe("exclusao_ainda_nao_venceu");
    expect(estado(ORG_NO_PRAZO)).toBe("programada");
  });

  it("reativada ANTES da marca: o pagamento passa e a guarda recusa, sem marcar", () => {
    sql(`update public.billing_contracts set status = 'ativa' where organization_id = '${ORG_REATIVADA}';`);
    expect(um(`select public.fn_exclusao_iniciar('${ORG_REATIVADA}', false);`)).toBe("exclusao_org_reativada");
    expect(estado(ORG_REATIVADA)).toBe("programada");
  });

  it("vencida e avisada: iniciar marca executando (e repetir continua ok)", () => {
    expect(um(`select public.fn_exclusao_iniciar('${ORG_PRONTA}', false);`)).toBe("ok");
    expect(estado(ORG_PRONTA)).toBe("executando");
    expect(um(`select public.fn_exclusao_iniciar('${ORG_PRONTA}', false);`)).toBe("ok");
  });

  it("depois da marca, reativar o contrato é RECUSADO (o pagamento que chega não ressuscita a organização)", () => {
    expect(erroDe(`update public.billing_contracts set status = 'ativa' where organization_id = '${ORG_PRONTA}';`)).toMatch(
      /billing_org_em_exclusao/,
    );
    expect(um(`select status from public.billing_contracts where organization_id = '${ORG_PRONTA}';`)).toBe("cancelada");
    // trocar entre cancelada e suspensa (o conferidor diário) segue permitido
    expect(erroDe(`update public.billing_contracts set status = 'suspensa' where organization_id = '${ORG_PRONTA}';`)).toBeNull();
    sql(`update public.billing_contracts set status = 'cancelada' where organization_id = '${ORG_PRONTA}';`);
  });

  it("depois da marca, a programação não se cancela nem se reprograma", () => {
    expect(um(`select public.fn_exclusao_cancelar('${ORG_PRONTA}', '${ADMIN}');`)).toBe("em_execucao");
    expect(erroDe(`select public.fn_exclusao_programar('${ORG_PRONTA}', now() + interval '30 days', '${ADMIN}');`)).toMatch(
      /exclusao_em_execucao/,
    );
    expect(estado(ORG_PRONTA)).toBe("executando");
  });

  it("a guarda de fn_exclusao_executar aceita a organização executando e a exclusão termina", () => {
    expect(guarda(ORG_PRONTA)).toBe("ok");
    expect(erroDe(`select public.fn_exclusao_executar('${ORG_PRONTA}', null, false);`)).toBeNull();
    expect(um(`select count(*) from public.organizations where id = '${ORG_PRONTA}';`)).toBe("0");
  });
});

describe("0964. a sincronização não apaga a exclusão que está executando", () => {
  it("controle: programada que deixou de ser candidata (reativada) sai na sincronização", () => {
    expect(estado(ORG_REATIVADA)).toBe("programada");
    sql(`select public.fn_exclusao_sincronizar(90);`);
    expect(estado(ORG_REATIVADA)).toBe("SEM");
  });

  it("executando que deixou de ser candidata (contrato sem ciclo) continua, e a sincronização não a apaga", () => {
    // A sincronização do controle acima reajustou as datas das programadas: vence-se de novo antes de iniciar.
    sql(`update public.org_exclusoes_programadas
            set excluir_em = now() - interval '1 hour', aviso_30_dias_em = now() - interval '25 days', aviso_7_dias_em = now() - interval '8 days'
          where organization_id = '${ORG_EXECUTANDO}';`);
    expect(um(`select public.fn_exclusao_iniciar('${ORG_EXECUTANDO}', false);`)).toBe("ok");
    expect(estado(ORG_EXECUTANDO)).toBe("executando");
    sql(`update public.billing_contracts set cycle = null where organization_id = '${ORG_EXECUTANDO}';`);
    expect(um(`select count(*) from public.fn_exclusao_candidatas() where organization_id = '${ORG_EXECUTANDO}';`)).toBe("0");
    sql(`select public.fn_exclusao_sincronizar(90);`);
    expect(estado(ORG_EXECUTANDO)).toBe("executando");
  });
});

describe("0964. ACL das funções novas", () => {
  it("anon e authenticated não executam", () => {
    for (const f of ["fn_exclusao_iniciar(uuid, boolean)", "fn_exclusao_adiar_para_avisar()"]) {
      for (const papel of ["anon", "authenticated"]) {
        expect(um(`select has_function_privilege('${papel}', 'public.${f}', 'execute')::text;`)).toBe("false");
      }
      expect(um(`select has_function_privilege('service_role', 'public.${f}', 'execute')::text;`)).toBe("true");
    }
    expect(um(`select has_function_privilege('anon', 'public.fn_billing_contracts_barra_reativacao_em_exclusao()', 'execute')::text;`)).toBe("false");
  });
});
