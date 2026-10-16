/**
 * Migração 0959: a exclusão dos dados da organização depois do cancelamento (fork Hiperbold, D-209). Provado no
 * Postgres real:
 *
 *   1. QUEM ENTRA: só cliente que COMPROU (pagamento do Asaas) e cujo contrato terminou (cancelada ou suspensa).
 *      Conta com acesso concedido na mão (plano ilimitado), quem nunca assinou (suspensa sem período nem ciclo),
 *      contrato ativo ou atrasado: nunca entram sozinhos. A data é o fim da assinatura + N dias, e N tem piso de 90
 *      DENTRO da função. Reativar tira da lista; o que o admin cancelou à mão não é recriado; a programação
 *      manual não é tocada pela sincronização.
 *   2. A GUARDA da execução: sem programação, cancelada, no prazo ou (a automática) reativada, o banco recusa.
 *   3. A EXCLUSÃO: nenhuma tabela com organization_id guarda linha da organização apagada (varredura do
 *      catálogo), a outra organização fica intacta, o registro fiscal fica arquivado (valor, ids do Asaas, razão
 *      social e CNPJ; sem nota livre), a auditoria sobrevive com organization_id nulo e ganha a linha
 *      org.data_purged só com contagens, o usuário que pertence a mais de uma organização e o admin da plataforma
 *      ficam, e o usuário só dela sai.
 *   4. O ACL: nenhuma das funções é executável por anon nem authenticated; as tabelas novas não são alcançáveis por
 *      eles; o registro fiscal é só de acréscimo até para service_role; o expurgo respeita o piso de 5 anos.
 *
 * Roda via `pnpm test:db tests/invariants/exclusao-de-dados-apos-cancelamento.test.ts`.
 */
