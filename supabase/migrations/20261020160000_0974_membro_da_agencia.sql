-- 0974, membro da agência: vínculo permanente que não ocupa vaga do plano e não sai na entrega (fork Hiperbold, pedido do dono do produto, 20/10/2026).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. Quem cria a organização pelo painel entrava como admin PROVISÓRIO
-- (`provisional_until_handover`, 0237): não contava vaga, mas o bloco "O DONO ASSUMIU" de
-- `fn_accept_team_invite` apaga todo vínculo provisório quando o primeiro convidado admin aceita.
-- Em produção o dono da Hiperbold perdeu o acesso à organização da cliente assim que o primeiro
-- admin dela aceitou. A agência que opera o CRM precisa de um vínculo que sobreviva à entrega.
--
-- O que muda.
--   1. `user_organizations.membro_da_agencia boolean not null default false` (DIRC: vive aqui, não é
--      tabela nem derivado). Vínculo comum em tudo (papel, seletor de organizações, RLS), com três
--      diferenças: não conta vaga do plano, `fn_accept_team_invite` não o apaga (ela só apaga
--      `provisional_until_handover`, e este vínculo nunca é provisório) e o cliente não o remove.
--   2. `fn_billing_uso`, `fn_billing_pode_criar` e `fn_billing_trava_user_organizations`
--      (as únicas que contam 'membros'; `fn_billing_conferir_teto` e `fn_billing_bloqueia` delegam)
--      passam a excluir `membro_da_agencia`, na ÚLTIMA definição de cada uma.
--      `fn_billing_convite_ja_tem_vinculo_ativo` fica como está: convite para o e-mail de quem já tem
--      vínculo de agência não ocupa vaga, que é o resultado certo.
--   3. `trg_user_orgs_agencia_so_servidor`: só o servidor (fn_billing_e_servidor) grava a coluna ou
--      apaga a linha de um membro da agência. Sem isto o admin do cliente, que tem DELETE pela policy
--      `user_orgs_delete` e UPDATE de qualquer coluna pela `user_orgs_update`, removia a agência
--      pela REST. A 0929 já barra papel e revogação; as rotas de equipe recusam no código.
--   4. `fn_membro_da_agencia_definir(p_org, p_user_email, p_ativo, p_actor)`: a ÚNICA porta para marcar
--      e remover. Confere admin da plataforma de escopo `full` pelo ator em parâmetro (mesmo padrão de
--      `fn_create_tenant_with_owner`), exige usuário já existente em auth.users, cria o vínculo
--      (admin, aceito agora) ou marca o existente (reativa, promove a admin, tira o provisório),
--      e grava `agency_member.added` / `agency_member.removed` em `api_audit_log`. Remover é revogar
--      (`revoked_at`, o que dispara a liberação das conversas e mata as chaves de API dele) e tirar a
--      marca; não apaga a linha. Recusa deixar a organização sem admin (23514, pela 0929).
--      SECURITY DEFINER; revoke das duas origens de EXECUTE; só service_role.
--   5. `fn_create_tenant_with_owner`: quando o dono informado é OUTRA pessoa, o criador nasce
--      `membro_da_agencia` (antes: provisório). Dono = o próprio criador segue como estava.
--
-- Os vínculos provisórios que já existem (criados antes desta migration) continuam sendo apagados na
-- entrega, como antes: quem quiser mantê-los marca pela função do item 4.
--
-- Idempotente: add column if not exists, create or replace, drop trigger if exists antes de recriar.
-- `lock_timeout` de sessão (D-084, B3) para o ALTER/CREATE TRIGGER desistirem em 5s em vez de
-- enfileirar escrita atrás de uma transação longa; o reaplicar tenta de novo.

set lock_timeout = '5s';

alter table public.user_organizations
  add column if not exists membro_da_agencia boolean not null default false;

reset lock_timeout;

comment on column public.user_organizations.membro_da_agencia is
  '0974: vínculo da agência que opera o CRM da organização. Permanente (fn_accept_team_invite só apaga provisional_until_handover), não ocupa vaga do plano (fn_billing_uso / fn_billing_pode_criar / fn_billing_trava_user_organizations o excluem) e só o servidor grava a coluna ou apaga a linha (trg_user_orgs_agencia_so_servidor). Marcar e remover: fn_membro_da_agencia_definir, só admin da plataforma de escopo full.';

