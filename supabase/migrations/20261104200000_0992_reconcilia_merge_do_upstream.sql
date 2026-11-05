-- 0992 (fork Hiperbold): reconcilia o merge do upstream de 04/11/2026.
-- Espelho idêntico no apêndice do supabase/baseline.sql, em duas partes: as funções antes da
-- VARREDURA anon (cria função) e as policies e grants no fim do arquivo, depois da 0508 e da 9037
-- do upstream, que reabririam o que o fork fechou. Detalhe na linha do MANIFEST.

-- ---- o merge do upstream de 04/11/2026: funções que os dois lados mudaram (migration 0992, fork Hiperbold) ----
--
-- O upstream (DeskcommCRM até f522d7a1) e o fork redefiniram as mesmas funções depois da base
-- comum 6206bca728. Os blocos 09xx do fork vêm depois dos do upstream no arquivo, então a versão
-- do fork apagaria a correção do upstream. Aqui fica a última definição de cada uma, com as duas
-- intenções: o corpo do upstream mais a regra do fork (comentada com 'Hiperbold' onde entrou).
-- Cria FUNÇÕES: entra ANTES da VARREDURA anon. create or replace preserva assinatura e ACL.

CREATE OR REPLACE FUNCTION public.emit_event(p_event_type text, p_entity_kind text, p_entity_id uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_metadata jsonb DEFAULT '{}'::jsonb, p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_id uuid;
  v_event_id uuid;
  v_contact uuid;
  v_origin jsonb;
begin
  -- message.received nasce somente do INSERT inbound interno. Um chamador
  -- público não pode reapresentar uma mensagem existente como evento novo.
  -- `ai.case_opened`/`ai.case_closed` entram pela mesma razão (0279): o caso é
  -- do motor, e um evento de caso forjado por login move o funil e acorda o
  -- agente em nome de uma decisão que ninguém tomou.
  -- `contact.birthday` entra pela 0551: só o cron (`contact-birthdays`, sem
  -- sessão) o emite, e a partir desta migration ele alcança a origem e manda
  -- WhatsApp de verdade — forjado por login, seria envio em nome de um
  -- aniversário que ninguém fez.
  -- `contact.phone_added` entra pela 0670, pela mesma razão do aniversário:
  -- quem o emite é o servidor (o PATCH de contatos, com a chave de serviço,
  -- depois de gravar o número), e ele alcança a origem e manda WhatsApp.
  -- `lead.date_field_due` entra pela 0743, como o aniversário: quem o emite é
  -- só o cron `lead-date-field-due` (sem sessão), e a partir dela ele alcança a
  -- origem e manda WhatsApp.
  -- Revogação do turno é fato da tomada nativa, nunca um pedido do login.
  if auth.uid() is not null and p_event_type in (
    'message.received','appointment.outcome_confirmed',
    'ai.case_opened','ai.case_closed','contact.birthday','contact.phone_added',
    'lead.date_field_due','conversation.autonomous_turn_revoked'
  ) then
    raise exception 'reserved_message_received' using errcode='42501';
  end if;
  -- Desfecho e responsável do negócio só nascem do gatilho de `crm_leads`
  -- (`fn_emit_event_on_lead_change`), quando a linha muda de fato. Nenhum
  -- emissor do app os pede por RPC; os consumidores produzem efeito real
  -- (push, webhook de saída, conversão de anúncio).
  if auth.uid() is not null
     and p_event_type in ('lead.won','lead.lost','lead.reopened','lead.assigned')
     and coalesce(current_setting('deskcomm.desfecho_pelo_negocio', true), '') <> 'on' then
    raise exception 'reserved_message_received' using errcode='42501';
  end if;
  -- Estes campos autorizam efeitos operacionais; não são payload público.
  if auth.uid() is not null and (
    coalesce(p_payload,'{}'::jsonb) ?| array['service_origin','service_boundary']
    or coalesce(p_metadata,'{}'::jsonb) ?| array['service_origin','service_boundary']
  ) then raise exception 'reserved_service_origin' using errcode='42501'; end if;
  v_org_id := coalesce(p_organization_id, (public.fn_support_context()->>'organization_id')::uuid);
  -- Hiperbold (0927, D-129): sem fallback para a primeira organização do
  -- usuário; a organização vem explícita ou do contexto de suporte.
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  if auth.uid() is not null
     and not public.fn_role_at_least(v_org_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'emit_event: caller must be an active member of the organization';
  end if;

  if not public.fn_support_write_allowed(v_org_id) then raise exception 'support_readonly' using errcode='42501'; end if;

  -- Hiperbold (0927, D-129): emitir pede agent ou acima (viewer só lê), exceto
  -- o próprio perfil.
  if auth.uid() is not null
     and not (
       public.fn_role_at_least(v_org_id, 'agent')
       or (p_event_type = 'user.profile_updated' and p_entity_id = auth.uid())
     ) then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'emit_event: caller must be an active agent or above in the organization';
  end if;

  -- A ORIGEM E RESERVADA AO SERVIDOR — ENTAO O SERVIDOR TEM DE ESCREVE-LA.
  --
  -- O bloco acima recusa `service_origin` vindo de chamador autenticado (42501,
  -- e com razao: e o campo que AUTORIZA efeito operacional, nao payload
  -- publico). So que ninguem o escrevia no lugar dele. Efeito medido: quem move
  -- o negocio pela IA carimba a origem no servidor (`agent-stage-sync`,
  -- `appointment-stage-move`, `handoff-stage-move`) e o follow-up nasce; quem
  -- move PELO QUADRO — o operador, pela rota HTTP autenticada — emitia um
  -- evento SEM origem, `fn_service_event_origin` caia no `service_stale` final
  -- (40001), `serviceForEvent` engolia como `stale_origin` e o follow-up nunca
  -- nascia. Sem erro em lugar nenhum: o gatilho de etapa era inalcancavel pelo
  -- caminho que o produto oferece na tela.
  --
  -- O retrato e tirado AQUI, no instante da emissao, que e exatamente a
  -- semantica de procedencia que a 0223 quer: "quando este evento nasceu, o
  -- atendimento estava assim". A resolucao do contato vem da mesma tabela de
  -- `fn_service_event_contact` — se ela nao souber resolver o tipo, nao ha o que
  -- carimbar e o evento segue sem origem, como antes.
  if not (coalesce(p_payload,'{}'::jsonb) ? 'service_origin')
     and not (coalesce(p_metadata,'{}'::jsonb) ? 'service_origin') then
    select f.contact_id into v_contact
      from public.fn_service_event_contact(v_org_id, p_event_type, p_entity_kind, p_entity_id) f;
    if v_contact is not null
       and exists(select 1 from public.contacts
                   where organization_id=v_org_id and id=v_contact
                     and not is_anonymized and is_merged_into is null) then
      v_origin := jsonb_build_object('kind','command',
        'observed', public.fn_service_observe_command(v_org_id, v_contact));
    end if;
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb)
       || case when v_origin is null then '{}'::jsonb else jsonb_build_object('service_origin', v_origin) end,
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $function$;

create or replace function public.fn_campanha_sincroniza_ack() returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  -- O canal oficial mantém `status = 'sent'` e só preenche os carimbos: o
  -- "status efetivo" sai deles quando existem. `failed` vem primeiro porque uma
  -- falha não é desfeita por entrega anterior.
  v_status text := case
    when new.status = 'failed' then 'failed'
    when new.read_at is not null or new.status = 'read' then 'read'
    when new.delivered_at is not null or new.status = 'delivered' then 'delivered'
    else new.status end;
begin
  if new.status is not distinct from old.status
     and new.delivered_at is not distinct from old.delivered_at
     and new.read_at is not distinct from old.read_at then
    return new;
  end if;

  update public.campaign_recipients r
     set delivered_at = case
           when v_status in ('delivered', 'read')
             then coalesce(r.delivered_at, new.delivered_at, now())
           else r.delivered_at end,
         read_at = case
           when v_status = 'read' then coalesce(r.read_at, new.read_at, now())
           else r.read_at end,
         sent_at = case
           when v_status in ('sent', 'delivered', 'read')
             then coalesce(r.sent_at, new.sent_at, now())
           else r.sent_at end,
         status = case
           when r.status in ('replied', 'opted_out', 'cancelled') then r.status
           when v_status = 'read' then 'read'
           when v_status = 'delivered' and r.status in ('queued', 'sending', 'sent') then 'delivered'
           when v_status = 'sent' and r.status in ('queued', 'sending') then 'sent'
           when v_status = 'failed' and r.status in ('queued', 'sending', 'sent') then 'failed'
           else r.status end,
         last_error_code = case
           when v_status = 'failed' then coalesce(new.error_code, r.last_error_code)
           else r.last_error_code end,
         last_error_detail = case
           when v_status = 'failed' then coalesce(new.error_message, r.last_error_detail)
           else r.last_error_detail end,
         updated_at = now()
   where r.message_id = new.id
      or (r.message_id is null
          and r.organization_id = new.organization_id
          and r.id = case
                when new.metadata ->> 'campaign_recipient_id'
                     ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (new.metadata ->> 'campaign_recipient_id')::uuid
              end);

  return new;
end
$$;

create or replace function public.fn_create_tenant_with_owner(
  p_actor uuid, p_key uuid, p_request jsonb, p_hash text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prior public.idempotency_keys%rowtype;
  org public.organizations%rowtype;
  result jsonb;
  dono_e_outra_pessoa boolean;
  v_plano_id uuid;
  v_trial_dias integer;
begin
  if not exists (select 1 from public.platform_admins where user_id = p_actor
    and revoked_at is null and scope = 'full') then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_key::text, 0));
  select * into prior from public.idempotency_keys
    where key = p_key::text and endpoint = '/api/v1/admin/tenants:' || p_actor::text
      and expires_at > now() and tenant_creation_trusted;
  if found then
    if prior.request_hash <> decode(p_hash, 'hex') then
      raise exception 'idempotency_conflict' using errcode = '22023';
    end if;
    if prior.response_body->>'id' is distinct from prior.organization_id::text
      or not exists (select 1 from public.organizations where id = prior.organization_id and created_by = p_actor) then
      raise exception 'idempotency_provenance_invalid' using errcode = '22023';
    end if;
    return prior.response_body || jsonb_build_object('created', false);
  end if;

  v_plano_id := nullif(p_request->>'plano_id', '')::uuid;
  if v_plano_id is not null then
    if not public.fn_cobranca_ligada() then
      raise exception 'cobranca_desligada' using errcode = '22023';
    end if;
    select p.trial_dias into v_trial_dias
      from public.cobranca_planos p
     where p.id = v_plano_id and p.arquivado_em is null;
    if not found then
      raise exception 'plano_invalido' using errcode = '22023';
    end if;
  end if;

  dono_e_outra_pessoa := lower(p_request->>'owner_email') is distinct from
    (select lower(email) from auth.users where id = p_actor);

  insert into public.organizations(display_name, slug, legal_name, cnpj, status, settings, created_by)
    values (p_request->>'display_name', p_request->>'slug', coalesce(nullif(p_request->>'legal_name', ''), p_request->>'display_name'),
      p_request->>'cnpj', 'active',
      case when p_request ? 'plan' then jsonb_build_object('plan', p_request->>'plan') else '{}'::jsonb end,
      p_actor)
    returning * into org;
  insert into public.user_organizations(organization_id, user_id, role, accepted_at, interface_settings, membro_da_agencia)
    values (org.id, p_actor, 'admin', now(),
      case when dono_e_outra_pessoa
        then '{"preset":"completa"}'::jsonb
        else coalesce(p_request->'owner_interface_settings', '{"preset":"completa"}'::jsonb) end,
      dono_e_outra_pessoa);

  if v_plano_id is not null then
    insert into public.cobranca_assinaturas
      (organization_id, plano_id, estado, trial_ate, pagamento_inicial_pendente)
    values (org.id, v_plano_id,
      'trial',
      now() + make_interval(days => v_trial_dias), v_trial_dias = 0);
    if v_trial_dias = 0 then
      perform public.fn_suspender_organizacao(org.id, 'cobranca', 'Aguardando o primeiro pagamento', null);
    end if;
  end if;

  result := jsonb_build_object('id', org.id, 'slug', org.slug, 'display_name', org.display_name,
    'invite_id', gen_random_uuid(), 'issued_at', floor(extract(epoch from now()))::bigint);
  insert into public.idempotency_keys(organization_id, key, endpoint, request_hash, status_code, response_body, tenant_creation_trusted)
    values (org.id, p_key::text, '/api/v1/admin/tenants:' || p_actor::text,
      decode(p_hash, 'hex'), 201, result, true);
  return result || jsonb_build_object('created', true);
