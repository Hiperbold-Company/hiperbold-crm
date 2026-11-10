-- manifest: **Cofre de chaves secretas das automações (lote 4, bloco "Requisição HTTP", fork Hiperbold).** Tabela `automacao_segredos` (nome único por organização, `valor_cifrado bytea` com `fn_encrypt_oauth`, `ultimos4` para a tela mostrar ••••1234, `created_by`, `last_used_at`). RLS `tenant_isolation_automacao_segredos_all` (membro gerente+ da própria organização); `revoke all` de anon/authenticated/service_role e depois `select, insert, update, delete` só para `service_role` e SELECT coluna a coluna para `authenticated` SEM `valor_cifrado`. Escrita só pelas rotas `/api/v1/automacoes/segredos` (admin client). Sem função nova. Espelho no apêndice do `supabase/baseline.sql`, antes da varredura de anon; prova em `tests/invariants/automacao-segredos-cofre.test.ts`.
-- ---- automações: cofre de chaves secretas do bloco "Requisição HTTP" (migration 1004, fork Hiperbold) ----
-- 1004 — O bloco "Requisição HTTP" das automações (lote 4) chama outro sistema com uma chave
-- (token de API) que a organização guarda aqui. A chave NUNCA é digitada no grafo: o bloco guarda
-- só o id da linha, e o servidor decifra na hora do envio (service role, filtrando a organização).
--
-- Cifra: a mesma das outras integrações por organização (`fn_encrypt_oauth`, pgp_sym com a chave
-- da GUC `app.nuvemshop_oauth_key`; wrapper `lib/webhooks/secrets.ts`).
--
-- Leitura: só a service role lê `valor_cifrado`. `authenticated` tem SELECT coluna a coluna
-- (sem `valor_cifrado`) e só gerente ou acima da própria organização passa na RLS. Nenhum papel do
-- PostgREST além da service role grava: escrita só pelas rotas `/api/v1/automacoes/segredos`.
-- O revoke começa por `all` nos três papéis porque o default ACL do Supabase concede tudo a
-- anon/authenticated em tabela nova de `public` (ver CLAUDE.md, audit log e 9037).
--
-- Reaplicável: create ... if not exists, constraints conferidas no catálogo, policy recriada,
-- revoke/grant idempotentes. Sem função nova: nada a revogar de PUBLIC/anon além da tabela.

create table if not exists public.automacao_segredos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null,
  valor_cifrado bytea not null,
  ultimos4 text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz
);

do $hb_1004_segredos$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.automacao_segredos'::regclass
                 and conname = 'automacao_segredos_nome_valido') then
    alter table public.automacao_segredos add constraint automacao_segredos_nome_valido
      check (nome ~ '^[a-z][a-z0-9_]{0,39}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.automacao_segredos'::regclass
                 and conname = 'automacao_segredos_ultimos4_curto') then
    alter table public.automacao_segredos add constraint automacao_segredos_ultimos4_curto
      check (char_length(ultimos4) <= 4);
  end if;
end
$hb_1004_segredos$;

create unique index if not exists uniq_automacao_segredos_org_nome
  on public.automacao_segredos (organization_id, nome);

alter table public.automacao_segredos enable row level security;

drop policy if exists tenant_isolation_automacao_segredos_all on public.automacao_segredos;
create policy tenant_isolation_automacao_segredos_all on public.automacao_segredos
  for all
  to authenticated
  using (
    organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
  with check (
    organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );

revoke all on table public.automacao_segredos from anon, authenticated, service_role;
grant select, insert, update, delete on table public.automacao_segredos to service_role;
grant select (id, organization_id, nome, ultimos4, created_by, created_at, updated_at, last_used_at)
  on table public.automacao_segredos to authenticated;

comment on table public.automacao_segredos is
  '1004: chaves secretas das automações (bloco Requisição HTTP). valor_cifrado com fn_encrypt_oauth; só a service role o lê. authenticated: SELECT sem valor_cifrado, gerente+ da própria organização.';
comment on column public.automacao_segredos.valor_cifrado is
  '1004: a chave cifrada (fn_encrypt_oauth). Nunca em claro, nunca com grant a anon/authenticated.';
comment on column public.automacao_segredos.ultimos4 is
  '1004: os 4 últimos caracteres da chave — o que a tela mostra (••••1234), nunca a chave inteira.';

notify pgrst, 'reload schema';