import { spawn } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const U = (n: number) => `0959a000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_PAGANTE = U(1); // cancelada há 50 dias (o teste vence a data à mão)
const ORG_SUSPENSA = U(2); // suspensa há 10 dias: no prazo
const ORG_MANUAL_ACESSO = U(3); // plano ilimitado, cancelada: nunca automática
const ORG_SEM_PLANO = U(4); // suspensa sem período nem ciclo
const ORG_ATIVA = U(5);
const ORG_REATIVA = U(6); // cancelada há 100 dias, mas ainda não sincronizada quando reativa
const ORG_OUTRA = U(7); // intocada
const ORG_PROGRAMADA_A_MAO = U(8);
const ORG_ANTIGA = U(9); // cancelada há 200 dias: a data de fim + 90 já passou
const ORG_SANDBOX = U(10); // pagou só no sandbox do Asaas

const ADMIN_PLATAFORMA = U(11);
const SO_DA_PAGANTE = U(12);
const NAS_DUAS = U(13);
const SO_DA_OUTRA = U(14);
const USUARIO_REFERENCIADO = U(15);
const USUARIO_LIVRE = U(16);
const ORG_FORCADA = U(17);
const ORG_CORRIDA = U(18);

const FUNCOES = [
  "fn_exclusao_candidatas()",
  "fn_exclusao_sincronizar(integer)",
  "fn_exclusao_programar(uuid, timestamptz, uuid)",
  "fn_exclusao_cancelar(uuid, uuid)",
  "fn_exclusao_pode_executar(uuid, boolean)",
  "fn_exclusao_executar(uuid, uuid, boolean)",
  "fn_exclusao_expurgar_fiscais_vencidos(integer)",
];

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
  sql(`insert into public.organizations (id, slug, legal_name, display_name, cnpj)
       values ('${org}', 'i959-${org.slice(-2)}', '${nome} LTDA', '${nome}', ${org === ORG_PAGANTE ? "'12345678000199'" : "null"}) on conflict (id) do nothing;`);
}

/** Põe o contrato no estado dado, com o evento de estado `dias` dias atrás (a data de fim da assinatura). */
function contrato(org: string, o: { plano: string; status: string; ciclo: string | null; dias: number | null }) {
  sql(`
    update public.billing_contracts
       set plan_id = (select id from public.billing_plans where code = '${o.plano}' and active limit 1),
           status = '${o.status}',
           cycle = ${o.ciclo === null ? "null" : `'${o.ciclo}'`},
           current_period_end = ${o.ciclo === null ? "null" : "now() - interval '40 days'"}
     where organization_id = '${org}';
    ${
      o.dias === null
        ? ""
        : `insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, criado_em)
           select '${org}', id, 'conferidor', 'ativa', '${o.status}', 'conferidor', now() - interval '${o.dias} days'
             from public.billing_contracts where organization_id = '${org}';`
    }
  `);
}

/** Um pagamento do Asaas confirmado, ligado a um pedido de assinatura pago no ambiente dado (produção por padrão). */
function pagamentoDoAsaas(org: string, asaasId: string, cents = 9900, ambiente = "producao") {
  sql(`
    with pedido as (
      insert into public.billing_orders (organization_id, ambiente, tipo, plan_id, ciclo, metodo, amount_cents, status, chave, pago_em)
      values ('${org}', '${ambiente}', 'assinatura', (select id from public.billing_plans where code = 'pro' and active limit 1),
              'monthly', 'PIX', ${cents}, 'pago', gen_random_uuid(), now() - interval '130 days')
      returning id
    )
    insert into public.billing_payments (organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at, chave, origem, nota, order_id)
    select '${org}', c.id, '${asaasId}', ${cents}, 'CONFIRMED', now() - interval '130 days', gen_random_uuid(), 'asaas',
           'nota livre que NAO pode ser arquivada', (select id from pedido)
      from public.billing_contracts c where c.organization_id = '${org}';
  `);
}

/** Roda um script em outra sessão, sem bloquear o teste (para as corridas). */
function sqlAsync(script: string): Promise<{ saida: string; erro: string }> {
  const container = process.env.TEST_DB_CONTAINER;
  if (!container) throw new Error("a corrida pede TEST_DB_CONTAINER (rode via pnpm test:db)");
  return new Promise((resolve) => {
    const filho = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"]);
    let saida = "";
    let erro = "";
    filho.stdout.on("data", (d) => (saida += String(d)));
    filho.stderr.on("data", (d) => (erro += String(d)));
    filho.on("close", () => resolve({ saida: saida.trim(), erro }));
    filho.stdin.end(script);
  });
}

const sincronizar = (dias = 90) => JSON.parse(um(`select public.fn_exclusao_sincronizar(${dias});`)) as Record<string, number>;
const linha = (org: string) =>
  um(`select coalesce((select concat_ws('|', origem, motivo, estado, (excluir_em - fim_da_assinatura_em)::text) from public.org_exclusoes_programadas where organization_id = '${org}'), 'SEM');`);

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${ADMIN_PLATAFORMA}', 'i959-pa@invariant.test'), ('${SO_DA_PAGANTE}', 'i959-so@invariant.test'),
      ('${NAS_DUAS}', 'i959-duas@invariant.test'), ('${SO_DA_OUTRA}', 'i959-outra@invariant.test'),
      ('${USUARIO_REFERENCIADO}', 'i959-ref@invariant.test'), ('${USUARIO_LIVRE}', 'i959-livre@invariant.test')
    on conflict (id) do nothing;
    insert into public.platform_admins (user_id, scope, granted_by, reason)
      values ('${ADMIN_PLATAFORMA}', 'full', '${ADMIN_PLATAFORMA}', 'invariante') on conflict do nothing;
  `);
  for (const [org, nome] of [
    [ORG_PAGANTE, "Pagante"], [ORG_SUSPENSA, "Suspensa"], [ORG_MANUAL_ACESSO, "Manual"], [ORG_SEM_PLANO, "SemPlano"],
    [ORG_ATIVA, "Ativa"], [ORG_REATIVA, "Reativa"], [ORG_OUTRA, "Outra"], [ORG_PROGRAMADA_A_MAO, "AMao"], [ORG_ANTIGA, "Antiga"],
    [ORG_SANDBOX, "Sandbox"], [ORG_FORCADA, "Forcada"], [ORG_CORRIDA, "Corrida"],
  ] as const) criarOrg(org, nome);

  contrato(ORG_PAGANTE, { plano: "pro", status: "cancelada", ciclo: "monthly", dias: 50 });
  contrato(ORG_SUSPENSA, { plano: "pro", status: "suspensa", ciclo: "monthly", dias: 10 });
  contrato(ORG_MANUAL_ACESSO, { plano: "ilimitado", status: "cancelada", ciclo: "monthly", dias: 100 });
  contrato(ORG_SEM_PLANO, { plano: "pro", status: "suspensa", ciclo: null, dias: null });
  contrato(ORG_REATIVA, { plano: "pro", status: "cancelada", ciclo: "monthly", dias: 50 });
  contrato(ORG_ANTIGA, { plano: "pro", status: "cancelada", ciclo: "monthly", dias: 200 });
  pagamentoDoAsaas(ORG_ANTIGA, "pay_i959_f");
  contrato(ORG_SANDBOX, { plano: "pro", status: "cancelada", ciclo: "monthly", dias: 50 });
  pagamentoDoAsaas(ORG_SANDBOX, "pay_i959_sb", 9900, "sandbox");
  contrato(ORG_OUTRA, { plano: "pro", status: "ativa", ciclo: "monthly", dias: null });
  pagamentoDoAsaas(ORG_PAGANTE, "pay_i959_a");
  pagamentoDoAsaas(ORG_SUSPENSA, "pay_i959_b");
  // A manual e a sem-plano NÃO têm compra no Asaas; a ativa, a reativa e a outra têm (só a reativa importa).
  pagamentoDoAsaas(ORG_MANUAL_ACESSO, "pay_i959_c");
  pagamentoDoAsaas(ORG_REATIVA, "pay_i959_d");
  pagamentoDoAsaas(ORG_OUTRA, "pay_i959_e");

  sql(`
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${SO_DA_PAGANTE}', '${ORG_PAGANTE}', 'admin', now()),
      ('${NAS_DUAS}', '${ORG_PAGANTE}', 'agent', now()),
      ('${NAS_DUAS}', '${ORG_OUTRA}', 'agent', now()),
      ('${ADMIN_PLATAFORMA}', '${ORG_PAGANTE}', 'admin', now()),
      ('${SO_DA_OUTRA}', '${ORG_OUTRA}', 'admin', now()),
      ('${USUARIO_REFERENCIADO}', '${ORG_FORCADA}', 'admin', now()),
      ('${USUARIO_LIVRE}', '${ORG_FORCADA}', 'agent', now())
    on conflict do nothing;
  `);
});

