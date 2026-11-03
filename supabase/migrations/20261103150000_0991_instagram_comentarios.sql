-- 0991 · Canal social oficial da Meta (0984): os COMENTÁRIOS do Instagram e a
-- fila de resposta a eles (resposta privada no Direct e resposta pública).
--
-- O canal só oferece as peças; quem decide responder, o quê e quando é a
-- automação (contrato em docs/specs/instagram-comentarios-contrato.md).
--
-- ─── meta_social_comentarios ────────────────────────────────────────────────
-- Um comentário recebido pelo webhook (`changes[].field = "comments"`), por
-- organização. `unique (organization_id, comment_id)`: a Meta reentrega o mesmo
-- comentário, e a reentrega não cria linha nem evento novo.
-- `criado_na_meta_em` é o `entry.time` do aviso: o webhook de comentário não
-- traz a hora de criação do comentário (NÃO CONFIRMADO NA DOC outro campo), e o
-- aviso sai segundos depois dele. `resposta_privada_status` é o estado da ÚNICA
-- resposta privada que a Meta aceita por comentário, em até 7 dias.
--
-- ─── meta_social_fila_de_envio ──────────────────────────────────────────────
-- O que a automação pediu para enviar, consumido pelo cron
-- `meta-social-fila` (a cada minuto) com ritmo por conta. `unique
-- (organization_id, tipo, comment_id)` é a idempotência: um envio por
-- comentário por tipo, e um segundo pedido devolve `ja_pedida`.
-- `enviada_em` mede o teto por hora (o que saiu nos últimos 60 minutos).
--
-- ─── fn_meta_social_registrar_comentario ────────────────────────────────────
-- Grava o comentário E emite `instagram.comentario_recebido` no `event_log`
-- na MESMA transação. Em duas idas, uma falha entre elas deixaria o comentário
-- gravado sem evento, e a reentrega da Meta cairia no 23505 sem emitir nunca.
-- Repetido devolve null e não emite. A sessão tem de ser da organização.
-- Revogada de public e anon (item 9 da doutrina), só service_role executa.
--
-- RLS: policy `tenant_isolation_<tabela>_all` por `fn_user_org_ids()`. A
-- escrita é só do servidor: `authenticated` recebe apenas SELECT (sem grant,
-- a policy de escrita não alcança ninguém), anon nada.
-- Sem trigger e sem HTTP no banco: o envio é do cron.
-- Idempotente: re-aplicável sem efeito novo.

create table if not exists public.meta_social_comentarios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  comment_id text not null,
  media_id text,
  media_product_type text,
  autor_id text not null,
  autor_usuario text,
  texto text,
  criado_na_meta_em timestamptz,
  recebido_em timestamptz not null default now(),
  resposta_privada_status text not null default 'nao_pedida'
    constraint meta_social_comentarios_resposta_privada_status_check
    check (resposta_privada_status in ('nao_pedida', 'na_fila', 'enviada', 'falhou', 'expirada')),
  resposta_privada_mid text,
  resposta_privada_erro text,
  resposta_privada_em timestamptz,
  resposta_publica_id text,
  resposta_publica_em timestamptz,
  constraint meta_social_comentarios_org_comment_key unique (organization_id, comment_id)
);

create index if not exists meta_social_comentarios_media_idx
  on public.meta_social_comentarios (organization_id, media_id, recebido_em desc);
create index if not exists meta_social_comentarios_sessao_idx
  on public.meta_social_comentarios (channel_session_id);

comment on table public.meta_social_comentarios is
  '0991: comentários do Instagram recebidos pelo webhook do canal meta_social, com o estado da resposta privada (uma por comentário, até 7 dias) e da pública. Escrita só do servidor.';

create table if not exists public.meta_social_fila_de_envio (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  tipo text not null
    constraint meta_social_fila_de_envio_tipo_check
    check (tipo in ('resposta_privada', 'resposta_publica')),
  comment_id text not null,
  texto text not null constraint meta_social_fila_de_envio_texto_check check (length(texto) between 1 and 2000),
  pedido_por text,
  status text not null default 'na_fila'
    constraint meta_social_fila_de_envio_status_check
    check (status in ('na_fila', 'enviando', 'enviada', 'falhou', 'expirada')),
  tentativas integer not null default 0,
  proxima_tentativa_em timestamptz not null default now(),
  erro text,
  resultado_id text,
  enviada_em timestamptz,
  atualizado_em timestamptz not null default now(),
  criado_em timestamptz not null default now(),
  constraint meta_social_fila_de_envio_org_tipo_comment_key unique (organization_id, tipo, comment_id)
);

