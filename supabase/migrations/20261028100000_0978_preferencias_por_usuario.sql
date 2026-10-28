-- 0978 — PREFERÊNCIAS POR USUÁRIO (CBEXS, 28/10/2026): a primeira é "quais colunas a tela de
-- Contatos mostra, e em que ordem". Não havia lugar: `user_organizations.interface_settings` é
-- escolha do ADMINISTRADOR sobre o vínculo (e a escrita daquela linha é do admin), e o
-- localStorage não acompanha a pessoa em outro navegador.
--
-- Uma linha por (organização, usuário, chave). Apresentação pura, nunca autorização: nada no
-- servidor lê esta tabela para decidir acesso. A RLS deixa cada um ler e escrever SÓ as próprias
-- linhas, e só nas organizações de que é membro.
--
-- Reaplicável: create ... if not exists, constraints e policies recriadas. Sem função nova: nada
-- a revogar de PUBLIC/anon além da tabela.

create table if not exists public.user_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  chave text not null,
  valor jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_preferences'::regclass
                 and conname = 'user_preferences_chave_valida') then
    alter table public.user_preferences add constraint user_preferences_chave_valida
      check (chave ~ '^[a-z][a-z0-9_.]{0,59}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.user_preferences'::regclass
                 and conname = 'user_preferences_valor_objeto') then
    alter table public.user_preferences add constraint user_preferences_valor_objeto
      check (jsonb_typeof(valor) = 'object' and pg_column_size(valor) <= 16384);
  end if;
end $$;

create unique index if not exists uniq_user_preferences_org_user_chave
  on public.user_preferences (organization_id, user_id, chave);

alter table public.user_preferences enable row level security;

drop policy if exists tenant_isolation_user_preferences_all on public.user_preferences;
create policy tenant_isolation_user_preferences_all on public.user_preferences
  for all
  to authenticated
  using (
    user_id = (select auth.uid())
    and organization_id in (select * from public.fn_user_org_ids())
  )
  with check (
    user_id = (select auth.uid())
    and organization_id in (select * from public.fn_user_org_ids())
  );

-- O default ACL do Supabase dá tudo a anon em tabela nova de public.
revoke all on public.user_preferences from anon;
grant select, insert, update, delete on public.user_preferences to authenticated;

comment on table public.user_preferences is
  '0978: preferência de apresentação por usuário e organização (ex.: chave contatos.colunas). Nunca autorização. RLS: só as próprias linhas, só em organização de que é membro.';

-- As travas do modo somente leitura do suporte alcançam a tabela nova.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