describe("1. quem entra na exclusão automática", () => {
  it("o cliente que pagou e cancelou/foi suspenso entra, com a data = fim da assinatura + 90 dias", () => {
    const r = sincronizar(90);
    expect(r.programadas).toBeGreaterThanOrEqual(3);
    expect(linha(ORG_SANDBOX)).toBe("SEM"); // só sandbox: não é cliente
    expect(linha(ORG_PAGANTE)).toBe("automatica|cancelada|programada|90 days");
    expect(linha(ORG_SUSPENSA)).toBe("automatica|suspensa|programada|90 days");
  });

  it("cliente cujo fim foi há mais de 60 dias nunca é apagado sem 30 dias de aviso: a data vira daqui a 30 dias", () => {
    sincronizar(90);
    expect(um(`select (excluir_em >= now() + interval '29 days' and excluir_em <= now() + interval '31 days')::text
                 from public.org_exclusoes_programadas where organization_id = '${ORG_ANTIGA}';`)).toBe("true");
    // idempotente: outra sincronização não puxa a data de volta para o passado
    sincronizar(90);
    expect(um(`select (excluir_em > now() + interval '29 days')::text from public.org_exclusoes_programadas where organization_id = '${ORG_ANTIGA}';`)).toBe("true");
  });

  it("a conta de acesso manual (plano ilimitado), quem nunca assinou e quem está ativo NUNCA entram", () => {
    expect(linha(ORG_MANUAL_ACESSO)).toBe("SEM");
    expect(linha(ORG_SEM_PLANO)).toBe("SEM");
    expect(linha(ORG_ATIVA)).toBe("SEM");
    expect(linha(ORG_OUTRA)).toBe("SEM");
  });

  it("N tem piso de 90 dentro da função (30 é recusado, 365 vale)", () => {
    expect(erroDe(`select public.fn_exclusao_sincronizar(30);`)).toContain("exclusao_dias_invalido");
    expect(erroDe(`select public.fn_exclusao_sincronizar(89);`)).toContain("exclusao_dias_invalido");
    expect(erroDe(`select public.fn_exclusao_sincronizar(366);`)).toContain("exclusao_dias_invalido");
    expect(erroDe(`select public.fn_exclusao_sincronizar(365);`)).toBeNull();
    sincronizar(90); // volta ao normal
    expect(linha(ORG_PAGANTE)).toBe("automatica|cancelada|programada|90 days");
  });

  it("rodar a sincronização de novo não muda nada (idempotente) e mudar N move a data", () => {
    const antes = um(`select excluir_em from public.org_exclusoes_programadas where organization_id = '${ORG_SUSPENSA}';`);
    const r = sincronizar(90);
    expect(r).toMatchObject({ programadas: 0, atualizadas: 0 });
    expect(um(`select excluir_em from public.org_exclusoes_programadas where organization_id = '${ORG_SUSPENSA}';`)).toBe(antes);
    sincronizar(120);
    expect(linha(ORG_SUSPENSA)).toBe("automatica|suspensa|programada|120 days");
    sincronizar(90);
  });

  it("reativar ou pagar de novo (o contrato sai de cancelada/suspensa) cancela a programação", () => {
    sincronizar(90);
    expect(linha(ORG_REATIVA)).toBe("automatica|cancelada|programada|90 days");
    sql(`update public.billing_contracts set status = 'ativa' where organization_id = '${ORG_REATIVA}';`);
    expect(sincronizar(90).canceladas_por_reativacao).toBe(1);
    expect(linha(ORG_REATIVA)).toBe("SEM");
  });

  it("o que o admin cancelou à mão não é recriado enquanto o contrato continuar cancelado", () => {
    expect(um(`select public.fn_exclusao_cancelar('${ORG_SUSPENSA}', '${ADMIN_PLATAFORMA}');`)).toBe("cancelada");
    expect(um(`select public.fn_exclusao_cancelar('${ORG_SUSPENSA}', '${ADMIN_PLATAFORMA}');`)).toBe("ja_cancelada");
    sincronizar(90);
    expect(linha(ORG_SUSPENSA)).toBe("automatica|suspensa|cancelada|90 days");
    expect(um(`select public.fn_exclusao_cancelar('${ORG_ATIVA}', '${ADMIN_PLATAFORMA}');`)).toBe("inexistente");
  });

  it("a programação manual vale para qualquer organização e a sincronização não a toca", () => {
    sql(`select public.fn_exclusao_programar('${ORG_PROGRAMADA_A_MAO}', now() + interval '40 days', '${ADMIN_PLATAFORMA}');
         select public.fn_exclusao_programar('${ORG_MANUAL_ACESSO}', now() + interval '40 days', '${ADMIN_PLATAFORMA}');`);
    const antes = um(`select excluir_em from public.org_exclusoes_programadas where organization_id = '${ORG_MANUAL_ACESSO}';`);
    sincronizar(90);
    expect(um(`select origem from public.org_exclusoes_programadas where organization_id = '${ORG_MANUAL_ACESSO}';`)).toBe("manual");
    expect(um(`select excluir_em from public.org_exclusoes_programadas where organization_id = '${ORG_MANUAL_ACESSO}';`)).toBe(antes);
    // cancelar a manual apaga a linha
    expect(um(`select public.fn_exclusao_cancelar('${ORG_MANUAL_ACESSO}', '${ADMIN_PLATAFORMA}');`)).toBe("removida");
    expect(linha(ORG_MANUAL_ACESSO)).toBe("SEM");
  });

  it("programar recusa organização inexistente e data absurda", () => {
    expect(erroDe(`select public.fn_exclusao_programar('${U(99)}', now() + interval '1 day', '${ADMIN_PLATAFORMA}');`)).toContain("exclusao_org_inexistente");
    expect(erroDe(`select public.fn_exclusao_programar('${ORG_ATIVA}', now() + interval '20 years', '${ADMIN_PLATAFORMA}');`)).toContain("exclusao_data_invalida");
  });
});