create index if not exists meta_social_fila_de_envio_pendentes_idx
  on public.meta_social_fila_de_envio (status, proxima_tentativa_em);
create index if not exists meta_social_fila_de_envio_ritmo_idx
  on public.meta_social_fila_de_envio (channel_session_id, tipo, enviada_em)
  where status = 'enviada';

comment on table public.meta_social_fila_de_envio is
  '0991: respostas a comentários do Instagram pedidas pela automação (privada no Direct, pública no comentário), enviadas pelo cron meta-social-fila com teto por conta. Uma por comentário por tipo. Escrita só do servidor.';

alter table public.meta_social_comentarios enable row level security;
alter table public.meta_social_fila_de_envio enable row level security;

drop policy if exists tenant_isolation_meta_social_comentarios_all on public.meta_social_comentarios;
create policy tenant_isolation_meta_social_comentarios_all on public.meta_social_comentarios
  for all
  to authenticated
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_meta_social_fila_de_envio_all on public.meta_social_fila_de_envio;
create policy tenant_isolation_meta_social_fila_de_envio_all on public.meta_social_fila_de_envio
  for all
  to authenticated
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

-- O default ACL do Supabase dá tudo aos três papéis em tabela nova de public:
-- revoga explícito e devolve só o que cada um usa.
revoke all on public.meta_social_comentarios from anon, authenticated;
revoke all on public.meta_social_fila_de_envio from anon, authenticated;
grant select on public.meta_social_comentarios to authenticated;
grant select on public.meta_social_fila_de_envio to authenticated;
grant select, insert, update, delete on public.meta_social_comentarios to service_role;
grant select, insert, update, delete on public.meta_social_fila_de_envio to service_role;

create or replace function public.fn_meta_social_registrar_comentario(
  p_organization_id uuid,
  p_channel_session_id uuid,
  p_comment_id text,
  p_media_id text,
  p_media_product_type text,
  p_autor_id text,
  p_autor_usuario text,
  p_texto text,
  p_criado_na_meta_em timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_organization_id is null or p_channel_session_id is null
     or coalesce(p_comment_id, '') = '' or coalesce(p_autor_id, '') = '' then
    raise exception 'meta_social_comentario_incompleto' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.channel_sessions s
     where s.id = p_channel_session_id and s.organization_id = p_organization_id
  ) then
    raise exception 'meta_social_sessao_de_outra_organizacao' using errcode = '42501';
  end if;

  insert into public.meta_social_comentarios (
    organization_id, channel_session_id, comment_id, media_id, media_product_type,
    autor_id, autor_usuario, texto, criado_na_meta_em
  ) values (
    p_organization_id, p_channel_session_id, p_comment_id, p_media_id, p_media_product_type,
    p_autor_id, p_autor_usuario, p_texto, p_criado_na_meta_em
  )
  on conflict (organization_id, comment_id) do nothing
  returning id into v_id;

  if v_id is null then
    return null;
  end if;

  -- O payload É o contrato (lib/channels/meta-social/comentarios-contrato.ts,
  -- CAMPOS_DO_EVENTO_COMENTARIO). Campo novo entra nos dois lugares.
  perform public.emit_event(
    'instagram.comentario_recebido',
    'instagram_comment',
    v_id,
    jsonb_build_object(
      'organization_id', p_organization_id,
      'channel_session_id', p_channel_session_id,
      'comment_id', p_comment_id,
      'media_id', p_media_id,
      'media_product_type', p_media_product_type,
      'autor_id', p_autor_id,
      'autor_usuario', p_autor_usuario,
      'texto', p_texto,
      'criado_na_meta_em', to_char(p_criado_na_meta_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    jsonb_build_object('actor_kind', 'system', 'source', 'webhook/meta-social'),
    p_organization_id
  );
  return v_id;
end;
$$;

revoke execute on function public.fn_meta_social_registrar_comentario(uuid, uuid, text, text, text, text, text, text, timestamptz) from public, anon;
revoke execute on function public.fn_meta_social_registrar_comentario(uuid, uuid, text, text, text, text, text, text, timestamptz) from authenticated;
grant execute on function public.fn_meta_social_registrar_comentario(uuid, uuid, text, text, text, text, text, text, timestamptz) to service_role;

-- As travas do modo somente leitura do suporte alcançam as tabelas novas.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';
