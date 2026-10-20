import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

/**
 * Membro da agência (migration 0974, fork Hiperbold, pedido do dono do produto, 20/10/2026).
 *
 * O defeito de produção: quem criava a organização pelo painel entrava como admin PROVISÓRIO, e o primeiro
 * admin convidado que aceitava apagava esse vínculo (`fn_accept_team_invite`). O dono da Hiperbold perdeu o
 * acesso à organização da cliente. O vínculo da agência agora é permanente, não ocupa vaga e só o servidor
 * o grava ou o apaga.
 *
 * Cada caso roda numa transação que termina em `rollback`: nada vaza para outro arquivo.
 */

const MARCA = "SONDA|";

const PA = "a0740000-0000-4000-8000-000000000001"; // admin da plataforma, escopo full (a agência)
const PS = "a0740000-0000-4000-8000-000000000002"; // admin da plataforma, suporte somente leitura
const CLI = "a0740000-0000-4000-8000-000000000003"; // admin do cliente
const AG = "a0740000-0000-4000-8000-000000000004"; // segunda pessoa da agência
const VIEWER = "a0740000-0000-4000-8000-000000000005"; // membro comum do cliente
const OUTRO = "a0740000-0000-4000-8000-000000000006"; // admin de OUTRA organização
const CHAVE = "a0740000-0000-4000-8000-0000000000aa";
const ORG_OUTRA = "a0740000-0000-4000-8000-0000000000b1";

const CORPO = `'{"display_name":"Cliente 0974","slug":"cliente-0974","plan":"standard","owner_email":"cli-0974@invariant.test"}'::jsonb`;

function marcadas(saida: string): string[] {
  return saida
    .split("\n")
    .filter((l) => l.startsWith(MARCA))
    .map((l) => l.slice(MARCA.length));
}

const SEMENTE = `
  begin;
  insert into auth.users(id,email) values
    ('${PA}','pa-0974@invariant.test'),
    ('${PS}','ps-0974@invariant.test'),
    ('${CLI}','cli-0974@invariant.test'),
    ('${AG}','ag-0974@invariant.test'),
    ('${VIEWER}','viewer-0974@invariant.test'),
    ('${OUTRO}','outro-0974@invariant.test');
  insert into public.platform_admins(user_id,granted_by,scope,mfa_required,reason) values
    ('${PA}','${PA}','full',false,'fixture 0974'),
    ('${PS}','${PA}','support_readonly',false,'fixture 0974');
`;

/** Cria a organização pelo painel (a agência é quem cria; o dono é o cliente) e devolve o id em `org`. */
const CRIA_ORG = `
  create temp table ctx(org uuid);
  grant select on ctx to public;
  insert into ctx select (public.fn_create_tenant_with_owner('${PA}','${CHAVE}',${CORPO},'abcd')->>'id')::uuid;
`;

const COMO_SERVICO = `set role service_role;`;
const COMO = (u: string) =>
  `set role authenticated;\nselect set_config('request.jwt.claims','{"sub":"${u}"}',false);`;

function prova(corpo: string): string[] {
  return marcadas(sql(`${SEMENTE}\n${corpo}\nreset role;\nrollback;`));
}

function erro(corpo: string): string {
  try {
    sql(`${SEMENTE}\n${corpo}\nreset role;\nrollback;`);
  } catch (e) {
    return motivoDoErro(e);
  }
  return "";
}


