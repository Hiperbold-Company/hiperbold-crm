-- 0986 — AUTOMAÇÕES: superfície própria, raia de execução, variáveis e início.
--
-- As Automações do CRM (/app/automacoes) usam o MESMO motor dos follow-ups
-- (followup_flow_pointers / versions / enrollments / events). Esta migration
-- dá a elas o que o motor não tinha:
--   1. superfície 'automacao' no CHECK de followup_flow_pointers.surface (o
--      bloco ÚNICO da 0196 é editado no baseline; aqui o CHECK é refeito);
--   2. followup_enrollments.lane ('followup' | 'automacao'), derivada da
--      superfície na inserção e imutável; vars (jsonb objeto, teto 64 KB);
--      origin_event_id (idempotência por evento); parent_enrollment_id;
--   3. a vaga única do follow-up (idx_followup_enrollments_one_live) passa a
--      valer SÓ na raia followup — o predicado em vigor é copiado (inclui
--      paused_manual) e ganha `lane = 'followup'`. Follow-ups seguem iguais;
--      automações ganham a vaga delas (uma viva por automação por contato);
--   4. fn_followup_patch grava vars; fn_followup_apply_step não muda (delega);
--   5. fn_automacao_iniciar: única porta de nascimento da raia, security
--      definer, só service_role (revogada de public, anon e authenticated);
--   6. LGPD: anonimizar o contato zera vars de todas as execuções e encerra as
--      automações vivas (gatilho em contacts, padrão da 0394).
--
-- Idempotente e reaplicável; sem BEGIN/COMMIT (o runner envolve).

set lock_timeout = '3s';

alter table public.followup_flow_pointers
  drop constraint if exists followup_flow_pointers_surface_check;
alter table public.followup_flow_pointers
  add constraint followup_flow_pointers_surface_check
  check (surface in ('followup', 'crm_automation', 'atendimento', 'automacao'));

-- 1) raia, variáveis e origem da execução
alter table public.followup_enrollments
  add column if not exists lane text not null default 'followup';
alter table public.followup_enrollments
  add column if not exists vars jsonb not null default '{}'::jsonb;
alter table public.followup_enrollments
  add column if not exists origin_event_id uuid;
alter table public.followup_enrollments
  add column if not exists parent_enrollment_id uuid;

do $$ begin
  alter table public.followup_enrollments
    add constraint followup_enrollments_lane_check check (lane in ('followup', 'automacao'));
exception when duplicate_object then null; end $$;

-- Variáveis: sempre objeto, e com teto (64 KB) — respostas e saídas truncadas
-- cabem; um dump inteiro de API não.
do $$ begin
  alter table public.followup_enrollments
    add constraint followup_enrollments_vars_check
    check (jsonb_typeof(vars) = 'object' and pg_column_size(vars) <= 65536);
exception when duplicate_object then null; end $$;

create unique index if not exists followup_enrollments_org_id_uniq
  on public.followup_enrollments (organization_id, id);

do $$ begin
  alter table public.followup_enrollments
    add constraint followup_enrollments_parent_mesma_org
    foreign key (organization_id, parent_enrollment_id)
    references public.followup_enrollments (organization_id, id)
    on delete set null (parent_enrollment_id);
exception when duplicate_object then null; end $$;

comment on column public.followup_enrollments.lane is
  'Raia (0986): followup = follow-up de IA, um vivo por contato na organização; automacao = Automações do CRM, um vivo por automação por contato. Derivada da superfície do fluxo na inserção (trg_enrollment_superficie_coerente) e imutável.';
comment on column public.followup_enrollments.vars is
  'Variáveis da execução (0986): gatilho.*, _lead_id e o que os blocos guardam. Zerado na anonimização (LGPD).';
comment on column public.followup_enrollments.origin_event_id is
  'Linha do event_log que iniciou a execução (0986). Único por fluxo: o mesmo evento drenado de novo não abre segunda execução.';

-- 2) a vaga única do FOLLOW-UP continua igual, só que restrita à raia dele.
-- Cópia do predicado EM VIGOR (com paused_manual, issue #1041), mais a raia.
-- Só derruba a versão sem `lane`: numa reaplicação o índice já está na final.
do $$
begin
  if exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname  = 'idx_followup_enrollments_one_live'
      and indexdef not ilike '%lane%'
  ) then
    execute 'drop index public.idx_followup_enrollments_one_live';
  end if;
end
$$;
create unique index if not exists idx_followup_enrollments_one_live
  on public.followup_enrollments (organization_id, contact_id)
  where status in ('active','waiting_reply','paused_handoff','paused_manual') and lane = 'followup';

-- A vaga da AUTOMAÇÃO: uma execução viva por automação por contato; várias
-- automações por contato, e o follow-up dele ao lado.
create unique index if not exists idx_followup_enrollments_automacao_live
  on public.followup_enrollments (pointer_id, contact_id)
  where lane = 'automacao' and status in ('active','waiting_reply','paused_handoff','paused_manual');

create unique index if not exists idx_followup_enrollments_origem_do_evento
  on public.followup_enrollments (pointer_id, origin_event_id)
  where origin_event_id is not null;

