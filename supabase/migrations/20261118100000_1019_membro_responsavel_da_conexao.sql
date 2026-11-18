-- 1019, o membro responsável pela conexão (fork Hiperbold, pedido do dono do produto em 18/11/2026).
--
-- Cada conexão (channel_sessions) ganha `responsible_user_id`: UM membro da equipe a quem a conexão
-- pertence (ou nenhum). Um membro pode ter várias conexões; uma conexão, no máximo um membro. É o
-- que marca, por padrão, o seletor de conexão do painel do negócio ("Abrir conversa no Chat do CRM").
--
-- NÃO é o responsável do roteamento (`channel_routing_responsibles`, Configurações › Atendimento):
-- aquele decide a distribuição das conversas e o modo "só a conexão própria"; este só escolhe o
-- padrão do seletor. Nada de permissão lê esta coluna.
--
-- Mesma organização POR CONSTRUÇÃO: a chave estrangeira é composta, (responsible_user_id,
-- organization_id) → user_organizations (user_id, organization_id). Um membro de outra empresa não
-- cabe na coluna, nem por gravação à mão. Apagar o vínculo do membro zera só a coluna do membro.
--
-- Membro removido: a remoção é UPDATE de `revoked_at`, não DELETE, então o `on delete set null` não
-- dispara (o mesmo caso que `fn_routing_member_revoked` documenta). Um gatilho próprio zera o vínculo,
-- e zera também quando o membro passa a observador (observador não atende conversa).
--
-- Só o servidor grava: a coluna entra na trava de `fn_channel_sessions_ligacao_ao_provedor_e_do_servidor`
-- (a última definição, a da 9104, mais esta coluna). Sem isso, um administrador gravaria o vínculo
-- direto pela REST, sem a regra de membro ativo e sem auditoria. A gravação é
-- `fn_gravar_membro_da_conexao` (só `service_role`), chamada pela rota `PATCH …/responsible`: a regra
-- "membro ativo e não observador" vale na PRÓPRIA escrita, com a linha do membro travada (`for share`),
-- para a remoção concorrente não deixar um vínculo com quem já saiu.
--
-- Idempotente: coluna `if not exists`; antes da FK, vínculo que não aponta para membro ativo da
-- mesma organização volta a nulo (para o update de um clone nunca quebrar); FK e índice só se não
-- existirem; função `create or replace`; gatilho recriado.
--
-- Grant: `channel_sessions` tem SELECT coluna a coluna para `authenticated` (0948/0998). Coluna nova
-- não entra sozinha nesse grant, então ela é concedida aqui.

alter table public.channel_sessions add column if not exists responsible_user_id uuid;

update public.channel_sessions cs
   set responsible_user_id = null
 where cs.responsible_user_id is not null
   and not exists (
     select 1 from public.user_organizations uo
      where uo.organization_id = cs.organization_id
        and uo.user_id = cs.responsible_user_id
        and uo.revoked_at is null
   );

do $hb_1019_membro_da_conexao$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.channel_sessions'::regclass
       and conname = 'channel_sessions_responsible_member_fkey'
  ) then
    alter table public.channel_sessions
      add constraint channel_sessions_responsible_member_fkey
      foreign key (responsible_user_id, organization_id)
      references public.user_organizations (user_id, organization_id)
      on delete set null (responsible_user_id);
  end if;
end
$hb_1019_membro_da_conexao$;

create index if not exists channel_sessions_responsible_user_idx
  on public.channel_sessions (organization_id, responsible_user_id)
  where responsible_user_id is not null;

comment on column public.channel_sessions.responsible_user_id is
  'Membro responsável pela conexão (um por conexão; nula = nenhum). Só marca o padrão do seletor de conexão do negócio; não dá nem tira permissão. Migration 1019.';

create or replace function public.fn_conexao_solta_membro_revogado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.channel_sessions
     set responsible_user_id = null
   where organization_id = new.organization_id
     and responsible_user_id = new.user_id;
  return new;
end;
$$;

revoke all on function public.fn_conexao_solta_membro_revogado() from public, anon, authenticated;