describe("membro da agência: criação, entrega e vaga do plano", () => {
  it("quem cria para OUTRA pessoa nasce membro da agência, não provisório", () => {
    const l = prova(`
      ${CRIA_ORG}
      select 'SONDA|' || membro_da_agencia || '|' || provisional_until_handover || '|' || role
        from public.user_organizations where user_id='${PA}' and organization_id=(select org from ctx);
    `);
    expect(l).toEqual(["true|false|admin"]);
  });

  it("SOBREVIVE À ENTREGA: o dono do cliente aceita o convite admin e o vínculo da agência continua", () => {
    const l = prova(`
      ${CRIA_ORG}
      select public.fn_accept_team_invite('${CLI}',(select org from ctx),'admin','${PA}',now()-interval '1 minute',now()-interval '1 minute','{"preset":"completa"}'::jsonb);
      select 'SONDA|agencia=' || count(*) from public.user_organizations
        where user_id='${PA}' and organization_id=(select org from ctx) and membro_da_agencia and revoked_at is null;
      select 'SONDA|cliente=' || count(*) from public.user_organizations
        where user_id='${CLI}' and organization_id=(select org from ctx) and role='admin' and not membro_da_agencia;
    `);
    expect(l).toEqual(["agencia=1", "cliente=1"]);
  });

  it("o provisório antigo (sem a marca da agência) continua saindo na entrega", () => {
    const l = prova(`
      ${CRIA_ORG}
      update public.user_organizations set membro_da_agencia=false, provisional_until_handover=true
        where user_id='${PA}' and organization_id=(select org from ctx);
      select public.fn_accept_team_invite('${CLI}',(select org from ctx),'admin','${PA}',now()-interval '1 minute',now()-interval '1 minute','{"preset":"completa"}'::jsonb);
      select 'SONDA|restou=' || count(*) from public.user_organizations
        where user_id='${PA}' and organization_id=(select org from ctx);
    `);
    expect(l).toEqual(["restou=0"]);
  });

  it("não ocupa vaga: fn_billing_uso e fn_billing_pode_criar contam só o cliente", () => {
    const l = prova(`
      ${CRIA_ORG}
      select public.fn_accept_team_invite('${CLI}',(select org from ctx),'admin','${PA}',now()-interval '1 minute',now()-interval '1 minute','{"preset":"completa"}'::jsonb);
      select public.fn_billing_ajustar_limites((select org from ctx),'{"membros": 5}'::jsonb,null,null);
      select 'SONDA|uso_antes=' || (public.fn_billing_uso((select org from ctx))->>'membros');
      ${COMO_SERVICO}
      select public.fn_membro_da_agencia_definir((select org from ctx),'ag-0974@invariant.test',true,'${PA}');
      reset role;
      select 'SONDA|uso_depois=' || (public.fn_billing_uso((select org from ctx))->>'membros');
      select 'SONDA|atual=' || (public.fn_billing_pode_criar((select org from ctx),'membros')->>'atual');
      select 'SONDA|linhas_ativas=' || count(*) from public.user_organizations
        where organization_id=(select org from ctx) and revoked_at is null;
    `);
    expect(l).toEqual(["uso_antes=1", "uso_depois=1", "atual=1", "linhas_ativas=3"]);
  });

  it("no teto do plano com o bloqueio ligado: o membro comum leva PT402 e a agência entra", () => {
    const preparo = `
      insert into public.organizations(id,slug,legal_name,display_name) values ('${ORG_OUTRA}','teto-0974','Teto','Teto');
      insert into public.user_organizations(user_id,organization_id,role,accepted_at) values ('${CLI}','${ORG_OUTRA}','admin',now());
      select public.fn_billing_ajustar_limites('${ORG_OUTRA}'::uuid,'{"membros": 1}'::jsonb,null,null);
      update public.billing_settings set modo='bloquear' where id=1;
      update public.billing_contracts set bloqueio_a_partir_de=now()-interval '1 day' where organization_id='${ORG_OUTRA}';
    `;
    // controle: um membro comum, no teto, é barrado
    const controle = erro(`
      ${preparo}
      ${COMO_SERVICO}
      insert into public.user_organizations(user_id,organization_id,role,accepted_at) values ('${VIEWER}','${ORG_OUTRA}','viewer',now());
    `);
    expect(controle).toContain("Limite do plano atingido");
    // a agência entra no mesmo teto
    const l = prova(`
      ${preparo}
      ${COMO_SERVICO}
      select public.fn_membro_da_agencia_definir('${ORG_OUTRA}','ag-0974@invariant.test',true,'${PA}');
      reset role;
      select 'SONDA|agencia=' || count(*) from public.user_organizations
        where user_id='${AG}' and organization_id='${ORG_OUTRA}' and membro_da_agencia;
    `);
    expect(l).toEqual(["agencia=1"]);
  });
});

