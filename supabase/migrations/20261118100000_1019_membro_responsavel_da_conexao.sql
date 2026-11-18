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
-- dispara (o mesmo caso que `fn_routing_member_revoked` documenta). Um gatilho próprio zera o vínculo.
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

drop trigger if exists trg_conexao_solta_membro_revogado on public.user_organizations;
create trigger trg_conexao_solta_membro_revogado
  after update of revoked_at on public.user_organizations
  for each row
  when (old.revoked_at is null and new.revoked_at is not null)
  execute function public.fn_conexao_solta_membro_revogado();

grant select (responsible_user_id) on table public.channel_sessions to authenticated;