do $hb_1019_gatilho_do_membro$
begin
  perform set_config('lock_timeout', '3s', true);
  create or replace trigger trg_conexao_solta_membro_revogado
    after update of revoked_at, role on public.user_organizations
    for each row
    when ((old.revoked_at is null and new.revoked_at is not null)
          or (new.role = 'viewer' and old.role is distinct from new.role))
    execute function public.fn_conexao_solta_membro_revogado();
end
$hb_1019_gatilho_do_membro$;

-- A gravação do vínculo. A regra mora na escrita: a conexão é travada (`for update`) e a linha do
-- membro também (`for share`), então uma remoção concorrente espera esta transação e o gatilho acima
-- zera o vínculo logo depois; uma remoção já gravada faz esta devolver `membro_invalido`.
create or replace function public.fn_gravar_membro_da_conexao(p_org uuid, p_canal uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_antes uuid;
begin
  select cs.responsible_user_id into v_antes
    from public.channel_sessions cs
   where cs.organization_id = p_org
     and cs.id = p_canal
     and cs.archived_at is null
   for update;
  if not found then
    return jsonb_build_object('resultado', 'canal_nao_encontrado');
  end if;

  if p_user is not null then
    perform 1
      from public.user_organizations uo
     where uo.organization_id = p_org
       and uo.user_id = p_user
       and uo.revoked_at is null
       and uo.role <> 'viewer'
     for share;
    if not found then
      return jsonb_build_object('resultado', 'membro_invalido');
    end if;
  end if;

  if v_antes is not distinct from p_user then
    return jsonb_build_object('resultado', 'sem_mudanca', 'anterior', v_antes, 'atual', p_user);
  end if;

  update public.channel_sessions
     set responsible_user_id = p_user
   where organization_id = p_org
     and id = p_canal;
  return jsonb_build_object('resultado', 'gravado', 'anterior', v_antes, 'atual', p_user);
end;
$$;

revoke all on function public.fn_gravar_membro_da_conexao(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_gravar_membro_da_conexao(uuid, uuid, uuid) to service_role;

-- A coluna é do servidor: a última definição da trava (9104) mais `responsible_user_id`. O gatilho
-- `trg_channel_sessions_ligacao_ao_provedor_e_do_servidor` (9093) já chama esta função.
create or replace function public.fn_channel_sessions_ligacao_ao_provedor_e_do_servidor()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('authenticated', 'anon') then
    -- `new` é nulo no DELETE: devolvê-lo cancelaria a exclusão do servidor.
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.zernio_credencial_da_instalacao then
      raise exception 'canal_ligacao_ao_provedor_e_do_servidor' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.zernio_credencial_da_instalacao
       or new.zernio_account_id is not null
       or new.zernio_profile_id is not null
       or new.zernio_webhook_id is not null
       -- 9104: a credencial do número oficial também é do servidor.
       or new.meta_token_encrypted is not null
       or new.meta_phone_number_id is not null
       or new.meta_waba_id is not null
       -- 1019: o membro responsável também é do servidor.
       or new.responsible_user_id is not null then
      raise exception 'canal_ligacao_ao_provedor_e_do_servidor' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.zernio_credencial_da_instalacao, new.zernio_account_id, new.zernio_profile_id, new.zernio_webhook_id)
       is distinct from
     (old.zernio_credencial_da_instalacao, old.zernio_account_id, old.zernio_profile_id, old.zernio_webhook_id)
     -- 9104: a credencial do número oficial também é do servidor.
     or (new.meta_token_encrypted, new.meta_phone_number_id, new.meta_waba_id)
       is distinct from
     (old.meta_token_encrypted, old.meta_phone_number_id, old.meta_waba_id)
     -- 1019: o membro responsável também é do servidor.
     or new.responsible_user_id is distinct from old.responsible_user_id
     or (old.zernio_credencial_da_instalacao and
         (new.archived_at, new.provider, new.organization_id, new.phone_number)
           is distinct from
         (old.archived_at, old.provider, old.organization_id, old.phone_number)) then
    raise exception 'canal_ligacao_ao_provedor_e_do_servidor' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_channel_sessions_ligacao_ao_provedor_e_do_servidor() from public, anon, authenticated;

grant select (responsible_user_id) on table public.channel_sessions to authenticated;