describe("membro da agência: quem pode marcar e remover", () => {
  it("fn_membro_da_agencia_definir: criar, repetir (ja_era), auditar e remover", () => {
    const l = prova(`
      ${CRIA_ORG}
      ${COMO_SERVICO}
      select 'SONDA|1=' || (public.fn_membro_da_agencia_definir((select org from ctx),' AG-0974@invariant.test ',true,'${PA}')->>'acao');
      select 'SONDA|2=' || (public.fn_membro_da_agencia_definir((select org from ctx),'ag-0974@invariant.test',true,'${PA}')->>'acao');
      reset role;
      select 'SONDA|vinculo=' || role || '|' || membro_da_agencia || '|' || (accepted_at is not null) || '|' || (revoked_at is null)
        from public.user_organizations where user_id='${AG}' and organization_id=(select org from ctx);
      select 'SONDA|auditoria=' || count(*) from public.api_audit_log
        where action='agency_member.added' and organization_id=(select org from ctx) and actor_user_id='${PA}';
      ${COMO_SERVICO}
      select 'SONDA|3=' || (public.fn_membro_da_agencia_definir((select org from ctx),'ag-0974@invariant.test',false,'${PA}')->>'acao');
      reset role;
      select 'SONDA|removido=' || membro_da_agencia || '|' || (revoked_at is not null)
        from public.user_organizations where user_id='${AG}' and organization_id=(select org from ctx);
      select 'SONDA|auditoria_remocao=' || count(*) from public.api_audit_log
        where action='agency_member.removed' and organization_id=(select org from ctx);
    `);
    expect(l).toEqual([
      "1=criado",
      "2=ja_era",
      "vinculo=admin|true|true|true",
      "auditoria=1",
      "3=removido",
      "removido=false|true",
      "auditoria_remocao=1",
    ]);
  });

  it("marcar quem já é membro comum promove a admin e tira o provisório", () => {
    const l = prova(`
      ${CRIA_ORG}
      insert into public.user_organizations(user_id,organization_id,role,accepted_at,provisional_until_handover)
        values ('${AG}',(select org from ctx),'viewer',now(),true);
      ${COMO_SERVICO}
      select 'SONDA|acao=' || (public.fn_membro_da_agencia_definir((select org from ctx),'ag-0974@invariant.test',true,'${PA}')->>'acao');
      reset role;
      select 'SONDA|vinculo=' || role || '|' || membro_da_agencia || '|' || provisional_until_handover
        from public.user_organizations where user_id='${AG}' and organization_id=(select org from ctx);
    `);
    expect(l).toEqual(["acao=marcado", "vinculo=admin|true|false"]);
  });

  it("só admin da plataforma de escopo full: suporte, admin do cliente e desconhecido são recusados", () => {
    const tenta = (ator: string) =>
      erro(`
        ${CRIA_ORG}
        ${COMO_SERVICO}
        select public.fn_membro_da_agencia_definir((select org from ctx),'ag-0974@invariant.test',true,'${ator}');
      `);
    expect(tenta(PS)).toContain("platform_admin_required");
    expect(tenta(CLI)).toContain("platform_admin_required");
    expect(tenta("a0740000-0000-4000-8000-0000000000ff")).toContain("platform_admin_required");
  });

  it("usuário inexistente, organização inexistente e remoção de quem não é da agência são recusados", () => {
    expect(
      erro(`
        ${CRIA_ORG}
        ${COMO_SERVICO}
        select public.fn_membro_da_agencia_definir((select org from ctx),'ninguem-0974@invariant.test',true,'${PA}');
      `),
    ).toContain("usuario_nao_encontrado");
    expect(
      erro(`
        ${COMO_SERVICO}
        select public.fn_membro_da_agencia_definir('a0740000-0000-4000-8000-0000000000fe','ag-0974@invariant.test',true,'${PA}');
      `),
    ).toContain("organizacao_nao_encontrada");
    expect(
      erro(`
        ${CRIA_ORG}
        insert into public.user_organizations(user_id,organization_id,role,accepted_at) values ('${VIEWER}',(select org from ctx),'viewer',now());
        ${COMO_SERVICO}
        select public.fn_membro_da_agencia_definir((select org from ctx),'viewer-0974@invariant.test',false,'${PA}');
      `),
    ).toContain("membro_da_agencia_nao_encontrado");
  });

  it("remover o último admin da organização é recusado (a agência é o único admin até o cliente aceitar)", () => {
    expect(
      erro(`
        ${CRIA_ORG}
        ${COMO_SERVICO}
        select public.fn_membro_da_agencia_definir((select org from ctx),'pa-0974@invariant.test',false,'${PA}');
      `),
    ).toContain("organizacao_sem_admin");
  });

  it("a função não é alcançável por anon, authenticated nem PUBLIC (as duas origens de EXECUTE)", () => {
    const l = prova(`
      select 'SONDA|' || has_function_privilege('anon','public.fn_membro_da_agencia_definir(uuid,text,boolean,uuid)','execute')
        || '|' || has_function_privilege('authenticated','public.fn_membro_da_agencia_definir(uuid,text,boolean,uuid)','execute')
        || '|' || has_function_privilege('service_role','public.fn_membro_da_agencia_definir(uuid,text,boolean,uuid)','execute')
        || '|' || exists(select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                          where p.oid='public.fn_membro_da_agencia_definir(uuid,text,boolean,uuid)'::regprocedure
                            and a.grantee = 0);
    `);
    expect(l).toEqual(["false|false|true|false"]);
  });
});