end $$;

create or replace function public.fn_is_platform_admin_full()
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid() and pa.revoked_at is null and pa.scope = 'full'
      and (coalesce(auth.jwt()->>'aal','aal1') = 'aal2' or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = pa.user_id and f.factor_type = 'totp' and f.status = 'verified'))
  );
$$;

create or replace function public.fn_lgpd_anonymize_contact(p_organization_id uuid,p_contact_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.contacts; support jsonb; v_quando timestamptz;
begin
 support:=public.fn_support_context();
 if auth.uid() is null or not public.fn_support_write_allowed(p_organization_id)
  or not (public.fn_role_at_least(p_organization_id,'admin') or (support is null and exists(
   select 1 from public.platform_admins pa where pa.user_id=auth.uid() and pa.revoked_at is null and pa.scope='full'))) then
  raise exception 'contact_anonymize_forbidden' using errcode='42501';
 end if;
 if not public.fn_session_mfa_proven() then raise exception 'contact_anonymize_mfa_required' using errcode='42501';end if;
 if not public.fn_role_at_least(p_organization_id,'admin')
  and coalesce(auth.jwt()->>'aal','aal1')<>'aal2'
  and exists(select 1 from auth.mfa_factors where user_id=auth.uid() and factor_type='totp' and status='verified') then
  raise exception 'contact_anonymize_mfa_required' using errcode='42501';
 end if;
 perform public.fn_service_lock(p_organization_id,p_contact_id);
 select * into c from public.contacts where organization_id=p_organization_id and id=p_contact_id for update;
 if not found then raise exception 'contact_not_found' using errcode='P0002';end if;
 if c.is_anonymized then return jsonb_build_object('already_anonymized',true,'anonymized_at',c.anonymized_at);end if;
 -- issue #1504 — a redação em si é da função ÚNICA. Este caminho (o botão) e o
 -- pedido formal passam por aqui; o portão acima é quem decide QUEM pode
 -- anonimizar, e nada é escrito por conta próprio neste corpo.
 perform public.fn_lgpd_cascade_redact_contact(p_organization_id,p_contact_id,null);
 select anonymized_at into v_quando
   from public.contacts where organization_id=p_organization_id and id=p_contact_id;
 return jsonb_build_object('already_anonymized',false,'anonymized_at',v_quando);
end;$$;

CREATE OR REPLACE FUNCTION public.fn_mesclar_contatos(p_organization_id uuid, p_contato_principal uuid, p_contatos_secundarios uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_principal public.contacts%rowtype;
  v_esperado integer;
  v_achado integer;
  v_alvo record;
  v_linha record;
  v_movidas integer;
  v_pulados integer;
  v_repontado jsonb := '{}'::jsonb;
  v_nao_repontado jsonb := '{}'::jsonb;
  v_nomes_absorvidos jsonb := '[]'::jsonb;
  v_apelido text;
  v_nascimento date;
  v_email text;
  v_telefone text;
  v_lid text;
  v_social text;
  v_tags text[];
  v_leads integer := 0;
  v_service_contact uuid;
  v_bloqueado boolean;
  v_bloqueado_em timestamptz;
  v_bloqueado_motivo text;
  v_force_human boolean;
  v_consent_restrito jsonb;
  v_campos jsonb;
  v_sec record;
  v_canon text;
  v_lid_extra text;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  -- 1 · Autorização. Fundir é destrutivo na prática: `manager`, o mesmo piso das
  --     policies de `merge_queue`. Sessão de service role (auth.uid() nulo) não
  --     passa por aqui, quem resolve a org nesse caminho é a rota, de fonte
  --     confiável, nunca do body.
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'manager') then
    raise exception using errcode = '42501', message = 'insufficient_role';
  end if;

  if p_contato_principal is null
     or p_contatos_secundarios is null
     or cardinality(p_contatos_secundarios) = 0
     or p_contato_principal = any(p_contatos_secundarios) then
    raise exception using errcode = '22023', message = 'selecao_de_mesclagem_invalida';
  end if;

  select count(distinct id)::integer into v_esperado
    from unnest(p_contatos_secundarios) as ids(id);
  if v_esperado <> cardinality(p_contatos_secundarios) then
    raise exception using errcode = '22023', message = 'secundario_repetido';
  end if;

  -- A TRAVA DA REGRA "CLIENTES PELA AGENDA" (migration 0262), ANTES DE TODA
  -- OUTRA. O passo 5 reponta `calendar_appointments.contact_id`, e o trigger
  -- desse repontamento pede `pg_advisory_xact_lock_shared(org, 262)`, só que
  -- a esta altura a fusão já segura os contatos (passos 2 e 3).
  -- `fn_definir_cliente_pela_agenda` pega a mesma trava EXCLUSIVA e depois
  -- trava contato por contato. Medido com duas sessões, sem esta linha: a fusão
  -- morria em `deadlock detected` e a rota devolvia 500. Aqui a ordem fica a
  -- mesma das duas funções, a organização primeiro, os contatos depois. Duas
  -- fusões, ou uma fusão e uma marcação, pegam a versão compartilhada e não se
  -- esperam.
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(p_organization_id::text, 262));

  -- Mesmo mutex dos atendimentos, ANTES de qualquer row lock.
  for v_service_contact in select distinct id from unnest(array[p_contato_principal]||p_contatos_secundarios) ids(id) order by id loop
    perform public.fn_service_lock(p_organization_id,v_service_contact);
  end loop;
  perform 1 from public.conversations where organization_id=p_organization_id
    and contact_id=any(array[p_contato_principal]||p_contatos_secundarios) order by id for no key update;

  -- Conversa colidente NÃO aborta a fusão. Duas conversas no mesmo
  -- `channel_session_id` é exatamente COMO a duplicata de WhatsApp nasce (dois
  -- cadastros, dois números, o mesmo número de atendimento), então recusar aqui
  -- fecharia o caminho dominante do recurso, medido: o caso ordinário do
  -- `tests/e2e/juntar-contatos-duplicados.spec.ts` virava 409.
  -- Quem trata a colisão é o passo 5: `uniq_conversations_1to1_per_contact_session`
  -- levanta unique_violation, o repontamento cai para linha a linha, a conversa
  -- que não coube FICA na lápide e sai contada em `nao_repontado`, que a rota
  -- devolve e a tela anuncia ("N registro(s) continuaram no cadastro antigo").
  -- Mensagem não se perde: `messages.contact_id` não tem índice único por
  -- contato e passa inteira para o vencedor.

  -- 2 · O principal existe, é desta org, está vivo, e trava até o fim.
  select * into v_principal from public.contacts
   where id = p_contato_principal
     and organization_id = p_organization_id
     and is_merged_into is null
     and is_anonymized = false
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'contato_principal_indisponivel';
  end if;

  -- 3 · Os secundários também. `is_anonymized = false` não é zelo: L-04 é
  --     irreversível, e reencaixar a linha anonimizada num contato ativo a
  --     traria de volta ao atendimento pela porta dos fundos.
  perform 1 from public.contacts
   where id = any(p_contatos_secundarios)
     and organization_id = p_organization_id
     and is_merged_into is null
     and is_anonymized = false
   for update;
  get diagnostics v_achado = row_count;
  if v_achado <> v_esperado then
    raise exception using errcode = 'P0002', message = 'contato_secundario_indisponivel';
  end if;

  -- 4 · A LÁPIDE VEM ANTES de tudo. É ela que solta telefone/e-mail/CPF dos
  --     índices únicos parciais para o vencedor poder herdá-los no passo 6.
  update public.contacts
     set is_merged_into = p_contato_principal,
         merged_at = now(),
         updated_at = now()
   where organization_id = p_organization_id
     and id = any(p_contatos_secundarios);

  -- Cadeia: quem já tinha sido mesclado NUM dos secundários passa a apontar para
  -- o vencedor. Sem isto, `is_merged_into` vira uma corrente que a leitura teria
  -- de percorrer, e ninguém percorre.
  update public.contacts
     set is_merged_into = p_contato_principal
   where organization_id = p_organization_id
     and is_merged_into = any(p_contatos_secundarios);

  -- 4b · (9043) Os telefones extras das absorvidas que repetem o número ou o
  --     `lid` da ficha que fica saem ANTES do repontamento: o repetido não é
  --     registro perdido, é o mesmo número, e não pode cair no
  --     `unique_violation` do laço nem ser contado em `nao_repontado`. Os
  --     demais seguem para a ficha que fica pelo repontamento do catálogo.
  delete from public.contact_phones t
   where t.organization_id = p_organization_id
     and t.contact_id = any(p_contatos_secundarios)
     and (
       t.phone_number = public.fn_telefone_canonico(v_principal.phone_number)
       or (t.wa_lid is not null and t.wa_lid = v_principal.wa_lid)
     );

  -- 5 · Reponta TODO ponteiro para os perdedores. A lista sai do catálogo; o
  --     polimórfico entra à mão porque catálogo nenhum o conhece.
  for v_alvo in
    select n.nspname as esquema, c.relname as tabela, a.attname as coluna, ''::text as filtro
      from pg_catalog.pg_constraint co
      join pg_catalog.pg_class c on c.oid = co.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      -- 0611: a POSIÇÃO da coluna que referencia `contacts.id`. FK COMPOSTA ficava fora do
      -- repontamento, e a ficha do módulo continuava apontando para o contato que SAIU da fusão.
      -- `left join lateral`, não subquery escalar no `ON`: a escalar zerava o laço inteiro.
      left join lateral (
        select k.ord
          from pg_catalog.unnest(co.confkey) with ordinality as k(attnum, ord)
          join pg_catalog.pg_attribute fa
            on fa.attrelid = co.confrelid and fa.attnum = k.attnum
         where fa.attname = 'id'
         limit 1
      ) pos on true
      join pg_catalog.pg_attribute a
        on a.attrelid = co.conrelid
       and a.attnum = co.conkey[coalesce(pos.ord, 1)]
     where co.contype = 'f'
       and co.confrelid = 'public.contacts'::regclass
       and co.conrelid <> 'public.contacts'::regclass
       and c.relkind = 'r'
       and n.nspname = 'public'
    union all
    select 'public', 'crm_lead_links', 'target_id', ' and target_kind = ''contact'''
     where to_regclass('public.crm_lead_links') is not null
    order by 2, 3
  loop
    v_pulados := 0;
    begin
      execute format(
        'update %I.%I set %I = $1 where %I = any($2)%s',
        v_alvo.esquema, v_alvo.tabela, v_alvo.coluna, v_alvo.coluna, v_alvo.filtro
      ) using p_contato_principal, p_contatos_secundarios;
      get diagnostics v_movidas = row_count;
    exception when unique_violation or exclusion_violation then
      -- Colisão REAL e esperada: `uniq_job_queue_one_running_per_contact` deixa
      -- um job 'running' por contato, e os dois lados podem ter um. Em vez de
      -- abortar a fusão inteira por causa de estado efêmero de runtime, reponta
      -- linha a linha e conta quem ficou. Quem fica NÃO vira FK órfã, continua
      -- apontando para a lápide, que existe.
      v_movidas := 0;
      for v_linha in execute format(
        'select ctid as tid from %I.%I where %I = any($1)%s',
        v_alvo.esquema, v_alvo.tabela, v_alvo.coluna, v_alvo.filtro
      ) using p_contatos_secundarios
      loop
        begin
          execute format(
            'update %I.%I set %I = $1 where ctid = $2',
            v_alvo.esquema, v_alvo.tabela, v_alvo.coluna
          ) using p_contato_principal, v_linha.tid;
          v_movidas := v_movidas + 1;
        exception when unique_violation or exclusion_violation then
          v_pulados := v_pulados + 1;
        end;
      end loop;
    end;

    if v_movidas > 0 then
      v_repontado := v_repontado
        || jsonb_build_object(v_alvo.tabela || '.' || v_alvo.coluna, v_movidas);
    end if;
    if v_pulados > 0 then
      v_nao_repontado := v_nao_repontado
        || jsonb_build_object(v_alvo.tabela || '.' || v_alvo.coluna, v_pulados);
    end if;
  end loop;

  -- 6 · O principal MANDA; o que ele não tem, vem dos perdedores. Nunca o
  --     contrário: sobrescrever o que o atendente digitou seria fusão com
  --     surpresa, e fusão não tem desfazer.
  -- (#3721) O `name` é a EXCEÇÃO da herança, e a mais forte de todas: não é um
  -- dado que falta, é a IDENTIDADE da ficha — o título na tela e o `{{nome}}`
  -- das automações. Herdá-lo do perdedor trocava o nome de quem o operador
  -- acabou de escolher para ficar, em silêncio e sem desfazer. Então ele não é
  -- herdado em caso nenhum; o que se guarda é o HISTÓRICO de quem foi absorvido
  -- com nome, para a ficha não perder o rastro.
  select coalesce(
           jsonb_agg(jsonb_build_object('contato_id', c.id, 'name', btrim(c.name))
                     order by c.created_at, c.id),
           '[]'::jsonb)
    into v_nomes_absorvidos
    from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and nullif(btrim(c.name), '') is not null;
  -- O `display_name` é o RÓTULO do canal, não o nome que alguém digitou — segue
  -- herdado, mas só quando o vencedor já tem `name`: sem ele, o rótulo herdado
  -- seria o título (`name ?? display_name`) e o defeito voltaria por aqui.
  select c.display_name into v_apelido from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.display_name is not null
   order by c.created_at, c.id limit 1;
  select c.birthdate into v_nascimento from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.birthdate is not null
   order by c.created_at, c.id limit 1;
  select c.email into v_email from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.email is not null
   order by c.created_at, c.id limit 1;
  select c.phone_number into v_telefone from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.phone_number is not null
   order by c.created_at, c.id limit 1;
  -- `wa_identity`/`wa_lid` são GERADAS: o que se herda é a origem delas. Sem
  -- isto o WhatsApp do perdedor fica órfão, `fn_upsert_wa_contact` filtra
  -- `is_merged_into is null`, não acharia mais ninguém e criaria um contato
  -- novo na mensagem seguinte, refazendo a duplicata que acabou de ser desfeita.
  -- (9043) Primeiro o `lid` da absorvida cujo telefone vira o principal: o
  -- número e o WhatsApp dele andam juntos.
  select c.source_metadata->>'waha_lid' into v_lid from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and c.source_metadata->>'waha_lid' is not null
   order by (v_principal.phone_number is null and c.phone_number is not distinct from v_telefone) desc,
            c.created_at, c.id limit 1;
  -- A identidade social é a MESMA razão do `waha_lid`, pelo lado de quem fala
  -- por rede social: com o #1444 `upsertSocialContact` filtra
  -- `is_merged_into is null`, então sem herdar a identidade a próxima DM daquela
  -- pessoa não acha ficha viva com esta identidade e abre uma nova, refazendo a
  -- duplicata que a fusão acabou de desfazer (issue #1455). O índice
  -- `contacts_org_social_identity_unique` é parcial em `is_merged_into is null`,
  -- então o único conflito possível é com um TERCEIRO contato vivo.
  select c.social_identity into v_social from public.contacts c
   where c.id = any(p_contatos_secundarios)
     and c.social_identity is not null
   order by c.created_at, c.id limit 1;

  -- Guardas de unicidade. A lápide já tirou os perdedores dos índices parciais,
  -- então o que sobrar aqui é conflito com um TERCEIRO contato vivo, e nesse
  -- caso o vencedor simplesmente não herda o campo. Falhar a fusão inteira por
  -- causa de um e-mail seria perder o repontamento que já valeu a pena.
  if v_email is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.email_normalized = lower(btrim(v_email))
  ) then v_email := null; end if;
  -- (9043) Pela forma canônica e olhando os extras: o número que já é extra de
  -- alguém (inclusive da ficha que fica) não pode virar principal — a regra
  -- "um número, uma ficha" recusaria e a fusão inteira cairia.
  if v_telefone is not null and (exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.phone_number is not null
       and public.fn_telefone_canonico(o.phone_number) = public.fn_telefone_canonico(v_telefone)
  ) or exists (
    select 1 from public.contact_phones t
     where t.organization_id = p_organization_id
       and t.phone_number = public.fn_telefone_canonico(v_telefone)
  )) then v_telefone := null; end if;
  if v_lid is not null and (exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.wa_lid = v_lid
  ) or exists (
    select 1 from public.contact_phones t
     where t.organization_id = p_organization_id and t.wa_lid = v_lid
  )) then v_lid := null; end if;
  if v_social is not null and exists (
    select 1 from public.contacts o
     where o.organization_id = p_organization_id and o.is_merged_into is null
       and o.id <> p_contato_principal and o.social_identity = v_social
  ) then v_social := null; end if;

  -- O QUE RESTRINGE VAI COM A FICHA (D-143). O opt-out do titular vive só em
  -- `contacts.is_blocked` e a trava de IA em `force_human`: o principal herda o
  -- telefone do secundário, então se a ficha que pediu para sair some na lápide
  -- e o vencedor volta `is_blocked = false`, IA, campanha e prospecção voltam a
  -- escrever para quem pediu opt-out. Aqui é o contrário do resto da fusão (o
  -- principal manda): para restrição, vale a mais restritiva dos dois lados.
  select coalesce(v_principal.is_blocked, false) or coalesce(bool_or(c.is_blocked), false),
         coalesce(v_principal.force_human, false) or coalesce(bool_or(c.force_human), false)
    into v_bloqueado, v_force_human
    from public.contacts c
   where c.id = any(p_contatos_secundarios);
  -- Quando quem herda o bloqueio é o secundário, leva o carimbo e o motivo dele
  -- (o bloqueio mais antigo), para o registro de quando e por quê continuar verdadeiro.
  select c.blocked_at, c.blocked_reason into v_bloqueado_em, v_bloqueado_motivo
    from public.contacts c
   where c.id = any(p_contatos_secundarios) and c.is_blocked
   order by c.blocked_at nulls last, c.created_at, c.id limit 1;
  -- `consent`: continua sem herdar concessão (seria fabricar consentimento), mas a
  -- RECUSA registrada no cadastro que sai vale: toda chave recusada num secundário
  -- (valor `false`, ou objeto com `revoked_at` preenchido) passa ao principal com o
  -- mesmo valor.
  select jsonb_object_agg(e.key, e.value) into v_consent_restrito
    from public.contacts c, lateral jsonb_each(coalesce(c.consent, '{}'::jsonb)) e
   where c.id = any(p_contatos_secundarios)
     and jsonb_typeof(c.consent) = 'object'
     and (e.value = 'false'::jsonb
          or (jsonb_typeof(e.value) = 'object' and e.value->>'revoked_at' is not null));

  -- (9043) `custom_fields`: a chave que a ficha que fica não tem entra; em
  -- chave repetida vence a ficha que fica e, entre absorvidas, a primeira
  -- (por `created_at, id`, a ordem de todo o resto). Antes, o que estava na
  -- absorvida ficava só na lápide.
  select coalesce(jsonb_object_agg(s.chave, s.valor), '{}'::jsonb) into v_campos
    from (
      select distinct on (e.key) e.key as chave, e.value as valor
        from public.contacts c
        cross join lateral jsonb_each(
          case when jsonb_typeof(c.custom_fields) = 'object' then c.custom_fields else '{}'::jsonb end
        ) as e
       where c.organization_id = p_organization_id
         and c.id = any(p_contatos_secundarios)
       order by e.key, c.created_at, c.id
    ) as s;

  select coalesce(array_agg(distinct t), '{}'::text[]) into v_tags
    from (
      select unnest(c.tags) as t from public.contacts c
       where c.organization_id = p_organization_id
         and (c.id = p_contato_principal or c.id = any(p_contatos_secundarios))
    ) as todas;

  -- CPF e `consent` NÃO são herdados, de propósito. CPF é um PAR
  -- (`cpf_encrypted` + `cpf_hash`) preso por check constraint e criptografado
  -- com a chave da instalação, mover metade quebra a linha. `consent` é
  -- registro legal do que AQUELA pessoa autorizou; herdar um "granted_at" de
  -- outro cadastro fabricaria consentimento. Falha fechada nos dois.
  -- (#3721) `name` NÃO entra no SET: o título da ficha é de quem fica (passo 6).
  update public.contacts set
    display_name = coalesce(
      display_name,
      case when name is null then null else v_apelido end
    ),
    birthdate = coalesce(birthdate, v_nascimento),
    email = coalesce(email, v_email),
    phone_number = coalesce(phone_number, v_telefone),
    social_identity = coalesce(social_identity, v_social),
    is_blocked = v_bloqueado,
    blocked_at = case
      when v_bloqueado then coalesce(blocked_at, v_bloqueado_em, now())
      else blocked_at end,
    blocked_reason = case
      when v_bloqueado then coalesce(blocked_reason, v_bloqueado_motivo)
      else blocked_reason end,
    force_human = v_force_human,
    consent = case
      when v_consent_restrito is not null
        then coalesce(consent, '{}'::jsonb) || v_consent_restrito
      else consent end,
    tags = v_tags,
    custom_fields = v_campos || coalesce(custom_fields, '{}'::jsonb),
    last_activity_at = greatest(
      last_activity_at,
      (select max(c.last_activity_at) from public.contacts c
        where c.id = any(p_contatos_secundarios))
    ),
    source_metadata = (
      case when source_metadata->>'waha_lid' is null and v_lid is not null
        then source_metadata || jsonb_build_object('waha_lid', v_lid)
        else source_metadata end
    )
      - case when coalesce(phone_number, v_telefone) is not null
             then 'telefone_em_conflito' else '' end
      || jsonb_build_object(
           'mesclado_de',
           coalesce(source_metadata->'mesclado_de', '[]'::jsonb)
             || to_jsonb(p_contatos_secundarios),
           'mesclado_em', to_jsonb(now())
         )
      -- (#3721) O nome do perdedor vira HISTÓRICO da ficha. `{}` || x = x:
      -- fusão sem perdedor com nome não acrescenta chave nenhuma.
      || case when jsonb_array_length(v_nomes_absorvidos) > 0
              then jsonb_build_object(
                     'nomes_absorvidos',
                     coalesce(source_metadata->'nomes_absorvidos', '[]'::jsonb)
                       || v_nomes_absorvidos)
              else '{}'::jsonb end,
    updated_at = now()
  where id = p_contato_principal and organization_id = p_organization_id;

  -- 6b · (9043) O telefone principal de cada absorvida vira telefone extra da
  --     ficha que fica, com tipo, WhatsApp e o `lid` dela — sem isto, a próxima
  --     mensagem daquele número não acha ficha viva e abre uma terceira. Fica de
  --     fora o número que a ficha que fica já tem (principal ou extra) e o de
  --     uma terceira ficha viva (como o e-mail, não herda). O `lid` que já é de
  --     alguém vivo não vai junto.
  for v_sec in
    select c.phone_number, c.phone_type, c.phone_whatsapp,
           nullif(regexp_replace(coalesce(c.source_metadata->>'waha_lid', ''), '@.*$', ''), '') as lid
      from public.contacts c
     where c.organization_id = p_organization_id
       and c.id = any(p_contatos_secundarios)
       and c.phone_number is not null
     order by c.created_at, c.id
  loop
    v_canon := public.fn_telefone_canonico(v_sec.phone_number);
    continue when v_canon is null;
    continue when exists (
      select 1 from public.contacts o
       where o.organization_id = p_organization_id and o.is_merged_into is null
         and o.phone_number is not null
         and public.fn_telefone_canonico(o.phone_number) = v_canon
    ) or exists (
      select 1 from public.contact_phones t
       where t.organization_id = p_organization_id and t.phone_number = v_canon
    );
    v_lid_extra := v_sec.lid;
    if v_lid_extra is not null and (exists (
      select 1 from public.contacts o
       where o.organization_id = p_organization_id and o.is_merged_into is null
         and o.wa_lid = v_lid_extra
    ) or exists (
      select 1 from public.contact_phones t
       where t.organization_id = p_organization_id and t.wa_lid = v_lid_extra
    )) then
      v_lid_extra := null;
    end if;
    insert into public.contact_phones
      (organization_id, contact_id, phone_number, tipo, whatsapp, origem, wa_lid)
    values
      (p_organization_id, p_contato_principal, v_canon,
       coalesce(v_sec.phone_type, public.fn_tipo_do_telefone(v_canon)),
       coalesce(v_sec.phone_whatsapp, 'nao_sei'), 'fusao', v_lid_extra);
  end loop;

  -- 7 · A fusão aparece na timeline de cada negócio que o vencedor passou a ter.
  --     `crm_lead_activities.lead_id` é NOT NULL, contato sem negócio nenhum
  --     não tem onde escrever, e para esse caso quem guarda o rastro é o
  --     `api_audit_log` que a rota emite, sempre.
  insert into public.crm_lead_activities
    (organization_id, lead_id, contact_id, source_module, source_id, type,
     payload, metadata, performed_at, performed_by_user_id)
  select p_organization_id, l.id, p_contato_principal, 'crm', p_contato_principal,
         'contacts_merged',
         jsonb_build_object(
           'contatos_mesclados', to_jsonb(p_contatos_secundarios),
           'repontado', v_repontado,
           'nao_repontado', v_nao_repontado
         ),
         '{}'::jsonb, now(), auth.uid()
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.contact_id = p_contato_principal;
  get diagnostics v_leads = row_count;

  return jsonb_build_object(
    'contato_id', p_contato_principal,
    'contatos_mesclados', to_jsonb(p_contatos_secundarios),
    'nomes_absorvidos', v_nomes_absorvidos,
    'repontado', v_repontado,
    'nao_repontado', v_nao_repontado,
    'atividades_emitidas', v_leads
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_mover_leads_em_lote(p_organization_id uuid, p_lead_ids uuid[], p_stage_id uuid, p_lost_reason text DEFAULT NULL::text)
 RETURNS TABLE(lead_id uuid, from_stage_id uuid, pipeline_id uuid)
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_min numeric;
  v_total int;
  -- Motivo em branco é ausência de motivo, nunca um motivo de uma letra.
  v_motivo text := nullif(btrim(coalesce(p_lost_reason, '')), '');
  v_coluna_motivo text := '';
  v_etapa_org uuid;
  v_etapa_funil uuid;
  v_filtro_novos text := '';
  v_filtro_preservados text := 'false';
begin
  -- D-150: a etapa de destino é da MESMA organização e do MESMO funil de todo lead do lote.
  -- A rota já confere; aqui a regra mora no banco, onde todo chamador passa. Erro genérico
  -- (PT404/PT422), sem dizer se o id existe noutra organização.
  select s.organization_id, s.pipeline_id into v_etapa_org, v_etapa_funil
    from public.crm_stages s where s.id = p_stage_id;
  if not found or v_etapa_org is distinct from p_organization_id then
    raise exception 'Etapa não encontrada.' using errcode = 'PT404';
  end if;
  if exists (
    select 1 from public.crm_leads l
     where l.organization_id = p_organization_id
       and l.id = any(p_lead_ids)
       and l.pipeline_id is distinct from v_etapa_funil
  ) then
    raise exception 'Etapa de outro funil: use a transferência entre funis.' using errcode = 'PT422';
  end if;

  -- Quantos cards o lote tem DE VERDADE. O predicado é o MESMO do `alvo` da
  -- escrita (organização + ids): contar por `array_length(p_lead_ids)` somaria
  -- id de outra organização — que o `alvo` descarta —, e a posição do primeiro
  -- card sairia de uma conta que inclui card que não vai ser movido.
  select count(*)
    into v_total
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.id = any(p_lead_ids);

  -- Onde o lote ENCOSTA: o primeiro card da etapa de destino, sem contar os que
  -- já estão no lote. `null` é a etapa vazia — e aí o lote ocupa o miolo de
  -- sempre (1000, 2000, …), pelo `coalesce` da escrita.
  select min(l.position_in_stage)
    into v_min
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.stage_id = p_stage_id
     and not (l.id = any(p_lead_ids));

  -- Só com motivo a gravar a coluna entra na escrita (0263; ver o cabeçalho) —
  -- e só quem NÃO estava perdido recebe a coluna (#2887). Sem motivo, o ramo dos
  -- novos leva o lote inteiro e o dos preservados não casa nenhuma linha.
  if v_motivo is not null then
    v_coluna_motivo := ', lost_reason = $4';
    v_filtro_novos := ' and l.status is distinct from ''lost''';
    v_filtro_preservados := 'l.status = ''lost''';
  end if;

  return query execute format($f$
  with alvo as (
    select l.id,
           l.stage_id    as from_stage_id,
           l.pipeline_id as pipeline_id,
           -- A ordem do lote no destino é a ordem em que ele estava no quadro:
           -- etapa, depois posição. `id` só desempata para o resultado ser
           -- determinístico (dois cards podem legitimamente empatar hoje :
           -- é justamente o estado que a migration 0209 deixa de produzir).
           row_number() over (order by l.stage_id, l.position_in_stage, l.id) as ordem
      from public.crm_leads l
     where l.organization_id = $1
       and l.id = any($2)
  ),
  novos as (
    update public.crm_leads l
       set stage_id          = $3,
           -- O TOPO da etapa (issue #3461): o lote inteiro encosta ACIMA do
           -- primeiro card e mantém entre si a ordem de origem. $5 é esse
           -- primeiro card; $6, o tamanho do lote. Etapa vazia ($5 nulo) cai
           -- no `coalesce` e ocupa 1000, 2000, … como um card criado à mão.
           position_in_stage = coalesce($5 - (($6 - a.ordem + 1) * 1000), a.ordem * 1000),
           updated_at        = now()%s
      from alvo a
     where l.id = a.id
       and l.organization_id = $1%s
    returning l.id, a.from_stage_id, a.pipeline_id
  ),
  preservados as (
    update public.crm_leads l
       set stage_id          = $3,
           position_in_stage = coalesce($5 - (($6 - a.ordem + 1) * 1000), a.ordem * 1000),
           updated_at        = now()
      from alvo a
     where l.id = a.id
       and l.organization_id = $1
       and %s
    returning l.id, a.from_stage_id, a.pipeline_id
  )
  select n.id, n.from_stage_id, n.pipeline_id from novos n
  union all
  select p.id, p.from_stage_id, p.pipeline_id from preservados p
  $f$, v_coluna_motivo, v_filtro_novos, v_filtro_preservados)
  using p_organization_id, p_lead_ids, p_stage_id, v_motivo, v_min, v_total;
end;
$function$;

create or replace function public.fn_redigir_conversas_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
declare
  v_ext text := old.source_metadata->>'nuvemshop_customer_id';
  v_variantes text[];
  v_lids text[];
  v_msgs_de_grupo uuid[];
begin
  insert into public.storage_redaction_queue (organization_id, bucket, object_path)
  select distinct new.organization_id, 'whatsapp-media', m.media_storage_path
    from public.messages m
   where m.organization_id = new.organization_id
     and m.conversation_id in (
       select c.id from public.conversations c
        where c.contact_id = new.id and c.organization_id = new.organization_id)
     and m.media_storage_path is not null
     and length(m.media_storage_path) > 0
  on conflict (bucket, object_path) do nothing;

  update public.messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    media_derived_text = null,
    media_derived_status = case when media_derived_status is null then null else 'ready' end,  -- vocabulário (0497): diz ao drain que terminou
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = new.organization_id
    and conversation_id in (
      select c.id from public.conversations c
       where c.contact_id = new.id and c.organization_id = new.organization_id);

  update public.conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    last_handoff_reason = null,
    updated_at = now()
  where contact_id = new.id and organization_id = new.organization_id;

  update public.lead_checkpoints set
    rolling_summary = '[resumo anonimizado]',
    commitments = '[]'::jsonb,
    objections = '[]'::jsonb,
    next_action = null,
    declaracao = null
  where contact_id = new.id and organization_id = new.organization_id;

  -- ── issue #1964 — lead_notes: a memória do agente sobre o contato ─────────
  update public.lead_notes set
    headline = '(anonimizado)',
    body = '(anonimizado)',
    embedding = null,
    updated_at = now()
  where organization_id = new.organization_id
    and contact_id = new.id
    and (headline is distinct from '(anonimizado)'
         or body is distinct from '(anonimizado)'
         or embedding is not null);

  -- Hiperbold (0921, D-142): notas internas da conversa, trechos indexados da conversa e
  -- o rastro do titular nas integrações (fn_limpar_rastro_do_titular).
  update public.conversation_notes set
    body = '[nota anonimizada]'
  where organization_id = new.organization_id
    and conversation_id in (
      select c.id from public.conversations c
       where c.contact_id = new.id and c.organization_id = new.organization_id);

  delete from public.ai_chunks a
   using public.conversations c
   where c.contact_id = new.id and c.organization_id = new.organization_id
     and a.organization_id = new.organization_id
     and a.metadata @> jsonb_build_object('conversation_id', c.id);

  perform public.fn_limpar_rastro_do_titular(new.organization_id, new.id, v_ext);

  -- ── issue #1964 — ai_agent_runs.tool_calls: preserva o nome e redige o resto
  -- A transformação espelha `redigirToolCalls` (lib/lgpd/cascata.ts): cada
  -- passo vira `{ step?, tool_name?, redacted: true, tool_calls: [{ tool_name }] }`.
  -- Fica QUAIS ferramentas rodaram e em que passo; sai o texto do modelo, os
  -- argumentos e os resultados. Guard no WHERE: só corre quando há passo sem
  -- `redacted`, então o `[]` de nascença e a run já redigida não são tocados.
  update public.ai_agent_runs set
    tool_calls = public.fn_lgpd_redigir_tool_calls(ai_agent_runs.tool_calls)
  where ai_agent_runs.organization_id = new.organization_id
    and ai_agent_runs.contact_id = new.id
    and exists (
      select 1 from jsonb_array_elements(ai_agent_runs.tool_calls) s
       where coalesce(s->>'redacted', 'false')::boolean is not true
    );

  -- ── issue #1964 — lead_state: a próxima ação e a qualificação da lead ─────
  update public.lead_state set
    next_action = null,
    qualification = '{}'::jsonb,
    updated_at = now()
  where organization_id = new.organization_id
    and contact_id = new.id
    and (next_action is not null
         or coalesce(qualification, '{}'::jsonb) <> '{}'::jsonb);

  -- ── issue #1964 — contacts.social_identity ───────────────────────────────
  -- O índice único parcial `where social_identity is not null` torna anular
  -- seguro (a linha sai do índice sem violar unicidade). Guard no WHERE para a
  -- varredura não reescrever o que já está anonimizado.
  update public.contacts set
    social_identity = null,
    updated_at = now()
  where id = new.id
    and organization_id = new.organization_id
    and social_identity is not null;

  -- Mensagens de grupo escritas pelo titular (0482, ver o cabeçalho daquele bloco).
  -- (9043) O principal E os telefones extras. O gatilho roda no `update` da
  -- ficha, ANTES de `fn_lgpd_cascade_redact_contact` apagar os extras: é por
  -- isso que eles ainda estão aqui para serem lidos.
  select coalesce(array_agg(distinct v), '{}') into v_variantes
    from (
      select unnest(public.fn_telefone_variantes(coalesce(old.phone_number, new.phone_number))) as v
      union all
      select unnest(public.fn_telefone_variantes(t.phone_number))
        from public.contact_phones t
       where t.organization_id = new.organization_id and t.contact_id = new.id
    ) as todas;
  select coalesce(array_agg(distinct l), '{}') into v_lids
    from (
      select coalesce(old.wa_lid, new.wa_lid) as l
      union all
      select t.wa_lid from public.contact_phones t
       where t.organization_id = new.organization_id and t.contact_id = new.id
    ) as todos
   where l is not null;

  select coalesce(array_agg(m.id), '{}')
    into v_msgs_de_grupo
    from public.messages m
   where m.organization_id = new.organization_id
     and m.metadata ? 'group_sender'
     and (
       regexp_replace(coalesce(m.metadata->'group_sender'->>'phone', ''), '\D', '', 'g') = any(v_variantes)
       or (m.metadata->'group_sender'->>'lid' = any(v_lids))
     );

  if cardinality(v_msgs_de_grupo) > 0 then
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select distinct new.organization_id, 'whatsapp-media', m.media_storage_path
      from public.messages m
     where m.organization_id = new.organization_id
       and m.id = any(v_msgs_de_grupo)
       and m.media_storage_path is not null
       and length(m.media_storage_path) > 0
    on conflict (bucket, object_path) do nothing;

    update public.conversations set
      last_message_preview = null,
      updated_at = now()
    where organization_id = new.organization_id
      and id in (select m.conversation_id from public.messages m
                  where m.organization_id = new.organization_id and m.id = any(v_msgs_de_grupo));

    update public.messages set
      body = '[mensagem anonimizada]',
      media_url = null,
      media_mime = null,
      media_size_bytes = null,
      media_storage_path = null,
      media_derived_text = null,
      metadata = '{}'::jsonb,
      updated_at = now()
    where organization_id = new.organization_id
      and id = any(v_msgs_de_grupo);
  end if;

  return new;
end
$f$;

create or replace function public.fn_reserve_channel_connection(p_org uuid,p_key uuid,p_hash text,p_display_name text default null,p_onboarding boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare receipt public.channel_connection_requests; channel public.channel_sessions; token uuid:=gen_random_uuid();
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org)
 then raise exception 'connection_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'connection_mfa_required' using errcode='42501';end if;
 if p_key is null or p_hash is null or length(p_hash)<>64 or length(coalesce(p_display_name,''))>100 then
  raise exception 'connection_invalid_request' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,2281));
 delete from public.channel_connection_requests where organization_id=p_org and idempotency_key=p_key
  and state='succeeded' and updated_at<now()-interval '24 hours';
 select * into receipt from public.channel_connection_requests where organization_id=p_org and idempotency_key=p_key for update;
 if found then
  if receipt.request_hash<>p_hash then raise exception 'idempotency_conflict' using errcode='22023';end if;
  if receipt.state='succeeded' then
   select * into channel from public.channel_sessions where organization_id=p_org and id=receipt.channel_session_id;
   return jsonb_build_object('replay',true,'channel',to_jsonb(channel),'receipt_id',receipt.id);
  end if;
  if receipt.state='processing' and receipt.lease_until>now() then
   raise exception 'connection_in_progress' using errcode='55P03';end if;
  select * into channel from public.channel_sessions where organization_id=p_org and id=receipt.channel_session_id for update;
  if not found then raise exception 'connection_reservation_missing' using errcode='P0002';end if;
 else
  if p_onboarding then
   select * into channel from public.channel_sessions where organization_id=p_org and provider='waha'
    and (metadata->>'onboarding'='true' or waha_session_name='org_'||left(p_org::text,8))
    order by created_at limit 1 for update;
  end if;
  if channel.id is null then
   insert into public.channel_sessions(organization_id,waha_session_name,display_name,engine,webhook_path_token,
     webhook_secret_encrypted,status,last_status_change_at,consecutive_health_fails,daily_message_limit,metadata)
   values(p_org,'org_'||left(replace(p_org::text,'-',''),8)||'_'||replace(gen_random_uuid()::text,'-',''),p_display_name,'NOWEB',
     replace(gen_random_uuid()::text,'-',''),'\x00'::bytea,'STARTING',now(),0,250,
     '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}'::jsonb
     || case when p_onboarding then '{"onboarding":true}'::jsonb else '{}'::jsonb end) returning * into channel;
  end if;
  if exists(select 1 from public.channel_connection_requests where organization_id=p_org and channel_session_id=channel.id
    and (state='processing' and lease_until>now())) then raise exception 'connection_in_progress' using errcode='55P03';end if;
  insert into public.channel_connection_requests(organization_id,idempotency_key,request_hash,channel_session_id)
   values(p_org,p_key,p_hash,channel.id) returning * into receipt;
 end if;
 if exists(select 1 from public.channel_connection_requests where organization_id=p_org and channel_session_id=channel.id
   and id<>receipt.id and (state='processing' and lease_until>now())) then raise exception 'connection_in_progress' using errcode='55P03';end if;
 update public.channel_connection_requests set state='processing',lease_token=token,lease_until=now()+interval '5 minutes',
  remote_created=false,updated_at=now() where organization_id=p_org and id=receipt.id;
 -- 9036: reviver a linha morta e sem número volta a ocupar a vaga do plano.
 perform public.fn_vaga_ao_reviver_canal(p_org,channel.id);
 update public.channel_sessions set status='STARTING',status_reason='connection_pending',last_status_change_at=now()
  where organization_id=p_org and id=channel.id returning * into channel;
 return jsonb_build_object('replay',false,'channel',to_jsonb(channel),'receipt_id',receipt.id,'lease_token',token);
end;
$$;

create or replace function public.fn_seed_org_llm_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_llm    jsonb;
  v_lista  text;
  v_modelo text;
begin
  if coalesce(new.settings->'llm'->>'default_model', '') = '' then
    -- Upstream (9096): o molde de IA da instalação, quando configurado, decide.
    v_llm := public.fn_llm_do_molde_de_ia();
    if v_llm is null then
      -- Hiperbold (0973): sem molde, OpenRouter com o primeiro da lista liberada
      -- na chave da instalação. `platform_config` pode não existir num clone com
      -- o schema atrasado: nesse caso vale o literal.
      begin
        select valor into v_lista
          from public.platform_config
         where chave = 'MODELOS_DA_INSTALACAO' and not eh_segredo
         limit 1;
      exception when others then
        v_lista := null;
      end;
      v_modelo := nullif(btrim(split_part(regexp_replace(coalesce(v_lista, ''), '[;' || chr(10) || ']', ',', 'g'), ',', 1)), '');
      if v_modelo is null or v_modelo = '*' then
        v_modelo := 'openai/gpt-6-luna';
      end if;
      v_llm := jsonb_build_object('provider', 'openrouter', 'default_model', v_modelo);
    end if;
    new.settings := jsonb_set(
      coalesce(new.settings, '{}'::jsonb),
      '{llm}',
      coalesce(new.settings->'llm', '{}'::jsonb) || v_llm,
      true);
  end if;
  return new;
end;
$$;

-- ---- o merge do upstream de 04/11/2026: escrita de admin de plataforma só no escopo full (migration 0992, fork Hiperbold) ----
--
-- Upstream (0508): uma policy de ESCRITA com fn_is_platform_admin() deixa o admin de plataforma
-- `support_readonly` gravar; a escrita passa a pedir fn_is_platform_admin_full(). As policies que o
-- fork reescreveu por papel (0923, 0926, 0932, 0975, 0976 e afins) ainda chamavam a função antiga.
-- Este bloco aplica a régua do upstream a toda policy de INSERT, UPDATE ou DELETE de `public`, sem
-- mexer no resto da expressão. Policies `for all` ficam como estão (a troca tiraria a LEITURA do
-- support_readonly). Idempotente: depois da primeira passada não sobra o que trocar.
do $hb_0992_full$
declare
  p record;
  v_using text;
  v_check text;
begin
  perform set_config('lock_timeout','3s',true);
  for p in
    select pol.polname, c.relname, pg_get_expr(pol.polqual, pol.polrelid) as q,
           pg_get_expr(pol.polwithcheck, pol.polrelid) as w
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and pol.polcmd in ('a','w','d')
       and (coalesce(pg_get_expr(pol.polqual, pol.polrelid),'') ~ 'fn_is_platform_admin\(\)'
            or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid),'') ~ 'fn_is_platform_admin\(\)')
  loop
    v_using := case when p.q is null then '' else format(' using (%s)', regexp_replace(p.q, 'fn_is_platform_admin\(\)', 'fn_is_platform_admin_full()', 'g')) end;
    v_check := case when p.w is null then '' else format(' with check (%s)', regexp_replace(p.w, 'fn_is_platform_admin\(\)', 'fn_is_platform_admin_full()', 'g')) end;
    execute format('alter policy %I on public.%I%s%s', p.polname, p.relname, v_using, v_check);
  end loop;
end
$hb_0992_full$;

-- O módulo financeiro do upstream (0619) recria, ao ser reaplicado (0340), o par
-- tenant_isolation_<tabela>_read/_write. O _write é `for all` para agent+, e somaria por OR
-- com as policies por operação do fork (0923: comanda sem delete, item só em comanda aberta,
-- comissão só leitura, fidelidade só insert). Onde a tabela existe, o _write sai.
do $hb_0992_financeiro$
declare t text;
begin
  perform set_config('lock_timeout','3s',true);
  foreach t in array array['sales','sale_items','commission_rules','commissions','loyalty_ledger'] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop policy if exists %I on public.%I', 'tenant_isolation_'||t||'_write', t);
    end if;
  end loop;
end
$hb_0992_financeiro$;

-- O upstream (9037) reescreve os grants de dezenas de tabelas com `revoke all` + grant das
-- quatro operações a authenticated. Em quatro delas o fork tinha tirado a escrita da sessão do
-- usuário (0926, D-113 e D-163: quem grava é o servidor), e em webhook_sources a leitura era por
-- coluna, sem `path_token` (0948, D-128). O `revoke all` do upstream apaga também o grant por
-- coluna. Aqui as duas intenções ficam: sem TRUNCATE/REFERENCES/TRIGGER e sem anon (upstream) e
-- sem escrita de membro / sem o token na leitura (fork).
do $hb_0992_grants$
declare
  v_colunas text;
begin
  perform set_config('lock_timeout','3s',true);
  revoke insert, update, delete on table public.crm_lead_risk_states from authenticated;
  revoke insert, update, delete on table public.crm_lead_scores from authenticated;
  revoke insert, update, delete on table public.demanda_conversas from authenticated;
  revoke insert, update, delete on table public.demandas from authenticated;

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_colunas
    from information_schema.columns
   where table_schema = 'public' and table_name = 'webhook_sources' and column_name <> 'path_token';
  revoke select on table public.webhook_sources from authenticated;
  execute format('grant select (%s) on table public.webhook_sources to authenticated', v_colunas);
end
$hb_0992_grants$;

-- api_tokens: só o servidor escreve (0962) vence o par do upstream (0508). Na cadeia de migrations a
-- 0508 (01/10) derruba a api_tokens_admin_only e cria api_tokens_tenant_read (leitura para qualquer
-- admin de plataforma, support_readonly inclusive) e api_tokens_admin_write (escrita para admin de
-- plataforma full sem created_by); a 0962 (17/10) recria a admin_only, mas o par seguia somando por OR.
-- Aqui o par sai, os privilégios de sessão saem de novo e a admin_only fica exatamente como na 0962.
-- Reaplicável: drop if exists; a admin_only é trocada com alter policy (sem janela sem policy) e criada
-- só se faltar.
revoke all on public.api_tokens from public, anon, authenticated;

do $hb_0992_api_tokens$
begin
  perform set_config('lock_timeout','3s',true);
  drop policy if exists api_tokens_tenant_read on public.api_tokens;
  drop policy if exists api_tokens_admin_write on public.api_tokens;
  if exists (select 1 from pg_policy where polname = 'api_tokens_admin_only' and polrelid = 'public.api_tokens'::regclass) then
    alter policy api_tokens_admin_only on public.api_tokens
      using (public.fn_role_at_least(organization_id, 'admin'))
      with check (public.fn_role_at_least(organization_id, 'admin') and created_by = (select auth.uid()));
  else
    create policy api_tokens_admin_only on public.api_tokens
      using (public.fn_role_at_least(organization_id, 'admin'))
      with check (public.fn_role_at_least(organization_id, 'admin') and created_by = (select auth.uid()));
  end if;
end
$hb_0992_api_tokens$;