describe("2. a guarda da execução", () => {
  const executar = (org: string) => erroDe(`select public.fn_exclusao_executar('${org}', '${ADMIN_PLATAFORMA}');`);

  it("organização que nunca foi programada não é apagada", () => {
    expect(executar(ORG_ATIVA)).toContain("exclusao_nao_programada");
    expect(um(`select count(*) from public.organizations where id = '${ORG_ATIVA}';`)).toBe("1");
  });

  it("antes do prazo não é apagada (a suspensa tem ~80 dias a correr; a manual, 40)", () => {
    sql(`update public.org_exclusoes_programadas set estado = 'programada', cancelada_em = null where organization_id = '${ORG_SUSPENSA}';`);
    expect(executar(ORG_SUSPENSA)).toContain("exclusao_ainda_nao_venceu");
    expect(executar(ORG_PROGRAMADA_A_MAO)).toContain("exclusao_ainda_nao_venceu");
  });

  it("programação cancelada pelo admin não é apagada, mesmo vencida", () => {
    sql(`update public.org_exclusoes_programadas set estado = 'cancelada', cancelada_em = now(), excluir_em = now() - interval '1 day' where organization_id = '${ORG_SUSPENSA}';`);
    expect(executar(ORG_SUSPENSA)).toContain("exclusao_cancelada");
  });

  it("automática vencida mas REATIVADA depois da sincronização não é apagada", () => {
    sincronizar(90);
    sql(`update public.org_exclusoes_programadas set excluir_em = now() - interval '1 day' where organization_id = '${ORG_PAGANTE}';
         update public.billing_contracts set status = 'ativa' where organization_id = '${ORG_PAGANTE}';`);
    expect(executar(ORG_PAGANTE)).toContain("exclusao_org_reativada");
    expect(um(`select count(*) from public.organizations where id = '${ORG_PAGANTE}';`)).toBe("1");
    // volta ao estado de teste da seção 3
    sql(`update public.billing_contracts set status = 'cancelada' where organization_id = '${ORG_PAGANTE}';`);
    sincronizar(90);
  });
});