describe("membro da agência: o cliente não mexe nele", () => {
  const COM_AGENCIA = `
    ${CRIA_ORG}
    select public.fn_accept_team_invite('${CLI}',(select org from ctx),'admin','${PA}',now()-interval '1 minute',now()-interval '1 minute','{"preset":"completa"}'::jsonb);
  `;

  it("o admin do cliente não apaga o vínculo da agência pela REST", () => {
    const e = erro(`
      ${COM_AGENCIA}
      ${COMO(CLI)}
      delete from public.user_organizations where user_id='${PA}' and organization_id=(select org from ctx);
    `);
    expect(e).toContain("só sai pelo painel da plataforma");
  });

  it("o admin do cliente não desmarca, não rebaixa nem revoga a agência pela REST", () => {
    for (const alteracao of [
      "membro_da_agencia = false",
      "role = 'viewer'",
      "revoked_at = now()",
    ]) {
      const e = erro(`
        ${COM_AGENCIA}
        ${COMO(CLI)}
        update public.user_organizations set ${alteracao}
          where user_id='${PA}' and organization_id=(select org from ctx);
      `);
      expect(e, alteracao).toMatch(/só pode ser gravado pelo servidor|permission denied|violates row-level security/);
    }
  });

  it("o admin do cliente não cria um membro da agência pela REST, nem para si", () => {
    const e = erro(`
      ${COM_AGENCIA}
      ${COMO(CLI)}
      update public.user_organizations set membro_da_agencia = true
        where user_id='${CLI}' and organization_id=(select org from ctx);
    `);
    expect(e).toContain("membro_da_agencia só pode ser gravado pelo servidor");
    const e2 = erro(`
      ${COM_AGENCIA}
      insert into public.organizations(id,slug,legal_name,display_name) values ('${ORG_OUTRA}','outra-0974','Outra','Outra');
      ${COMO(PA)}
      insert into public.user_organizations(user_id,organization_id,role,accepted_at,membro_da_agencia)
        values ('${PA}','${ORG_OUTRA}','admin',now(),true);
    `);
    expect(e2).toContain("membro_da_agencia só pode ser gravado pelo servidor");
  });

  it("o próprio membro da agência não se desmarca nem se apaga pela REST", () => {
    const e = erro(`
      ${COM_AGENCIA}
      ${COMO(PA)}
      update public.user_organizations set membro_da_agencia = false
        where user_id='${PA}' and organization_id=(select org from ctx);
    `);
    expect(e).toContain("membro_da_agencia só pode ser gravado pelo servidor");
  });

  it("a cascata da organização apagada não é barrada pelo vínculo da agência", () => {
    const l = prova(`
      ${COM_AGENCIA}
      delete from public.organizations where id=(select org from ctx);
      select 'SONDA|restou=' || count(*) from public.user_organizations where user_id='${PA}';
    `);
    expect(l).toEqual(["restou=0"]);
  });
});

describe("membro da agência: isolamento entre organizações (RLS)", () => {
  it("a agência (que não é admin da plataforma) vê só a organização em que tem vínculo e nada da outra", () => {
    const l = prova(`
      ${CRIA_ORG}
      insert into public.organizations(id,slug,legal_name,display_name) values ('${ORG_OUTRA}','outra-0974','Outra','Outra');
      insert into public.user_organizations(user_id,organization_id,role,accepted_at) values ('${OUTRO}','${ORG_OUTRA}','admin',now());
      ${COMO_SERVICO}
      select public.fn_membro_da_agencia_definir((select org from ctx),'ag-0974@invariant.test',true,'${PA}');
      reset role;
      ${COMO(AG)}
      select 'SONDA|orgs=' || count(*) from public.organizations where slug in ('cliente-0974','outra-0974');
      select 'SONDA|vinculos_da_outra=' || count(*) from public.user_organizations where organization_id='${ORG_OUTRA}';
      reset role;
      ${COMO(OUTRO)}
      select 'SONDA|outro_ve_a_agencia=' || count(*) from public.user_organizations where user_id='${AG}';
    `);
    expect(l).toEqual(["orgs=1", "vinculos_da_outra=0", "outro_ve_a_agencia=0"]);
  });
});
