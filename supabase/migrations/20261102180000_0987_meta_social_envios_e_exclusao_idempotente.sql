-- 0987 · Canal social oficial da Meta (0984): o eco do próprio envio e o
-- pedido de exclusão de dados idempotente.
--
-- ─── meta_social_envios ─────────────────────────────────────────────────────
-- Todo `mid` que a Meta devolve num envio NOSSO (cada pedaço de um texto longo
-- e a imagem), gravado pelo adapter na hora do envio. A ingestão pergunta
-- "este mid é nosso?" antes de tratar o eco como resposta dada pelo celular.
-- Sem isto só o mid do ÚLTIMO pedaço era conhecido (vira `messages.external_id`)
-- e, quando o eco chega sem `app_id`, o dos pedaços anteriores entrava como
-- mensagem "do celular": linha duplicada e IA pausada.
-- Chave `(organization_id, mid)`: é a pergunta exata da ingestão. Retenção
-- curta (o eco chega em segundos): o cron diário `meta-social-tokens` poda o
-- que passou de 7 dias, pelo índice de `created_at`.
-- Só o servidor lê e escreve (service role). RLS ligada, zero policies e
-- nenhum grant a anon/authenticated: o PostgREST não a serve.
--
-- ─── meta_data_deletion_requests ────────────────────────────────────────────
-- Um pedido ABERTO por `(platform, meta_user_id)` — índice único parcial. A
-- Meta reentrega o mesmo pedido; a reentrega devolve o mesmo código, sem linha
-- nova. Antes de criar o índice, repetidos abertos da mesma pessoa e rede são
-- removidos, ficando o mais antigo (são o mesmo pedido; o código que a página
-- de status mostra não é consultado no banco).
--
-- Nenhuma função nova em `public`: o item 9 da doutrina não é acionado.
-- Idempotente: re-aplicável sem efeito novo.

create table if not exists public.meta_social_envios (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  mid text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, mid)
);

create index if not exists meta_social_envios_created_at_idx
  on public.meta_social_envios (created_at);

comment on table public.meta_social_envios is
  '0987: mids devolvidos pela Meta nos envios desta instalação (canal meta_social), para reconhecer o eco do próprio envio. Retenção de 7 dias (cron meta-social-tokens). Server-side only.';

alter table public.meta_social_envios enable row level security;

-- Deny-all, como `platform_meta_app` e `ad_platform_connections`: RLS ligada,
-- ZERO policies e nenhum grant a anon/authenticated. Nenhuma tela lê isto pelo
-- client de sessão; o servidor filtra `organization_id` à mão.
drop policy if exists tenant_isolation_meta_social_envios_all on public.meta_social_envios;

revoke all on public.meta_social_envios from anon, authenticated;
grant select, insert, delete on public.meta_social_envios to service_role;

-- As travas do modo somente leitura do suporte alcançam a tabela nova.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

delete from public.meta_data_deletion_requests r
 where r.status = 'received'
   and exists (
     select 1 from public.meta_data_deletion_requests o
      where o.status = 'received'
        and o.platform = r.platform
        and o.meta_user_id = r.meta_user_id
        and (o.received_at, o.id) < (r.received_at, r.id)
   );

create unique index if not exists meta_data_deletion_requests_aberto_uidx
  on public.meta_data_deletion_requests (platform, meta_user_id)
  where status = 'received';

notify pgrst, 'reload schema';