describe("3. a exclusão", () => {
  let resultado: Record<string, number | string> = {};

  beforeAll(() => {
    // Dados do tenant que vai sair e do que fica.
    for (const org of [ORG_PAGANTE, ORG_OUTRA]) {
      sql(`
        do $$
        declare v_org uuid := '${org}'; v_sess uuid := gen_random_uuid(); v_contact uuid; v_conv uuid;
        begin
          insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
            values (v_sess, v_org, 'i959-' || right(v_org::text, 2), '\\x00'::bytea);
          insert into public.contacts (organization_id, display_name) values (v_org, 'Contato i959') returning id into v_contact;
          insert into public.conversations (organization_id, contact_id, channel_session_id)
            values (v_org, v_contact, v_sess) returning id into v_conv;
          insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
            values (v_org, v_conv, v_sess, v_contact, 'text', 'inbound', 'mensagem i959');
          insert into public.webhook_events_log (organization_id, provider, http_method, raw_body, status)
            values (v_org, 'waha', 'POST', '{"corpo":"bruto"}', 'processed');
          insert into public.api_audit_log (organization_id, action, resource_type, metadata)
            values (v_org, 'i959.acesso', 'teste', '{}'::jsonb);
        end $$;
      `);
    }
    // Um pedido pago (sem pagamento apontando para ele) e um registro de cliente do Asaas.
    sql(`
      insert into public.billing_orders (organization_id, ambiente, tipo, plan_id, ciclo, metodo, amount_cents, status, chave, pago_em)
        values ('${ORG_PAGANTE}', 'sandbox', 'assinatura', (select id from public.billing_plans where code = 'pro' and active limit 1),
                'monthly', 'PIX', 9900, 'pago', gen_random_uuid(), now() - interval '131 days');
      insert into public.billing_customers (organization_id, ambiente, asaas_customer_id)
        values ('${ORG_PAGANTE}', 'sandbox', 'cus_i959cliente');
      update public.org_exclusoes_programadas set excluir_em = now() - interval '1 day', aviso_7_dias_em = now() - interval '6 days' where organization_id = '${ORG_PAGANTE}';
    `);
    resultado = JSON.parse(um(`select public.fn_exclusao_executar('${ORG_PAGANTE}', '${ADMIN_PLATAFORMA}');`));
  });

  it("a resposta traz só contagens", () => {
    expect(resultado).toMatchObject({
      contatos: 1, conversas: 1, mensagens: 1, webhook_logs_apagados: 1, usuarios_removidos: 1, usuarios_mantidos: 0,
    });
    expect(Number(resultado.registros_fiscais_arquivados)).toBeGreaterThanOrEqual(2);
  });

  it("nenhuma tabela com organization_id guarda linha da organização apagada", () => {
    const tabelas = sql(`
      select c.table_name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
       where c.table_schema = 'public' and c.column_name = 'organization_id' order by 1;
    `).split("\n").filter(Boolean);
    expect(tabelas.length).toBeGreaterThan(100); // controle positivo: a varredura enxerga o catálogo
    const restos: string[] = [];
    for (const t of tabelas) {
      // O log do webhook do Asaas é evidência do gateway, sem chave estrangeira por desenho (0909).
      if (t === "asaas_webhook_events") continue;
      const n = Number(um(`select count(*) from public."${t}" where organization_id = '${ORG_PAGANTE}';`));
      if (n > 0) restos.push(`${t}=${n}`);
    }
    expect(restos).toEqual([]);
    expect(um(`select count(*) from public.organizations where id = '${ORG_PAGANTE}';`)).toBe("0");
  });

  it("a outra organização fica intacta, com tudo", () => {
    expect(um(`select count(*) from public.contacts where organization_id = '${ORG_OUTRA}';`)).toBe("1");
    expect(um(`select count(*) from public.messages where organization_id = '${ORG_OUTRA}';`)).toBe("1");
    expect(um(`select count(*) from public.webhook_events_log where organization_id = '${ORG_OUTRA}';`)).toBe("1");
    expect(um(`select count(*) from public.billing_payments where organization_id = '${ORG_OUTRA}';`)).toBe("1");
    expect(um(`select count(*) from public.organizations where id in ('${ORG_OUTRA}', '${ORG_SUSPENSA}', '${ORG_ATIVA}');`)).toBe("3");
  });

  it("o registro fiscal fica arquivado com valor, ids do Asaas, razão social e CNPJ, e sem a nota livre", () => {
    expect(um(`select count(*) from public.billing_registros_fiscais_arquivados where organizacao_id_origem = '${ORG_PAGANTE}';`)).toBe(String(resultado.registros_fiscais_arquivados));
    expect(um(`select concat_ws('|', organizacao_razao_social, organizacao_cnpj, valor_cents::text, asaas_payment_id, fonte)
                 from public.billing_registros_fiscais_arquivados where organizacao_id_origem = '${ORG_PAGANTE}' and fonte = 'pagamento';`))
      .toBe("Pagante LTDA|12345678000199|9900|pay_i959_a|pagamento");
    expect(um(`select concat_ws('|', tipo, plano_codigo, asaas_customer_id) from public.billing_registros_fiscais_arquivados
                where organizacao_id_origem = '${ORG_PAGANTE}' and fonte = 'pedido';`)).toBe("assinatura|pro|cus_i959cliente");
    const colunas = sql(`select column_name from information_schema.columns where table_name = 'billing_registros_fiscais_arquivados';`);
    expect(colunas).not.toMatch(/nota|email|telefone|nome_do_contato|criado_por/);
    expect(sql(`select count(*) from public.billing_registros_fiscais_arquivados where to_jsonb(billing_registros_fiscais_arquivados)::text like '%NAO pode ser arquivada%';`)).toBe("0");
  });

  it("a auditoria SOBREVIVE (organization_id nulo) e ganha a linha org.data_purged só com contagens", () => {
    expect(um(`select count(*) from public.api_audit_log where action = 'i959.acesso' and organization_id is null and created_at > now() - interval '1 hour';`)).toBe("1");
    expect(um(`select count(*) from public.api_audit_log where action = 'i959.acesso' and organization_id = '${ORG_OUTRA}';`)).toBe("1");
    const meta = JSON.parse(um(`select metadata from public.api_audit_log where action = 'org.data_purged' and resource_id = '${ORG_PAGANTE}';`)) as Record<string, unknown>;
    expect(meta).toMatchObject({ organization_id: ORG_PAGANTE, origem: "automatica", motivo: "cancelada", contatos: 1, mensagens: 1 });
    expect(Object.values(meta).every((v) => typeof v !== "string" || /^[0-9a-f-]{36}$|^(automatica|manual|cancelada|suspensa)$|^\d{4}-\d{2}-\d{2}T/.test(v))).toBe(true);
  });

  it("o usuário só dela sai; o de duas organizações e o admin da plataforma ficam", () => {
    expect(um(`select count(*) from auth.users where id = '${SO_DA_PAGANTE}';`)).toBe("0");
    expect(um(`select count(*) from auth.users where id = '${NAS_DUAS}';`)).toBe("1");
    expect(um(`select count(*) from auth.users where id = '${SO_DA_OUTRA}';`)).toBe("1");
    expect(um(`select count(*) from auth.users where id = '${ADMIN_PLATAFORMA}';`)).toBe("1");
    expect(um(`select count(*) from public.platform_admins where user_id = '${ADMIN_PLATAFORMA}';`)).toBe("1");
    expect(um(`select count(*) from public.user_organizations where user_id = '${NAS_DUAS}' and organization_id = '${ORG_OUTRA}';`)).toBe("1");
  });

  it("não dá para executar de novo: a programação sumiu com a organização", () => {
    expect(erroDe(`select public.fn_exclusao_executar('${ORG_PAGANTE}', '${ADMIN_PLATAFORMA}');`)).toContain("exclusao_nao_programada");
  });
});

