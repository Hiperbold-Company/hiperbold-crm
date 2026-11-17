-- 1017, mensagem agendada no chat (fork Hiperbold, aprovada pelo dono do produto em 17/11/2026).
--
-- O compositor da conversa ganha um botão de calendário: a pessoa escolhe data e hora (no fuso da
-- organização), escreve, e o Enviar AGENDA em vez de mandar. Até a hora, o fim da conversa mostra um
-- balão "agendada" com Editar e Cancelar. Na hora, o cron `mensagens-agendadas` (a cada minuto) envia
-- pela MESMA porta do compositor (`sendMessageHandler`, ator = quem agendou), com opt-out, janela de
-- horário do canal, espaçamento anti-ban e audit.
--
--  1. `scheduled_messages`: organização, conversa, contato, canal, quem agendou, texto, modelo
--     aprovado opcional (jsonb: name, language, values, body) para quando a janela de 24h estiver
--     fechada, horário, status com CHECK (agendada, enviando, enviada, cancelada, falhou), motivo
--     legível, a mensagem enviada (FK `messages`), `adiada_ate` (fora da janela de horário do canal)
--     e `reservada_em` (para achar a linha presa em `enviando` quando o processo cai no meio).
--  2. RLS por organização via `fn_user_org_ids()`; escrita por política só de `agent` ou acima. Mas
--     `authenticated` recebe SÓ select: quem escreve é o servidor (service role, com
--     `organization_id` da sessão), nas rotas `/api/v1/conversations/:id/scheduled-messages` e
--     `/api/v1/scheduled-messages/:id`, que conferem quem agendou, a conversa visível e a janela.
--  3. `fn_reservar_mensagens_agendadas(limite, orgs_paradas)`: troca `agendada` vencida por `enviando`
--     com `for update skip locked` e devolve só o que reservou. Duas rodadas sobrepostas nunca pegam a
--     mesma linha. Só `service_role`; revogada de public, anon e authenticated.
--
-- Idempotente: create ... if not exists, create or replace, drop/create policy. Gates:
-- tests/invariants/mensagens-agendadas-rls-e-check.test.ts e tests/invariants/vocabulario-banco-x-typescript.test.ts.

create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  channel_session_id uuid references public.channel_sessions(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  body text not null,
  template jsonb,
  send_at timestamptz not null,
  status text not null default 'agendada',
  motivo text,
  message_id uuid references public.messages(id) on delete set null,
  adiada_ate timestamptz,
  reservada_em timestamptz,
  concluida_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_messages_status_check
    check (status in ('agendada', 'enviando', 'enviada', 'cancelada', 'falhou')),
  constraint scheduled_messages_body_check check (char_length(body) between 1 and 4096),
  constraint scheduled_messages_template_check
    check (template is null or jsonb_typeof(template) = 'object')
);

-- O que o cron lê por rodada: só as que ainda vão sair, pelo horário.
create index if not exists scheduled_messages_a_enviar_idx
  on public.scheduled_messages (send_at)
  where status = 'agendada';
-- A presa em `enviando` (o processo caiu no meio do envio).
create index if not exists scheduled_messages_enviando_idx
  on public.scheduled_messages (reservada_em)
  where status = 'enviando';
-- O balão da conversa.
create index if not exists scheduled_messages_conversa_idx
  on public.scheduled_messages (organization_id, conversation_id, status);

alter table public.scheduled_messages enable row level security;

drop policy if exists tenant_isolation_scheduled_messages_select on public.scheduled_messages;
create policy tenant_isolation_scheduled_messages_select on public.scheduled_messages
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_scheduled_messages_write on public.scheduled_messages;
create policy tenant_isolation_scheduled_messages_write on public.scheduled_messages
  for all
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  );

revoke all on public.scheduled_messages from public, anon, authenticated;
grant select on public.scheduled_messages to authenticated;
grant select, insert, update, delete on public.scheduled_messages to service_role;

comment on table public.scheduled_messages is
  'Migration 1017 (fork Hiperbold): mensagem agendada no chat. Escrita só pelo servidor (rotas /api/v1/conversations/:id/scheduled-messages e /api/v1/scheduled-messages/:id); envio pelo cron mensagens-agendadas, pela mesma porta do compositor.';

create or replace function public.fn_reservar_mensagens_agendadas(
  p_limite integer,
  p_orgs_paradas uuid[] default '{}'::uuid[]
)
returns setof public.scheduled_messages
language sql
security invoker
set search_path = public, pg_temp
as $$
  with alvo as (
    select s.id
      from public.scheduled_messages s
     where s.status = 'agendada'
       and s.send_at <= now()
       and (s.adiada_ate is null or s.adiada_ate <= now())
       and not (s.organization_id = any (coalesce(p_orgs_paradas, '{}'::uuid[])))
     order by s.send_at
     limit greatest(1, least(coalesce(p_limite, 20), 200))
     for update of s skip locked
  )
  update public.scheduled_messages s
     set status = 'enviando',
         reservada_em = now(),
         updated_at = now()
    from alvo
   where s.id = alvo.id
     and s.status = 'agendada'
  returning s.*;
$$;

revoke execute on function public.fn_reservar_mensagens_agendadas(integer, uuid[])
  from public, anon, authenticated;
grant execute on function public.fn_reservar_mensagens_agendadas(integer, uuid[])
  to service_role;

comment on function public.fn_reservar_mensagens_agendadas(integer, uuid[]) is
  'Migration 1017 (fork Hiperbold): reserva (agendada -> enviando) as mensagens agendadas vencidas, fora das organizações paradas, com for update skip locked. Só service_role; quem chama é lib/mensagens-agendadas/worker.ts.';
