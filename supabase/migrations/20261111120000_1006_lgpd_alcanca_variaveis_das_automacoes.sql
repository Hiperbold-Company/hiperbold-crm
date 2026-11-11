-- manifest: **Automação não nasce para contato que está sendo anonimizado (LGPD, fork Hiperbold).** A anonimização já alcançava as variáveis das automações desde a 0986: o gatilho `trg_contato_anonimizado_limpa_automacoes` (virada false→true de `contacts.is_anonymized`, a porta dos DOIS caminhos) zera `followup_enrollments.vars` de todas as execuções do contato, em todas as raias, e cancela as automações vivas; os eventos (`followup_enrollment_events.payload`) não guardam resposta nem saída HTTP por construção (`varsParaOEvento`). O furo que sobrava era de CORRIDA: `fn_automacao_iniciar` lia `is_anonymized` ANTES de tomar `fn_service_lock(org, contato)`, a mesma trava que `fn_lgpd_cascade_redact_contact` e `fn_lgpd_anonymize_contact` seguram durante a virada. Com a anonimização em voo, a leitura via o contato ainda identificado, esperava a trava e criava uma execução viva com `gatilho.*` nas variáveis DEPOIS de o gatilho já ter limpado — contato anonimizado com automação rodando e dado nas variáveis. `create or replace` de `fn_automacao_iniciar` (assinatura igual) relendo `is_anonymized` sob a trava (`contato_invalido`). Sem coluna, sem tabela, sem dado reescrito. Grants reaplicados (revogada de public/anon/authenticated, só service_role). Gate: `tests/invariants/lgpd-alcanca-variaveis-das-automacoes.test.ts` (limpeza na virada com vizinho e outra organização intactos, e a corrida com duas sessões).
-- 1006 — Reaplicável: create or replace function com a mesma assinatura e
-- revoke/grant idempotentes. Sem BEGIN/COMMIT (o runner envolve).

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
  v_profundidade int;
  v_ciclo boolean;
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

  -- 1006: a anonimização (os DOIS caminhos) toma esta mesma trava antes de
  -- virar `is_anonymized`. A leitura acima é de ANTES da trava: se a
  -- anonimização estava em voo, ela via o contato ainda identificado, esperava
  -- a trava e nascia uma execução viva, com o `gatilho.*` nas variáveis, DEPOIS
  -- de o gatilho da virada já ter limpado e encerrado as do contato. Sob a
  -- trava, a releitura vê o que a anonimização gravou.
  select c.is_anonymized into v_anon
    from public.contacts c where c.organization_id = p_org and c.id = p_contact;
  if not found or coalesce(v_anon, false) then
    return jsonb_build_object('resultado', 'contato_invalido');
  end if;

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

  -- Cadeia de automações (o evento que chegou foi causado por outra execução):
  -- a mesma automação voltando na cadeia (A → B → A) ou uma cadeia funda demais
  -- é cortada aqui, com aviso na Central — senão duas automações que se
  -- disparam giram até o teto por hora de cada contato.
  if p_parent_enrollment_id is not null then
    with recursive cadeia(id, pointer_id, parent, n) as (
      select e.id, e.pointer_id, e.parent_enrollment_id, 1
        from public.followup_enrollments e
       where e.organization_id = p_org and e.id = p_parent_enrollment_id
      union all
      select e.id, e.pointer_id, e.parent_enrollment_id, c.n + 1
        from public.followup_enrollments e
        join cadeia c on e.id = c.parent
       where e.organization_id = p_org and c.n < 20
    )
    select coalesce(max(n), 0), coalesce(bool_or(pointer_id = p_pointer), false)
      into v_profundidade, v_ciclo
      from cadeia;
    if v_ciclo or v_profundidade >= 5 then
      insert into public.agent_inbox_items(organization_id, kind, severity, title, body, ref_kind, ref_id)
      select p_org, 'other', 'warn', 'Automações em cadeia interrompidas',
             case when v_ciclo
               then 'Uma automação disparou outra que voltaria a disparar a primeira. A volta foi cortada para não girar sem fim.'
               else 'Uma sequência de automações disparando umas às outras passou de 5 passos e foi cortada.' end,
             'followup_flow_pointer', p_pointer
       where not exists (
         select 1 from public.agent_inbox_items i
          where i.organization_id = p_org and i.kind = 'other' and i.status = 'open'
            and i.ref_kind = 'followup_flow_pointer' and i.ref_id = p_pointer
            and i.title = 'Automações em cadeia interrompidas');
      return jsonb_build_object('resultado', case when v_ciclo then 'ciclo' else 'cadeia_longa' end);
    end if;
  end if;

  -- Teto por organização e por hora: freio de último caso contra laço que
  -- escape das guardas acima (cada execução nova conta, de qualquer automação).
  if (select count(*) from public.followup_enrollments e
       where e.organization_id = p_org and e.lane = 'automacao'
         and e.started_at > now() - interval '1 hour') >= 5000 then
    insert into public.agent_inbox_items(organization_id, kind, severity, title, body, ref_kind, ref_id)
    select p_org, 'other', 'critical', 'Automações pausadas pelo teto da hora',
           'Mais de 5000 execuções de automação começaram na última hora. As novas ficam recusadas até o volume baixar.',
           'organization', p_org
     where not exists (
       select 1 from public.agent_inbox_items i
        where i.organization_id = p_org and i.kind = 'other' and i.status = 'open'
          and i.title = 'Automações pausadas pelo teto da hora');
    return jsonb_build_object('resultado', 'limite_da_organizacao');
  end if;

  -- Espera e teto do contato ANTES de mexer na execução viva: um "recomeçar"
  -- barrado por eles não pode cancelar a execução que estava em curso.
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

notify pgrst, 'reload schema';
