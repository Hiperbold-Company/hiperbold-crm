-- 0984 · Instagram Direct e Messenger pela conexão OFICIAL e DIRETA com a Meta
-- (Instagram API com login do Instagram e Messenger Platform da Página), sem
-- intermediário. Provider novo `meta_social`, paralelo ao `zernio_social`, que
-- fica intocado.
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- * `channel_sessions`: seis colunas do provider novo (rede, id da conta, @,
--   token cifrado, vencimento e última renovação do token). Todas nullable:
--   nenhuma linha existente as viola, nada a corrigir antes das constraints.
-- * `meta_social` nos dois CHECKs de provider. O ramo do ref exige a conta e a
--   rede: é por `(rede, conta)` que o webhook encontra a sessão.
-- * Índice único PARCIAL `(rede, conta)` entre as sessões não arquivadas do
--   provider. O webhook da Meta é UM endereço da instalação, e a organização sai
--   da sessão achada pelo `entry.id` (assinado pelo App Secret). Duas
--   organizações com a mesma conta ativa tornariam essa resolução ambígua —
--   então a segunda conexão é recusada (`conta_em_outra_organizacao`).
--   Arquivar (`archived_at`, migration 0106) libera a conta.
-- * `platform_meta_app`: `app_id`, `instagram_app_id` e
--   `instagram_app_secret_encrypted`. A 0257 deixou o `app_id` de fora porque
--   nenhum leitor o consumia — "coluna especulativa". Agora há leitor (o OAuth
--   deste canal precisa do id dos dois apps), então o motivo deixou de valer. Os
--   ids não são segredo, mas moram ao lado do segredo do mesmo app para a tela
--   da instalação configurar o canal sem SSH; o `.env` (META_APP_ID,
--   INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET) segue como piso de rollback, na mesma
--   ordem de `lib/channels/meta/app.ts`: banco primeiro.
-- * `meta_data_deletion_requests`: o pedido de exclusão de dados que a Meta
--   manda ao callback da instalação (quem removeu o app). É da INSTALAÇÃO, não
--   de um tenant: o `user_id` que a Meta manda não carrega organização. Por isso
--   não usa `lgpd_requests` (que exige organização e dispara a cascata de
--   anonimização de contato, que é outra coisa). RLS ligada SEM policy e grants
--   revogados de anon/authenticated, como `platform_meta_app`: só o servidor lê.
--
-- ─── O que não entra ────────────────────────────────────────────────────────
-- * `conversations.channel`: o CHECK já aceita 'instagram' e 'facebook' (0368),
--   o mesmo vocabulário que o canal intermediado grava.
-- * Nenhuma função nova em `public`: o item 9 da doutrina não é acionado.
--
-- Idempotente: re-aplicável sem efeito novo.

alter table public.channel_sessions
  add column if not exists meta_social_platform text,
  add column if not exists meta_social_account_id text,
  add column if not exists meta_social_username text,
  add column if not exists meta_social_token_encrypted bytea,
  add column if not exists meta_social_token_expires_at timestamptz,
  add column if not exists meta_social_token_refreshed_at timestamptz;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_meta_social_platform_check;
alter table public.channel_sessions
  add constraint channel_sessions_meta_social_platform_check
  check (meta_social_platform is null or meta_social_platform in ('instagram', 'messenger'));

comment on column public.channel_sessions.meta_social_account_id is
  'Id da conta profissional do Instagram (user_id de /me) ou da Página do Facebook. É o entry[].id do webhook da Meta e o sessionRef do provider meta_social.';
comment on column public.channel_sessions.meta_social_token_encrypted is
  'Token de acesso da conta (Instagram: token longo de 60 dias, renovado pelo cron meta-social-tokens; Messenger: token de Página, sem vencimento). Cifrado por fn_encrypt_oauth.';

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'wacalls'::text, 'zernio_social'::text, 'uazapi'::text, 'datafy'::text, 'meta_social'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls'    and wacalls_session_id    is not null) or
    (provider = 'uazapi'     and uazapi_instance_id   is not null and uazapi_base_url is not null) or
    (provider = 'datafy'     and datafy_phone_number_id is not null) or
    (provider = 'meta_social' and meta_social_account_id is not null and meta_social_platform is not null)
  );

create unique index if not exists channel_sessions_meta_social_conta_ativa_uidx
  on public.channel_sessions (meta_social_platform, meta_social_account_id)
  where provider = 'meta_social' and archived_at is null;

alter table public.platform_meta_app
  add column if not exists app_id text,
  add column if not exists instagram_app_id text,
  add column if not exists instagram_app_secret_encrypted bytea;

comment on column public.platform_meta_app.instagram_app_secret_encrypted is
  'Segredo do app do Instagram (Instagram API com login do Instagram), cifrado por fn_encrypt_oauth. Troca o código do OAuth e pode assinar o webhook do Instagram.';

create table if not exists public.meta_data_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  confirmation_code text not null unique,
  platform text not null check (platform in ('instagram', 'messenger')),
  meta_user_id text not null,
  status text not null default 'received' check (status in ('received', 'completed')),
  issued_at timestamptz,
  received_at timestamptz not null default now(),
  completed_at timestamptz
);

comment on table public.meta_data_deletion_requests is
  'Pedido de exclusão de dados recebido pelo callback da Meta (POST /api/v1/meta/exclusao-de-dados). Da instalação, sem organização. Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated.';

alter table public.meta_data_deletion_requests enable row level security;
revoke all on public.meta_data_deletion_requests from anon, authenticated;
grant select, insert, update on public.meta_data_deletion_requests to service_role;

notify pgrst, 'reload schema';