describe("5. correções da auditoria de segurança", () => {
  it("(#7) compra só no sandbox do Asaas não faz da organização um cliente", () => {
    sincronizar(90);
    expect(linha(ORG_SANDBOX)).toBe("SEM");
  });

  it("(#2) diminuir N nunca traz uma programação que já existe para o passado ou para menos de 30 dias", () => {
    const ORG = U(20);
    criarOrg(ORG, "Longa");
    contrato(ORG, { plano: "pro", status: "cancelada", ciclo: "monthly", dias: 100 });
    pagamentoDoAsaas(ORG, "pay_i959_longa");
    sincronizar(365); // fim + 365 = daqui a ~265 dias
    // a programação nasceu há 100 dias: sem o conserto, N = 90 puxava a data para fim + 90, que é 10 dias atrás
    sql(`update public.org_exclusoes_programadas set created_at = now() - interval '100 days' where organization_id = '${ORG}';`);
    const antes = um(`select excluir_em from public.org_exclusoes_programadas where organization_id = '${ORG}';`);
    sincronizar(90);
    expect(um(`select excluir_em from public.org_exclusoes_programadas where organization_id = '${ORG}';`)).toBe(antes);
    expect(um(`select (excluir_em > now() + interval '200 days')::text from public.org_exclusoes_programadas where organization_id = '${ORG}';`)).toBe("true");
  });

  it("(#2) diminuir N que ainda deixa 30 dias antecipa a data e refaz os avisos (a fila é por data)", () => {
    const ORG = U(21);
    criarOrg(ORG, "Media");
    contrato(ORG, { plano: "pro", status: "cancelada", ciclo: "monthly", dias: 50 });
    pagamentoDoAsaas(ORG, "pay_i959_media");
    sincronizar(365);
    sql(`update public.org_exclusoes_programadas set created_at = now() - interval '60 days', aviso_30_dias_em = now() where organization_id = '${ORG}';`);
    sincronizar(90); // fim (50 dias atrás) + 90 = daqui a 40 dias: ainda deixa 30
    expect(um(`select (excluir_em between now() + interval '39 days' and now() + interval '41 days')::text from public.org_exclusoes_programadas where organization_id = '${ORG}';`)).toBe("true");
    expect(um(`select (aviso_30_dias_em is null)::text from public.org_exclusoes_programadas where organization_id = '${ORG}';`)).toBe("true");
  });

  it("(#4) a automática só é apagada com o aviso de 7 dias enfileirado; a forçada do admin está isenta", () => {
    sincronizar(90);
    sql(`update public.org_exclusoes_programadas set excluir_em = now() - interval '1 day', aviso_7_dias_em = null where organization_id = '${ORG_ANTIGA}';`);
    expect(um(`select public.fn_exclusao_pode_executar('${ORG_ANTIGA}');`)).toBe("exclusao_sem_aviso_de_7_dias");
    expect(erroDe(`select public.fn_exclusao_executar('${ORG_ANTIGA}', '${ADMIN_PLATAFORMA}');`)).toContain("exclusao_sem_aviso_de_7_dias");
    expect(um(`select count(*) from public.organizations where id = '${ORG_ANTIGA}';`)).toBe("1");
    sql(`update public.org_exclusoes_programadas set aviso_7_dias_em = now() where organization_id = '${ORG_ANTIGA}';`);
    expect(um(`select public.fn_exclusao_pode_executar('${ORG_ANTIGA}');`)).toBe("ok");
    expect(um(`select public.fn_exclusao_pode_executar('${ORG_ATIVA}', true);`)).toBe("ok");
    expect(um(`select public.fn_exclusao_pode_executar('${U(99)}', true);`)).toBe("exclusao_org_inexistente");
  });

  it("(#3) um pagamento que está gravando o contrato vence a exclusão: ela espera e recusa", async () => {
    criarOrg(ORG_CORRIDA, "Corrida");
    contrato(ORG_CORRIDA, { plano: "pro", status: "cancelada", ciclo: "monthly", dias: 50 });
    pagamentoDoAsaas(ORG_CORRIDA, "pay_i959_corrida");
    sincronizar(90);
    sql(`update public.org_exclusoes_programadas set excluir_em = now() - interval '1 day', aviso_7_dias_em = now() where organization_id = '${ORG_CORRIDA}';`);
    // A trava o contrato, demora e reativa; B tenta excluir no meio.
    const a = sqlAsync(`begin;
      select 1 from public.billing_contracts where organization_id = '${ORG_CORRIDA}' for update;
      select pg_sleep(4);
      update public.billing_contracts set status = 'ativa' where organization_id = '${ORG_CORRIDA}';
      commit;`);
    await new Promise((r) => setTimeout(r, 1500));
    const b = await sqlAsync(`select public.fn_exclusao_executar('${ORG_CORRIDA}', '${ADMIN_PLATAFORMA}');`);
    await a;
    expect(b.erro).toContain("exclusao_org_reativada");
    expect(um(`select count(*) from public.organizations where id = '${ORG_CORRIDA}';`)).toBe("1");
  }, 30_000);

  it("(#5, #6) a exclusão forçada não cria nem altera programação, e a conta ainda referenciada de fora fica", () => {
    sql(`
      create table if not exists public.i959_ref (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null references public.organizations(id) on delete cascade,
        user_id uuid not null references auth.users(id) on delete cascade
      );
      insert into public.i959_ref (organization_id, user_id) values ('${ORG_OUTRA}', '${USUARIO_REFERENCIADO}');
    `);
    const programacaoAntes = um(`select concat_ws('|', excluir_em, estado, origem) from public.org_exclusoes_programadas where organization_id = '${ORG_ANTIGA}';`);
    // sem forçar: ORG_FORCADA nunca foi programada
    expect(erroDe(`select public.fn_exclusao_executar('${ORG_FORCADA}', '${ADMIN_PLATAFORMA}');`)).toContain("exclusao_nao_programada");
    const r = JSON.parse(um(`select public.fn_exclusao_executar('${ORG_FORCADA}', '${ADMIN_PLATAFORMA}', true);`)) as Record<string, number | string>;
    expect(r).toMatchObject({ origem: "manual", usuarios_removidos: 1, usuarios_mantidos: 1 });
    expect(um(`select count(*) from public.organizations where id = '${ORG_FORCADA}';`)).toBe("0");
    expect(um(`select count(*) from public.org_exclusoes_programadas where organization_id = '${ORG_FORCADA}';`)).toBe("0");
    expect(um(`select count(*) from auth.users where id = '${USUARIO_REFERENCIADO}';`)).toBe("1");
    expect(um(`select count(*) from auth.users where id = '${USUARIO_LIVRE}';`)).toBe("0");
    expect(um(`select count(*) from public.i959_ref where organization_id = '${ORG_OUTRA}';`)).toBe("1");
    // outra programação qualquer ficou como estava
    expect(um(`select concat_ws('|', excluir_em, estado, origem) from public.org_exclusoes_programadas where organization_id = '${ORG_ANTIGA}';`)).toBe(programacaoAntes);
  });
});

