-- ---- exclusão de organização: dados da própria conta não a mantêm (migration 0999, fork Hiperbold) ----
-- 0959 mantém a conta de usuário ainda referenciada por "linha de fora", percorrendo toda chave estrangeira de
-- public para auth.users. Quatro tabelas são dados da PRÓPRIA conta, sem organização, e saem em cascata com
-- ela: user_recovery_codes e mfa_trusted_devices (MFA), email_trocas_aprovadas (D-204) e registration_requests.
-- Contadas como "de fora", elas impediam a remoção de toda conta que tinha MFA, aparelho confiável, troca de
-- e-mail aprovada ou pedido de cadastro. Achado no e2e do merge do upstream de 04/11/2026 (a troca de e-mail
-- pelo admin da plataforma passou a gravar a aprovação). Cria função: fica antes da VARREDURA anon.
create or replace function public.fn_exclusao_executar(p_org uuid, p_actor uuid default null, p_forcar boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog public.org_exclusoes_programadas;
  v_motivo_recusa text;
  v_origem text;
  v_motivo text;
  v_org record;
  v_contatos bigint;
  v_conversas bigint;
  v_mensagens bigint;
  v_negocios bigint;
  v_fiscais integer := 0;
  v_fiscais_pedidos integer := 0;
  v_webhooks bigint := 0;
  v_usuarios uuid[];
  v_usuario uuid;
  v_fk record;
  v_referenciado boolean;
  v_existe boolean;
  v_removidos integer := 0;
  v_mantidos integer := 0;
  v_apagou integer;
begin
  if p_org is null then
    raise exception 'exclusao_dados_invalidos' using errcode = '22023';
  end if;

  -- A exclusão de uma organização é longa por natureza (a cascata passa por centenas de tabelas): o limite de
  -- tempo do papel de API não vale aqui, vale a transação.
  perform set_config('statement_timeout', '0', true);
  perform pg_advisory_xact_lock(hashtextextended('org_exclusao:' || p_org::text, 0));

  -- O contrato é travado ANTES de a elegibilidade ser conferida: uma reativação ou um pagamento que está
  -- gravando agora espera esta transação (ou nós esperamos por ele e enxergamos o contrato novo). Sem isso, a
  -- conferência e o delete eram dois instantes, e o pagamento do cliente cabia entre eles.
  perform 1 from public.billing_contracts where organization_id = p_org for update;

  -- A GUARDA: só se apaga o que está programado, não foi cancelado, já venceu e (a automática) ainda é
  -- elegível e foi avisada; a exclusão forçada do admin dispensa isso.
  v_motivo_recusa := public.fn_exclusao_pode_executar(p_org, p_forcar);
  if v_motivo_recusa <> 'ok' then
    raise exception '%', v_motivo_recusa using errcode = '22023';
  end if;

  select * into v_prog from public.org_exclusoes_programadas where organization_id = p_org for update;
  v_origem := coalesce(v_prog.origem, 'manual');
  v_motivo := coalesce(v_prog.motivo, 'manual');

  select id, legal_name, cnpj into v_org from public.organizations where id = p_org for update;
  if not found then
    raise exception 'exclusao_org_inexistente' using errcode = 'P0002';
  end if;

  -- As contagens do recibo (só números). Antes de apagar.
  select count(*) into v_contatos from public.contacts where organization_id = p_org;
  select count(*) into v_conversas from public.conversations where organization_id = p_org;
  select count(*) into v_mensagens from public.messages where organization_id = p_org;
  select count(*) into v_negocios from public.crm_leads where organization_id = p_org;

  -- (c) Os registros fiscais, copiados ANTES da cascata. Pagamentos primeiro (o livro-caixa), depois os pedidos
  -- pagos que não têm pagamento apontando para eles. Nada de nota livre, usuário ou contato.
  insert into public.billing_registros_fiscais_arquivados
    (organizacao_id_origem, organizacao_razao_social, organizacao_cnpj, fonte, fonte_id, tipo, status, valor_cents,
     pago_em, periodo_inicio, periodo_fim, plano_codigo, plano_nome, ciclo, metodo, ambiente, tokens,
     asaas_payment_id, asaas_subscription_id, asaas_customer_id, estorna_fonte_id)
  select pg.organization_id, v_org.legal_name, v_org.cnpj, 'pagamento', pg.id,
         case when o.id is not null then o.tipo else 'manual' end,
         pg.status, pg.gross_cents, pg.paid_at, pg.billing_period_start, pg.billing_period_end,
         coalesce(po.code, pc.code), coalesce(po.name, pc.name), o.ciclo, o.metodo, o.ambiente, o.tokens,
         pg.asaas_payment_id, o.asaas_subscription_id,
         (select cu.asaas_customer_id from public.billing_customers cu
           where cu.organization_id = pg.organization_id and cu.ambiente = o.ambiente limit 1),
         pg.estorna_pagamento_id
    from public.billing_payments pg
    left join public.billing_orders o on o.id = pg.order_id
    left join public.billing_plans po on po.id = o.plan_id
    left join public.billing_contracts bc on bc.id = pg.contract_id
    left join public.billing_plans pc on pc.id = bc.plan_id
   where pg.organization_id = p_org
  on conflict (fonte, fonte_id) do nothing;
  get diagnostics v_fiscais = row_count;

  insert into public.billing_registros_fiscais_arquivados
    (organizacao_id_origem, organizacao_razao_social, organizacao_cnpj, fonte, fonte_id, tipo, status, valor_cents,
     pago_em, plano_codigo, plano_nome, ciclo, metodo, ambiente, tokens,
     asaas_payment_id, asaas_subscription_id, asaas_customer_id)
  select o.organization_id, v_org.legal_name, v_org.cnpj, 'pedido', o.id, o.tipo, o.status, o.amount_cents,
         o.pago_em, po.code, po.name, o.ciclo, o.metodo, o.ambiente, o.tokens,
         o.asaas_payment_id, o.asaas_subscription_id,
         (select cu.asaas_customer_id from public.billing_customers cu
           where cu.organization_id = o.organization_id and cu.ambiente = o.ambiente limit 1)
    from public.billing_orders o
    left join public.billing_plans po on po.id = o.plan_id
   where o.organization_id = p_org
     and o.pago_em is not null
     and not exists (select 1 from public.billing_payments pg where pg.order_id = o.id)
  on conflict (fonte, fonte_id) do nothing;
  get diagnostics v_fiscais_pedidos = row_count;

  -- Os logs de webhook guardam o corpo bruto das mensagens (dado pessoal de contato) e não têm chave
  -- estrangeira para a organização: a cascata não os alcança.
  delete from public.webhook_events_log where organization_id = p_org;
  get diagnostics v_webhooks = row_count;

  -- Os usuários que pertencem SÓ a esta organização e não são administradores da plataforma (qualquer
  -- vínculo, mesmo revogado, com outra organização mantém a conta).
  select coalesce(array_agg(distinct uo.user_id), '{}') into v_usuarios
    from public.user_organizations uo
   where uo.organization_id = p_org
     and not exists (
       select 1 from public.user_organizations outro
        where outro.user_id = uo.user_id and outro.organization_id <> p_org
     )
     and not exists (select 1 from public.platform_admins pa where pa.user_id = uo.user_id);

  -- (f) A linha final da auditoria, antes de a organização sair: só contagens e o id da organização apagada.
  -- organization_id fica nulo de propósito (a organização não existirá mais); a cascata da organização não
  -- toca esta linha, e a retenção de 5 anos da auditoria é quem a apaga um dia.
  insert into public.api_audit_log
    (organization_id, actor_user_id, acting_as_platform_admin, action, resource_type, resource_id, bypassed_rls, metadata)
  values (
    null, p_actor, p_actor is not null, 'org.data_purged', 'organization', p_org, true,
    jsonb_build_object(
      'organization_id', p_org,
      'origem', v_origem,
      'motivo', v_motivo,
      'forcada', coalesce(p_forcar, false),
      'fim_da_assinatura_em', v_prog.fim_da_assinatura_em,
      'excluir_em', v_prog.excluir_em,
      'contatos', v_contatos,
      'conversas', v_conversas,
      'mensagens', v_mensagens,
      'negocios', v_negocios,
      'registros_fiscais_arquivados', v_fiscais + v_fiscais_pedidos,
      'webhook_logs_apagados', v_webhooks,
      'usuarios_a_remover', coalesce(array_length(v_usuarios, 1), 0)
    )
  );

  -- (e) A organização. Todas as tabelas com organization_id e chave estrangeira saem na cascata; a auditoria
  -- fica (ON DELETE SET NULL).
  delete from public.organizations where id = p_org;

  -- Depois dela, as contas. A conta que ainda é REFERENCIADA por linha de outra organização (ou de qualquer
  -- tabela que sobrou) fica: o catálogo é percorrido, sem lista fixa, em toda chave estrangeira de public para
  -- auth.users cuja exclusão apagaria ou barraria a linha (cascade, no action, restrict). As linhas desta
  -- organização já saíram na cascata acima, então o que ainda aponta para o usuário é de fora. Uma conta que não
  -- puder sair por outro motivo também é mantida e contada: nunca derruba a exclusão da organização.
  foreach v_usuario in array v_usuarios loop
    v_referenciado := false;
    for v_fk in
      select c.conrelid::regclass as tabela, a.attname as coluna
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        join pg_class r on r.oid = c.conrelid
        join pg_namespace n on n.oid = r.relnamespace
       where c.contype = 'f'
         and c.confrelid = 'auth.users'::regclass
         and array_length(c.conkey, 1) = 1
         and c.confdeltype in ('c', 'a', 'r')
         and n.nspname = 'public'
         -- 0999: dados da PRÓPRIA conta (saem em cascata com ela) não são linha de fora. Sem isto, quem
         -- tinha MFA, aparelho confiável, troca de e-mail aprovada ou pedido de cadastro nunca saía.
         and c.conrelid not in (
           'public.user_recovery_codes'::regclass,
           'public.mfa_trusted_devices'::regclass,
           'public.email_trocas_aprovadas'::regclass,
           'public.registration_requests'::regclass
         )
    loop
      execute format('select exists (select 1 from %s where %I = $1)', v_fk.tabela, v_fk.coluna)
        into v_existe using v_usuario;
      if v_existe then
        v_referenciado := true;
        exit;
      end if;
    end loop;
    if v_referenciado then
      v_mantidos := v_mantidos + 1;
      continue;
    end if;

    begin
      delete from auth.users where id = v_usuario;
      get diagnostics v_apagou = row_count;
      if v_apagou > 0 then
        v_removidos := v_removidos + 1;
      else
        v_mantidos := v_mantidos + 1;
      end if;
    exception when others then
      v_mantidos := v_mantidos + 1;
    end;
  end loop;

  return jsonb_build_object(
    'organization_id', p_org,
    'origem', v_origem,
    'motivo', v_motivo,
    'contatos', v_contatos,
    'conversas', v_conversas,
    'mensagens', v_mensagens,
    'negocios', v_negocios,
    'registros_fiscais_arquivados', v_fiscais + v_fiscais_pedidos,
    'webhook_logs_apagados', v_webhooks,
    'usuarios_removidos', v_removidos,
    'usuarios_mantidos', v_mantidos
  );
end;
$$;

revoke execute on function public.fn_exclusao_executar(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_exclusao_executar(uuid, uuid, boolean) to service_role;