create index if not exists idx_followup_flow_pointers_org_surface_status
  on public.followup_flow_pointers (organization_id, surface, status);

-- 3) superfície e raia andam juntas, no BANCO
create or replace function public.fn_enrollment_superficie_coerente()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_surface text;
begin
  select p.surface into v_surface
    from public.followup_flow_pointers p
   where p.id = new.pointer_id;
  if v_surface = 'atendimento' and new.status not in ('coletando','completed','cancelled','dead') then
    raise exception 'roteiro de atendimento só roda como coletando (status %)', new.status
      using errcode = '23514';
  end if;
  if v_surface is distinct from 'atendimento' and new.status = 'coletando' then
    raise exception 'coletando é exclusivo de roteiro de atendimento'
      using errcode = '23514';
  end if;
  -- A raia vem da superfície (0986) e nunca muda depois.
  if tg_op = 'INSERT' then
    new.lane := case when v_surface = 'automacao' then 'automacao' else 'followup' end;
  elsif new.lane is distinct from old.lane then
    raise exception 'a raia da execução é imutável'
      using errcode = '23514';
  end if;
  return new;
end
$$;

revoke all on function public.fn_enrollment_superficie_coerente() from public;
revoke execute on function public.fn_enrollment_superficie_coerente() from anon;
revoke execute on function public.fn_enrollment_superficie_coerente() from authenticated;

drop trigger if exists trg_enrollment_superficie_coerente on public.followup_enrollments;
create trigger trg_enrollment_superficie_coerente
  before insert or update of status, pointer_id, lane on public.followup_enrollments
  for each row
  execute function public.fn_enrollment_superficie_coerente();

-- 4) o CAS do motor grava as variáveis
create or replace function public.fn_followup_patch(p_org uuid,p_id uuid,p_revision bigint,p_patch jsonb)
returns bigint language plpgsql security definer set search_path=public as $$
declare current public.followup_enrollments; patched public.followup_enrollments; contact uuid;
begin
 select contact_id into contact from public.followup_enrollments where id=p_id and organization_id=p_org;
 if not found then raise exception 'followup_stale' using errcode='P0001'; end if;
 perform public.fn_service_lock(p_org,contact);
 select * into current from public.followup_enrollments where id=p_id and organization_id=p_org for update;
 if current.contact_id is distinct from contact or current.revision is distinct from p_revision then raise exception 'followup_stale' using errcode='P0001'; end if;
 if p_patch->>'status' in ('active','waiting_reply') and current.appointment_revision is not null and not public.fn_appointment_enrollment_current(p_org,p_id,current.current_node_id) then raise exception 'followup_stale' using errcode='P0001'; end if;
 select * into patched from jsonb_populate_record(current,p_patch);
 update public.followup_enrollments set status=patched.status,current_node_id=patched.current_node_id,next_eval_at=patched.next_eval_at,
  claimed_until=patched.claimed_until,attempts=patched.attempts,last_error=patched.last_error,steps_taken=patched.steps_taken,
  outcome=patched.outcome,cancel_reason=patched.cancel_reason,completed_at=patched.completed_at,timing_plan=patched.timing_plan,
  vars=coalesce(patched.vars,current.vars)
 where organization_id=p_org and id=p_id returning revision into p_revision;
 return p_revision;