describe("4. ACL e retenção dos registros fiscais", () => {
  it("nenhuma função é executável por anon nem authenticated, e service_role executa", () => {
    for (const f of FUNCOES) {
      for (const papel of ["anon", "authenticated"]) {
        expect(um(`select has_function_privilege('${papel}', 'public.${f}', 'execute');`), `${papel} ${f}`).toBe("f");
      }
      expect(um(`select has_function_privilege('service_role', 'public.${f}', 'execute');`), `service_role ${f}`).toBe("t");
    }
  });

  it("anon e authenticated não alcançam as duas tabelas", () => {
    for (const papel of ["anon", "authenticated"]) {
      for (const t of ["org_exclusoes_programadas", "billing_registros_fiscais_arquivados"]) {
        expect(erroDe(`set role ${papel}; select count(*) from public.${t};`)).toContain("permission denied");
      }
    }
  });

  it("nem o administrador da PRÓPRIA organização lê a programação (JWT simulado)", () => {
    const erro = erroDe(`set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${SO_DA_OUTRA}"}', false);
      select count(*) from public.org_exclusoes_programadas where organization_id = '${ORG_OUTRA}';`);
    expect(erro).toContain("permission denied");
  });

  it("o registro fiscal é só de acréscimo, até para service_role", () => {
    for (const dml of [
      `delete from public.billing_registros_fiscais_arquivados`,
      `update public.billing_registros_fiscais_arquivados set valor_cents = 1`,
      `insert into public.billing_registros_fiscais_arquivados (organizacao_id_origem, fonte, fonte_id, tipo, status, valor_cents) values (gen_random_uuid(), 'pagamento', gen_random_uuid(), 'x', 'x', 1)`,
      `truncate public.billing_registros_fiscais_arquivados`,
    ]) {
      expect(erroDe(`set role service_role; ${dml};`), dml).toContain("permission denied");
    }
  });

  it("service_role só escreve os dois marcadores de aviso na programação", () => {
    expect(erroDe(`set role service_role; update public.org_exclusoes_programadas set aviso_30_dias_em = now();`)).toBeNull();
    expect(erroDe(`set role service_role; update public.org_exclusoes_programadas set excluir_em = now();`)).toContain("permission denied");
    expect(erroDe(`set role service_role; delete from public.org_exclusoes_programadas;`)).toContain("permission denied");
  });

  it("o expurgo respeita o piso de 5 anos: reter_ate vencido sozinho não apaga", () => {
    sql(`insert into public.billing_registros_fiscais_arquivados (organizacao_id_origem, fonte, fonte_id, tipo, status, valor_cents, arquivado_em, reter_ate)
         values ('${U(70)}', 'pagamento', '${U(71)}', 'assinatura', 'CONFIRMED', 100, now() - interval '1 year', now() - interval '1 day'),
                ('${U(70)}', 'pagamento', '${U(72)}', 'assinatura', 'CONFIRMED', 100, now() - interval '6 years', now() - interval '1 year');`);
    expect(um(`select public.fn_exclusao_expurgar_fiscais_vencidos(500);`)).toBe("1");
    expect(um(`select count(*) from public.billing_registros_fiscais_arquivados where fonte_id = '${U(71)}';`)).toBe("1");
    expect(um(`select count(*) from public.billing_registros_fiscais_arquivados where fonte_id = '${U(72)}';`)).toBe("0");
    expect(erroDe(`select public.fn_exclusao_expurgar_fiscais_vencidos(0);`)).toContain("exclusao_limite_invalido");
  });
});