-- 1. Contagem de membros do plano: a agência não ocupa vaga.
create or replace function public.fn_billing_uso(p_org uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_funis bigint;
  v_etapas_por_funil bigint;
  v_leads bigint;
  v_membros bigint;
  v_conexoes bigint;
  v_integracoes_webhook bigint;
begin
  select count(*) into v_funis
  from public.crm_pipelines
  where organization_id = p_org and is_archived = false;

  select coalesce(max(t.qtd), 0) into v_etapas_por_funil
  from (
    select p.id, count(s.id) filter (where s.is_archived = false) as qtd
    from public.crm_pipelines p
    left join public.crm_stages s on s.pipeline_id = p.id
    where p.organization_id = p_org and p.is_archived = false
    group by p.id
  ) t;

  select coalesce(buc.valor, 0) into v_leads
  from public.billing_usage_counters buc
  where buc.organization_id = p_org and buc.item = 'leads';
  v_leads := coalesce(v_leads, 0);

  select
    (
      select count(*) from public.user_organizations uo
      where uo.organization_id = p_org
        and uo.accepted_at is not null
        and uo.revoked_at is null
        and not uo.provisional_until_handover
        and not uo.membro_da_agencia
    )
    +
    (
      -- Fase F3 (migration 0907, decisão 4, último parágrafo): sem o filtro
      -- de fn_billing_convite_ja_tem_vinculo_ativo, o instante do aceite (o
      -- convite ainda pendente, aplicar-convite.ts só marca accepted_at
      -- DEPOIS do RPC, mais o vínculo já ativo) contaria o MESMO ocupante
      -- duas vezes.
      select count(*) from public.team_invites ti
      where ti.organization_id = p_org
        and ti.accepted_at is null
        and ti.revoked_at is null
        and ti.expires_at > now()
        and not public.fn_billing_convite_ja_tem_vinculo_ativo(ti.id)
    )
  into v_membros;

  select count(*) into v_conexoes
  from public.channel_sessions
  where organization_id = p_org and archived_at is null;

  select count(*) into v_integracoes_webhook
  from public.webhook_sources
  where organization_id = p_org and is_active = true;

  return jsonb_build_object(
    'funis', v_funis,
    'etapas_por_funil', v_etapas_por_funil,
    'leads', v_leads,
    'membros', v_membros,
    'conexoes', v_conexoes,
    'integracoes_webhook', v_integracoes_webhook
  );
end;
$$;

create or replace function public.fn_billing_pode_criar(p_org uuid, p_item text, p_pipeline uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tetos jsonb;
  v_teto integer;
  v_atual bigint;
  v_pode boolean;
  v_motivo text;
begin
  if p_item not in ('funis', 'etapas_por_funil', 'leads', 'membros', 'conexoes', 'integracoes_webhook') then
    raise exception 'billing_item_desconhecido' using errcode = '22023';
  end if;

  v_tetos := public.fn_billing_limites_efetivos(p_org);
  v_teto := (v_tetos ->> p_item)::integer;

  if v_teto is null then
    return jsonb_build_object('pode', true, 'motivo', 'sem_limite', 'atual', null, 'teto', null);
  end if;

  if p_item = 'funis' then
    select count(*) into v_atual
    from public.crm_pipelines
    where organization_id = p_org and is_archived = false;
  elsif p_item = 'etapas_por_funil' then
    if p_pipeline is null then
      raise exception 'billing_pipeline_obrigatorio_para_etapas_por_funil' using errcode = '22023';
    end if;

    select count(*) into v_atual
    from public.crm_stages
    where pipeline_id = p_pipeline and organization_id = p_org and is_archived = false;
  elsif p_item = 'leads' then
    select coalesce(valor, 0) into v_atual
    from public.billing_usage_counters
    where organization_id = p_org and item = 'leads';
    v_atual := coalesce(v_atual, 0);
  elsif p_item = 'membros' then
    select
      (
        select count(*) from public.user_organizations uo
        where uo.organization_id = p_org
          and uo.accepted_at is not null
          and uo.revoked_at is null
          and not uo.provisional_until_handover
          and not uo.membro_da_agencia
      )
      +
      (
        -- Fase F3 (migration 0907, decisão 4, último parágrafo): mesmo filtro
        -- de fn_billing_uso, acima, para o instante do aceite não contar o
        -- mesmo ocupante duas vezes (convite ainda pendente + vínculo já
        -- ativo).
        select count(*) from public.team_invites ti
        where ti.organization_id = p_org
          and ti.accepted_at is null
          and ti.revoked_at is null
          and ti.expires_at > now()
          and not public.fn_billing_convite_ja_tem_vinculo_ativo(ti.id)
      )
    into v_atual;
  elsif p_item = 'conexoes' then
    select count(*) into v_atual
    from public.channel_sessions
    where organization_id = p_org and archived_at is null;
  elsif p_item = 'integracoes_webhook' then
    select count(*) into v_atual
    from public.webhook_sources
    where organization_id = p_org and is_active = true;
  end if;

  v_pode := v_atual < v_teto;
  v_motivo := case when v_pode then 'ok' else 'teto_atingido' end;

  return jsonb_build_object('pode', v_pode, 'motivo', v_motivo, 'atual', v_atual, 'teto', v_teto);
end;
$$;

create or replace function public.fn_billing_trava_user_organizations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_novo_ativo boolean;
  v_antigo_ativo boolean;
  v_invited_by_antigo uuid;
  v_invited_at_antigo timestamptz;
  v_convite_ja_ocupava_a_vaga boolean;
begin
  v_novo_ativo := new.accepted_at is not null and new.revoked_at is null and not new.provisional_until_handover
    and not new.membro_da_agencia;

  if tg_op = 'INSERT' then
    v_antigo_ativo := false;
    v_invited_by_antigo := null;
    v_invited_at_antigo := null;
  else
    v_antigo_ativo := old.accepted_at is not null and old.revoked_at is null and not old.provisional_until_handover
      and not old.membro_da_agencia;
    v_invited_by_antigo := old.invited_by;
    v_invited_at_antigo := old.invited_at;
  end if;

  if v_novo_ativo and not v_antigo_ativo then
    -- Isenção 1 da 0907: existe convite pendente e válido para o e-mail deste
    -- usuário nesta organização. Guardada numa variável porque agora decide
    -- DUAS coisas: liberar o bloqueio (como antes) e dispensar a conferência
    -- de aviso abaixo (0912): o convite já ocupava a vaga.
    v_convite_ja_ocupava_a_vaga :=
      public.fn_billing_convite_pendente_do_membro(new.organization_id, new.user_id);

    if not (
      v_convite_ja_ocupava_a_vaga
      or public.fn_billing_veio_de_aceite_de_convite(
        new.invited_by, new.invited_at, v_invited_by_antigo, v_invited_at_antigo, tg_op = 'INSERT'
      )
      or public.fn_billing_dono_do_provisionamento(new.organization_id, new.user_id, new.role)
    ) then
      if public.fn_billing_bloqueia(new.organization_id, 'membros', null) then
        raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'membros';
      end if;
    end if;

    -- 0912: só confere o teto (e avisa) quando o vínculo SOMA um ocupante. Com
    -- convite pendente do mesmo e-mail a pessoa já estava contada como convite,
    -- e neste BEFORE INSERT o vínculo novo ainda não é visível: conferir aqui
    -- contaria a mesma pessoa duas vezes.
    if not v_convite_ja_ocupava_a_vaga then
      perform public.fn_billing_conferir_teto(new.organization_id, 'membros', null);
    end if;
  end if;

  return new;
end;
$$;

-- 2. Só o servidor grava a marca ou apaga o vínculo de um membro da agência.
-- security definer pelo mesmo motivo de fn_user_orgs_so_servidor_grava_vinculo (0929):
-- fn_billing_e_servidor só tem execute para service_role e o gatilho roda com o papel de quem grava.
create or replace function public.fn_user_orgs_agencia_so_servidor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.fn_billing_e_servidor() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    if new.membro_da_agencia then
      raise exception 'membro_da_agencia só pode ser gravado pelo servidor' using errcode = '42501';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.membro_da_agencia is distinct from old.membro_da_agencia then
      raise exception 'membro_da_agencia só pode ser gravado pelo servidor' using errcode = '42501';
    end if;
    return new;
  end if;

  -- DELETE. A cascata da organização ou do usuário nunca é barrada (mesma exceção da 0929).
  if old.membro_da_agencia
     and exists (select 1 from public.organizations where id = old.organization_id)
     and exists (select 1 from auth.users where id = old.user_id) then
    raise exception 'o vínculo de membro da agência só sai pelo painel da plataforma' using errcode = '42501';
  end if;
  return old;
end;
$$;

comment on function public.fn_user_orgs_agencia_so_servidor() is
  '0974: recusa (42501) gravar user_organizations.membro_da_agencia, ou apagar a linha de um membro da agência, fora do servidor (fn_billing_e_servidor). A cascata da organização ou do usuário passa. A troca de papel e a revogação por quem não é o servidor já são barradas pela 0929; as rotas de equipe recusam o membro da agência no código.';

revoke execute on function public.fn_user_orgs_agencia_so_servidor() from public, anon, authenticated;
grant execute on function public.fn_user_orgs_agencia_so_servidor() to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_user_orgs_agencia_so_servidor() from agent_worker';
  end if;
end
$$;

set lock_timeout = '5s';

drop trigger if exists trg_user_orgs_agencia_so_servidor on public.user_organizations;
create trigger trg_user_orgs_agencia_so_servidor
  before insert or update of membro_da_agencia or delete on public.user_organizations
  for each row
  execute function public.fn_user_orgs_agencia_so_servidor();

reset lock_timeout;

-- 3. A porta única para marcar e remover o membro da agência.
create or replace function public.fn_membro_da_agencia_definir(
  p_org uuid,
  p_user_email text,
  p_ativo boolean,
  p_actor uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_user uuid;
  v_vinculo public.user_organizations%rowtype;
  v_id uuid;
  v_acao text;
begin
  if p_org is null or p_actor is null or p_ativo is null
     or p_user_email is null or btrim(p_user_email) = '' then
    raise exception 'membro_da_agencia_argumento_invalido' using errcode = '22023';
  end if;

  -- Só o admin da plataforma de escopo full, pelo ator em parâmetro (o mesmo corpo de
  -- fn_create_tenant_with_owner). A server action confere de novo o escopo e o segundo fator.
  if not exists (
    select 1 from public.platform_admins
    where user_id = p_actor and revoked_at is null and scope = 'full'
  ) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;

  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'organizacao_nao_encontrada' using errcode = 'P0002';
  end if;

  v_email := lower(btrim(p_user_email));
  select au.id into v_user from auth.users au where lower(au.email) = v_email limit 1;
  if v_user is null then
    raise exception 'usuario_nao_encontrado' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('membro_da_agencia:' || p_org::text, 0));

  select * into v_vinculo from public.user_organizations
    where organization_id = p_org and user_id = v_user
    for update;

  if p_ativo then
    if not found then
      insert into public.user_organizations
        (organization_id, user_id, role, accepted_at, invited_by, interface_settings, membro_da_agencia)
      values
        (p_org, v_user, 'admin', now(), p_actor, '{"preset":"completa"}'::jsonb, true)
      returning id into v_id;
      v_acao := 'criado';
    elsif v_vinculo.membro_da_agencia and v_vinculo.revoked_at is null and v_vinculo.role = 'admin' then
      v_id := v_vinculo.id;
      v_acao := 'ja_era';
    else
      update public.user_organizations
         set membro_da_agencia = true,
             role = 'admin',
             revoked_at = null,
             accepted_at = coalesce(accepted_at, now()),
             provisional_until_handover = false,
             updated_at = now()
       where id = v_vinculo.id;
      v_id := v_vinculo.id;
      v_acao := 'marcado';
    end if;
  else
    if not found or not v_vinculo.membro_da_agencia then
      raise exception 'membro_da_agencia_nao_encontrado' using errcode = 'P0002';
    end if;
    -- Remover é revogar e tirar a marca, não apagar a linha: o gatilho de rota libera as conversas
    -- abertas dele e a chave de API morre com o vínculo. A 0929 recusa deixar a organização sem admin.
    update public.user_organizations
       set membro_da_agencia = false,
           revoked_at = coalesce(revoked_at, now()),
           updated_at = now()
     where id = v_vinculo.id;
    v_id := v_vinculo.id;
    v_acao := 'removido';
  end if;

  if v_acao <> 'ja_era' then
    insert into public.api_audit_log
      (organization_id, actor_user_id, acting_as_platform_admin, action, resource_type, resource_id, bypassed_rls, metadata)
    values (
      p_org, p_actor, true,
      case when p_ativo then 'agency_member.added' else 'agency_member.removed' end,
      'membership', v_id, true,
      jsonb_build_object('target_user_id', v_user, 'acao', v_acao)
    );
  end if;

  return jsonb_build_object(
    'id', v_id,
    'user_id', v_user,
    'acao', v_acao,
    'membro_da_agencia', p_ativo
  );
end;
$$;

comment on function public.fn_membro_da_agencia_definir(uuid, text, boolean, uuid) is
  '0974: marca (p_ativo = true) ou remove (false) o membro da agência de uma organização. Só admin da plataforma de escopo full (42501 platform_admin_required); usuário precisa existir em auth.users (P0002 usuario_nao_encontrado). Marcar cria o vínculo admin aceito agora ou promove o existente (reativa, tira o provisório); remover revoga e tira a marca. Grava agency_member.added / agency_member.removed em api_audit_log. Devolve {id, user_id, acao: criado|marcado|ja_era|removido, membro_da_agencia}. A server action app/actions/admin/membrosDaAgencia.ts confere platform admin full + MFA antes de chamar.';

-- OS DOIS REVOKES (CLAUDE.md, item 9): (A) from public, (B) from anon (default ACL do baseline),
-- e authenticated porque a função é VOLÁTIL e SECURITY DEFINER: alcançável por qualquer logado seria
-- escrita cross-tenant. Só service_role.
revoke execute on function public.fn_membro_da_agencia_definir(uuid, text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.fn_membro_da_agencia_definir(uuid, text, boolean, uuid) to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_membro_da_agencia_definir(uuid, text, boolean, uuid) from agent_worker';
  end if;
end
$$;

-- 4. Quem cria a organização para OUTRA pessoa nasce membro da agência (antes: provisório).
create or replace function public.fn_create_tenant_with_owner(
  p_actor uuid, p_key uuid, p_request jsonb, p_hash text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prior public.idempotency_keys%rowtype;
  org public.organizations%rowtype;
  result jsonb;
  dono_e_outra_pessoa boolean;
begin
  if not exists (select 1 from public.platform_admins where user_id = p_actor
    and revoked_at is null and scope = 'full') then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_key::text, 0));
  select * into prior from public.idempotency_keys
    where key = p_key::text and endpoint = '/api/v1/admin/tenants:' || p_actor::text
      and expires_at > now() and tenant_creation_trusted;
  if found then
    if prior.request_hash <> decode(p_hash, 'hex') then
      raise exception 'idempotency_conflict' using errcode = '22023';
    end if;
    if prior.response_body->>'id' is distinct from prior.organization_id::text
      or not exists (select 1 from public.organizations where id = prior.organization_id and created_by = p_actor) then
      raise exception 'idempotency_provenance_invalid' using errcode = '22023';
    end if;
    return prior.response_body || jsonb_build_object('created', false);
  end if;

  -- A MESMA comparação que já decidia `interface_settings`, agora com nome e
  -- guardada. Era ela que sabia a resposta e não a anotava em lugar nenhum.
  dono_e_outra_pessoa := lower(p_request->>'owner_email') is distinct from
    (select lower(email) from auth.users where id = p_actor);

  insert into public.organizations(display_name, slug, legal_name, cnpj, status, settings, created_by)
    values (p_request->>'display_name', p_request->>'slug', coalesce(nullif(p_request->>'legal_name', ''), p_request->>'display_name'),
      p_request->>'cnpj', 'active', jsonb_build_object('plan', p_request->>'plan'), p_actor)
    returning * into org;
  insert into public.user_organizations(organization_id, user_id, role, accepted_at, interface_settings, membro_da_agencia)
    values (org.id, p_actor, 'admin', now(),
      case when dono_e_outra_pessoa
        then '{"preset":"completa"}'::jsonb
        else coalesce(p_request->'owner_interface_settings', '{"preset":"completa"}'::jsonb) end,
      dono_e_outra_pessoa);
  result := jsonb_build_object('id', org.id, 'slug', org.slug, 'display_name', org.display_name,
    'invite_id', gen_random_uuid(), 'issued_at', floor(extract(epoch from now()))::bigint);
  insert into public.idempotency_keys(organization_id, key, endpoint, request_hash, status_code, response_body, tenant_creation_trusted)
    values (org.id, p_key::text, '/api/v1/admin/tenants:' || p_actor::text,
      decode(p_hash, 'hex'), 201, result, true);
  return result || jsonb_build_object('created', true);
end $$;

revoke execute on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) to service_role;

revoke execute on function public.fn_billing_uso(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_uso(uuid) to service_role;
revoke execute on function public.fn_billing_pode_criar(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_pode_criar(uuid, text, uuid) to service_role;
revoke execute on function public.fn_billing_trava_user_organizations() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_user_organizations() to service_role;

notify pgrst, 'reload schema';