end; $$;
revoke all on function public.fn_followup_patch(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.fn_followup_patch(uuid,uuid,bigint,jsonb) to service_role;

-- 5) iniciar uma automação para um contato — a ÚNICA porta de nascimento da raia
create or replace function public.fn_automacao_iniciar(
  p_org uuid,
  p_pointer uuid,
  p_contact uuid,
  p_vars jsonb,
  p_origin_event_id uuid,
  p_parent_enrollment_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version uuid;
  v_graph jsonb;
  v_trigger_id text;
  v_policy text;
  v_cooldown int;
  v_live public.followup_enrollments;
  v_id uuid;
  v_anon boolean;
begin
  select p.active_version_id into v_version
    from public.followup_flow_pointers p
   where p.organization_id = p_org and p.id = p_pointer
     and p.surface = 'automacao' and p.status = 'active' and p.active_version_id is not null;
  if v_version is null then
    return jsonb_build_object('resultado', 'inativa');
  end if;

  select c.is_anonymized into v_anon
    from public.contacts c where c.organization_id = p_org and c.id = p_contact;
  if not found or coalesce(v_anon, false) then
    return jsonb_build_object('resultado', 'contato_invalido');
  end if;

  perform public.fn_service_lock(p_org, p_contact);

  if p_origin_event_id is not null and exists (
    select 1 from public.followup_enrollments
     where pointer_id = p_pointer and origin_event_id = p_origin_event_id
  ) then
    return jsonb_build_object('resultado', 'duplicada');
  end if;

  select v.graph into v_graph
    from public.followup_flow_versions v
   where v.organization_id = p_org and v.id = v_version;
  select n->>'id',
         coalesce(n->'config'->'reentry'->>'policy', 'skip_if_running'),
         coalesce((n->'config'->'reentry'->>'cooldown_minutes')::int, 0)
    into v_trigger_id, v_policy, v_cooldown
    from jsonb_array_elements(coalesce(v_graph->'nodes', '[]'::jsonb)) n
   where n->>'type' = 'trigger'
   limit 1;
  if v_trigger_id is null then
    return jsonb_build_object('resultado', 'sem_inicio');
  end if;

  select * into v_live
    from public.followup_enrollments e
   where e.organization_id = p_org and e.pointer_id = p_pointer and e.contact_id = p_contact
     and e.lane = 'automacao'
     and e.status in ('active','waiting_reply','paused_handoff','paused_manual')
   for update;

  if found then
    if v_policy <> 'restart' then
      insert into public.followup_enrollment_events(organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
      values (p_org, v_live.id, v_live.current_node_id, 'trigger_ignored_running',
              jsonb_build_object('gatilho', p_vars->'gatilho'->>'tipo'),
              'gatilho-ignorado:' || coalesce(p_origin_event_id::text, gen_random_uuid()::text))
      on conflict do nothing;
      return jsonb_build_object('resultado', 'ja_em_execucao', 'enrollment_id', v_live.id);
    end if;
    update public.followup_enrollments
       set status = 'cancelled', cancel_reason = 'reiniciada', completed_at = now(),
           next_eval_at = null, claimed_until = null, updated_at = now()
     where id = v_live.id;
  end if;

  if v_cooldown > 0 and exists (
    select 1 from public.followup_enrollments e
     where e.organization_id = p_org and e.pointer_id = p_pointer and e.contact_id = p_contact
       and e.completed_at > now() - make_interval(mins => v_cooldown)
       and coalesce(e.cancel_reason, '') <> 'reiniciada'
  ) then
    return jsonb_build_object('resultado', 'em_espera');
  end if;

  -- Freio contra laço entre fluxos: no máximo 10 execuções por automação por contato por hora.
  if (select count(*) from public.followup_enrollments e
       where e.organization_id = p_org and e.pointer_id = p_pointer and e.contact_id = p_contact
         and e.started_at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('resultado', 'limite_por_hora');
  end if;

  begin
    insert into public.followup_enrollments(
      organization_id, pointer_id, version_id, contact_id, current_node_id, status,
      vars, origin_event_id, parent_enrollment_id)
    values (
      p_org, p_pointer, v_version, p_contact, v_trigger_id, 'active',
      coalesce(p_vars, '{}'::jsonb), p_origin_event_id, p_parent_enrollment_id)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('resultado', 'ja_em_execucao');
  end;

  insert into public.followup_enrollment_events(organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
  values (p_org, v_id, v_trigger_id, 'automacao_iniciada',
          jsonb_build_object('gatilho', p_vars->'gatilho'->>'tipo', 'reiniciada', v_live.id is not null),
          'inicio');

  return jsonb_build_object('resultado', case when v_live.id is not null then 'reiniciada' else 'iniciada' end,
                            'enrollment_id', v_id);
end
$$;

revoke execute on function public.fn_automacao_iniciar(uuid, uuid, uuid, jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_automacao_iniciar(uuid, uuid, uuid, jsonb, uuid, uuid) to service_role;

-- 6) LGPD: anonimizar o contato zera as variáveis de TODAS as execuções dele
-- (guardam respostas e dados do gatilho) e encerra as automações vivas. O
-- follow-up já é cancelado pela cascata; aqui é só a raia nova e o dado novo.
create or replace function public.fn_contato_anonimizado_limpa_automacoes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.followup_enrollments
     set status = case when lane = 'automacao'
                        and status in ('active','waiting_reply','paused_handoff','paused_manual','dormente')
                       then 'cancelled' else status end,
         cancel_reason = case when lane = 'automacao'
                        and status in ('active','waiting_reply','paused_handoff','paused_manual','dormente')
                       then 'Contato anonimizado (LGPD)' else cancel_reason end,
         completed_at = case when lane = 'automacao'
                        and status in ('active','waiting_reply','paused_handoff','paused_manual','dormente')
                       then now() else completed_at end,
         next_eval_at = case when lane = 'automacao'
                        and status in ('active','waiting_reply','paused_handoff','paused_manual','dormente')
                       then null else next_eval_at end,
         claimed_until = null,
         vars = '{}'::jsonb,
         updated_at = now()
   where organization_id = new.organization_id
     and contact_id = new.id
     and (vars <> '{}'::jsonb or (lane = 'automacao'
          and status in ('active','waiting_reply','paused_handoff','paused_manual','dormente')));
  return new;
end
$$;

revoke all on function public.fn_contato_anonimizado_limpa_automacoes() from public;
revoke execute on function public.fn_contato_anonimizado_limpa_automacoes() from anon;
revoke execute on function public.fn_contato_anonimizado_limpa_automacoes() from authenticated;

drop trigger if exists trg_contato_anonimizado_limpa_automacoes on public.contacts;
create trigger trg_contato_anonimizado_limpa_automacoes
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized = true and coalesce(old.is_anonymized, false) = false)
  execute function public.fn_contato_anonimizado_limpa_automacoes();

notify pgrst, 'reload schema';
