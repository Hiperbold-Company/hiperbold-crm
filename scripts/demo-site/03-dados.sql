-- Dados fictícios da "Clínica Demonstração" (slug demo-site-2026), Supabase LOCAL.
-- Escreve só dentro dessa organização. Recusa se o funil "Vendas" já tiver negócios (não duplica).
do $$
declare
  v_org uuid; v_pipe uuid; v_canal uuid;
  u_ju uuid; u_ri uuid; u_be uuid; u_lu uuid;
  st uuid[]; v_lead uuid; v_contato uuid; v_conv uuid;
  r record; m record; i int; k int; v_owner uuid; v_criado timestamptz; v_fechado timestamptz;
  v_ultima timestamptz; v_preview text; v_inbound timestamptz;
begin
  select id into v_org from public.organizations where slug = 'demo-site-2026';
  if v_org is null then raise exception 'rode 02-org.sql antes'; end if;
  select id into u_ju from auth.users where email = 'juliana.ferraz@exemplo.com.br';
  select id into u_ri from auth.users where email = 'ricardo.almeida@exemplo.com.br';
  select id into u_be from auth.users where email = 'beatriz.santos@exemplo.com.br';
  select id into u_lu from auth.users where email = 'lucas.moreira@exemplo.com.br';

  -- ---- Funil: o padrão semeado na criação vira "Vendas" de clínica ----
  select id into v_pipe from public.crm_pipelines where organization_id = v_org and is_default limit 1;
  if exists (select 1 from public.crm_leads where organization_id = v_org) then
    raise notice 'já há negócios na org demo, nada feito'; return;
  end if;
  update public.crm_pipelines set name = 'Vendas', slug = 'vendas',
    description = 'Do primeiro contato ao tratamento fechado.',
    vocabulary = '{"won":"Ganho","deal":"Negócio","lead":"Paciente","lost":"Perdido","stage":"Etapa","deal_plural":"Negócios","lead_plural":"Pacientes","stage_plural":"Etapas"}',
    settings = jsonb_build_object(
      'fields', jsonb_build_array(
        jsonb_build_object('key','utm_source','type','text','label','utm_source'),
        jsonb_build_object('key','utm_medium','type','text','label','utm_medium'),
        jsonb_build_object('key','utm_campaign','type','text','label','utm_campaign')),
      'lost_reasons', jsonb_build_array('Preço acima do esperado','Escolheu outra clínica','Sem retorno ao contato','Vai deixar para depois'),
      'canonical_tags', jsonb_build_array('implante','clareamento','ortodontia','lentes','harmonização','limpeza'),
      'identity_resolution', jsonb_build_object('fields_in_priority_order', jsonb_build_array('cpf','phone_e164','email')))
  where id = v_pipe;
  delete from public.crm_stages where pipeline_id = v_pipe and organization_id = v_org;
  insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, color, expected_duration_hours, is_won, is_lost)
  values (v_org, v_pipe, 'Novo contato', 'novo_contato', 1000, '#3b82f6', 24, false, false),
         (v_org, v_pipe, 'Avaliação agendada', 'avaliacao', 2000, '#8b5cf6', 72, false, false),
         (v_org, v_pipe, 'Orçamento enviado', 'orcamento', 3000, '#f59e0b', 96, false, false),
         (v_org, v_pipe, 'Em negociação', 'negociacao', 4000, '#ec4899', 120, false, false),
         (v_org, v_pipe, 'Tratamento fechado', 'fechado', 5000, '#10b981', null, true, false),
         (v_org, v_pipe, 'Perdido', 'perdido', 6000, '#6b7280', null, false, true);
  select array_agg(id order by position) into st from public.crm_stages where pipeline_id = v_pipe;

  -- ---- Canal de WhatsApp (fictício; base_url inalcançável de propósito) ----
  insert into public.channel_sessions (organization_id, provider, engine, status, phone_number, display_name,
    uazapi_instance_id, uazapi_base_url, webhook_secret_encrypted, webhook_path_token, warmup_started_at, warmup_completed_at, created_by)
  values (v_org, 'uazapi', 'NOWEB', 'WORKING', '+5511940001000', 'Recepção Clínica Demonstração',
    'demo-site-2026', 'http://127.0.0.1:9', gen_random_bytes(32), encode(gen_random_bytes(24), 'hex'), now() - interval '50 days', now() - interval '40 days', u_ju)
  returning id into v_canal;

  -- ---- Contatos e negócios ----
  -- dias = há quantos dias nasceu; etapa = índice em st; dono j/r/b/l; utm = fonte/meio/campanha
  for r in select * from (values
    ( 1,'Mariana Albuquerque','+5511987214563','mariana.albuquerque@exemplo.com.br','Implante unitário', 1, 'b', 480000,'{implante}', 1,'google','cpc','implantes-sp'),
    ( 2,'Felipe Carvalho','+5511976542318','felipe.carvalho@exemplo.com.br','Clareamento dental', 1, 'l', 120000,'{clareamento}', 2,'instagram','social','clareamento-novembro'),
    ( 3,'Aline Rocha','+5511965873421','aline.rocha@exemplo.com.br','Avaliação ortodôntica', 1, 'b', 680000,'{ortodontia}', 3,null,null,null),
    ( 4,'Gustavo Pereira','+5511954128763','gustavo.pereira@exemplo.com.br','Limpeza e prevenção', 1, 'l', 35000,'{limpeza}', 2,'indicacao','indicacao',null),
    ( 5,'Renata Figueiredo','+5511943268751','renata.figueiredo@exemplo.com.br','Lentes de contato dental', 1, 'r', 1800000,'{lentes}', 4,'instagram','social','lentes-reels'),
    ( 6,'Thiago Mendes','+5511932187465','thiago.mendes@exemplo.com.br','Protocolo superior', 2, 'r', 2400000,'{implante}', 6,'google','cpc','implantes-sp'),
    ( 7,'Camila Ribeiro','+5511921876543','camila.ribeiro@exemplo.com.br','Harmonização facial', 2, 'b', 250000,'{harmonização}', 5,'instagram','social','harmonizacao'),
    ( 8,'Rodrigo Barbosa','+5511998765123','rodrigo.barbosa@exemplo.com.br','Implante + enxerto', 2, 'l', 950000,'{implante}', 8,'google','cpc','implantes-sp'),
    ( 9,'Larissa Teixeira','+5511987651234','larissa.teixeira@exemplo.com.br','Aparelho invisível', 2, 'b', 890000,'{ortodontia}', 9,'indicacao','indicacao',null),
    (10,'Eduardo Nogueira','+5511976123459','eduardo.nogueira@exemplo.com.br','Lentes em 10 dentes', 3, 'r', 2200000,'{lentes}', 12,'instagram','social','lentes-reels'),
    (11,'Patrícia Gomes','+5511965432187','patricia.gomes@exemplo.com.br','Clareamento a laser', 3, 'l', 150000,'{clareamento}', 10,'google','cpc','clareamento'),
    (12,'Bruno Azevedo','+5511954321876','bruno.azevedo@exemplo.com.br','Implante unitário', 3, 'b', 520000,'{implante}', 14,null,null,null),
    (13,'Vanessa Lima','+5511943218765','vanessa.lima@exemplo.com.br','Ortodontia adulto', 3, 'r', 760000,'{ortodontia}', 16,'indicacao','indicacao',null),
    (14,'Marcelo Duarte','+5511932176584','marcelo.duarte@exemplo.com.br','Protocolo inferior', 4, 'r', 2600000,'{implante}', 18,'google','cpc','implantes-sp'),
    (15,'Juliana Prado','+5511921765438','juliana.prado@exemplo.com.br','Lentes + clareamento', 4, 'b', 1950000,'{lentes,clareamento}', 20,'instagram','social','lentes-reels'),
    (16,'André Monteiro','+5511998123476','andre.monteiro@exemplo.com.br','Implantes múltiplos', 4, 'l', 1450000,'{implante}', 22,null,null,null),
    (17,'Fernanda Castro','+5511987123465','fernanda.castro@exemplo.com.br','Lentes de contato dental', 5, 'r', 1700000,'{lentes}', 40,'instagram','social','lentes-reels'),
    (18,'Rafael Moura','+5511976234518','rafael.moura@exemplo.com.br','Implante unitário', 5, 'b', 480000,'{implante}', 34,'google','cpc','implantes-sp'),
    (19,'Isabela Freitas','+5511965127843','isabela.freitas@exemplo.com.br','Aparelho invisível', 5, 'l', 920000,'{ortodontia}', 28,'indicacao','indicacao',null),
    (20,'Leonardo Batista','+5511954876123','leonardo.batista@exemplo.com.br','Protocolo superior', 5, 'r', 2500000,'{implante}', 25,'google','cpc','implantes-sp'),
    (21,'Carolina Pires','+5511943765218','carolina.pires@exemplo.com.br','Clareamento dental', 5, 'b', 120000,'{clareamento}', 15,'instagram','social','clareamento-novembro'),
    (22,'Diego Fernandes','+5511932654187','diego.fernandes@exemplo.com.br','Harmonização facial', 6, 'l', 280000,'{harmonização}', 38,'instagram','social','harmonizacao'),
    (23,'Priscila Antunes','+5511921543876','priscila.antunes@exemplo.com.br','Implante + enxerto', 6, 'r', 980000,'{implante}', 31,'google','cpc','implantes-sp'),
    (24,'Henrique Vieira','+5511998432165','henrique.vieira@exemplo.com.br','Ortodontia adulto', 6, 'b', 720000,'{ortodontia}', 44,null,null,null)
  ) as t(n, nome, fone, email, tratamento, etapa, dono, valor, tags, dias, utm_s, utm_m, utm_c)
  loop
    v_owner := case r.dono when 'j' then u_ju when 'r' then u_ri when 'b' then u_be else u_lu end;
    v_criado := now() - make_interval(days => r.dias) - make_interval(hours => (r.n * 7) % 9, mins => (r.n * 13) % 60);
    v_fechado := case when r.etapa >= 5 then v_criado + make_interval(days => greatest(1, r.dias - (r.n % 5) - (case when r.n % 2 = 0 then 3 else 8 end))) else null end;
    if v_fechado is not null and v_fechado > now() - interval '2 hours' then v_fechado := now() - interval '1 day'; end if;

    insert into public.contacts (organization_id, name, display_name, email, phone_number, source, tags, created_at, last_activity_at, created_by_user_id)
    values (v_org, r.nome, r.nome, r.email, r.fone, coalesce(r.utm_s, 'manual'), r.tags::text[], v_criado, coalesce(v_fechado, now() - make_interval(hours => r.n * 3)), v_owner)
    returning id into v_contato;

    insert into public.crm_leads (organization_id, pipeline_id, stage_id, contact_id, title, status, value_cents, currency,
      owner_user_id, owner_kind, assigned_at, last_activity_at, closed_at, lost_reason, lost_from_stage_id, won_reason, source,
      custom_fields, tags, created_at, stage_changed_at, position_in_stage, created_by_user_id, expected_close_date)
    values (v_org, v_pipe, st[r.etapa], v_contato, split_part(r.nome, ' ', 1) || ' ' || split_part(r.nome, ' ', 2) || ' — ' || lower(left(r.tratamento,1)) || substr(r.tratamento,2),
      case when r.etapa = 5 then 'won' when r.etapa = 6 then 'lost' else 'open' end,
      r.valor, 'BRL', v_owner, 'user', v_criado,
      coalesce(v_fechado, now() - make_interval(hours => r.n * 3)), v_fechado,
      case when r.etapa = 6 then (array['Preço acima do esperado','Escolheu outra clínica','Sem retorno ao contato'])[1 + r.n % 3] end,
      case when r.etapa = 6 then st[2 + r.n % 3] end,
      null,
      case when r.utm_s is null then 'manual' else 'webhook' end,
      case when r.utm_s is null then '{}'::jsonb else jsonb_strip_nulls(jsonb_build_object('utm_source', r.utm_s, 'utm_medium', r.utm_m, 'utm_campaign', r.utm_c)) end,
      r.tags::text[], v_criado, coalesce(v_fechado, v_criado + make_interval(days => (r.etapa - 1) * greatest(1, r.dias / 4))),
      r.n * 1000, v_owner,
      case when r.etapa between 2 and 4 then (now() + make_interval(days => 3 + r.n % 12))::date end)
    returning id into v_lead;

    insert into public.crm_lead_activities (organization_id, lead_id, contact_id, source_module, type, payload, performed_at, created_at, performed_by_user_id, actor_kind)
    values (v_org, v_lead, v_contato, 'crm', 'lead_created', jsonb_build_object('stage_id', st[1]), v_criado, v_criado, v_owner, 'user');
    k := least(r.etapa, 5);
    for i in 2..k loop
      insert into public.crm_lead_activities (organization_id, lead_id, contact_id, source_module, type, payload, performed_at, created_at, performed_by_user_id, actor_kind)
      values (v_org, v_lead, v_contato, 'crm', 'stage_changed', jsonb_build_object('from_stage_id', st[i-1], 'to_stage_id', st[i]),
        least(now() - interval '1 hour', v_criado + make_interval(days => (i - 1) * greatest(1, r.dias / 5))),
        least(now() - interval '1 hour', v_criado + make_interval(days => (i - 1) * greatest(1, r.dias / 5))), v_owner, 'user');
    end loop;
    if r.etapa = 6 then
      insert into public.crm_lead_activities (organization_id, lead_id, contact_id, source_module, type, payload, performed_at, created_at, performed_by_user_id, actor_kind)
      values (v_org, v_lead, v_contato, 'crm', 'stage_changed', jsonb_build_object('from_stage_id', st[2 + r.n % 3], 'to_stage_id', st[6]), v_fechado, v_fechado, v_owner, 'user');
    end if;

    -- tarefas abertas em parte dos negócios abertos
    if r.etapa between 2 and 4 and r.n % 2 = 0 then
      insert into public.crm_tasks (organization_id, title, description, due_date, priority, status, lead_id, contact_id, assigned_to, created_by)
      values (v_org,
        (array['Confirmar avaliação com ','Enviar orçamento revisado para ','Ligar para fechar com '])[r.etapa - 1] || split_part(r.nome,' ',1),
        'Combinado na última conversa.', now() + make_interval(days => r.n % 4, hours => 2), (array['medium','high','urgent'])[1 + r.n % 3],
        'pending', v_lead, v_contato, v_owner, u_ri);
    end if;

    -- ---- Conversas: 12 contatos de negócios abertos ----
    if r.n <= 15 and r.n not in (4, 12, 13) then
      v_ultima := now() - make_interval(mins => r.n * 23 + 4);
      insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, assigned_to_user_id, assignee_kind, assigned_at,
        last_message_at, created_at, unread_count_for_assignee)
      values (v_org, v_contato, v_canal, 'whatsapp', 'open',
        case when r.n in (1,2,5,6,8,10) then v_owner end, case when r.n in (1,2,5,6,8,10) then 'user' end,
        case when r.n in (1,2,5,6,8,10) then v_ultima - interval '30 minutes' end,
        v_ultima, v_criado, case when r.n in (1,3,7,9) then 1 + r.n % 3 else 0 end)
      returning id into v_conv;
      i := 0;
      for m in select * from (values
        (1, 'in',  'Oi, boa tarde! Vi o anúncio de vocês e queria saber mais sobre ' || lower(r.tratamento) || '.'),
        (2, 'out', 'Olá, ' || split_part(r.nome,' ',1) || '! Tudo bem? Aqui é da Clínica Demonstração. Fico feliz com seu contato 😊'),
        (3, 'out', 'Para ' || lower(r.tratamento) || ' fazemos primeiro uma avaliação gratuita com o dentista. Prefere de manhã ou à tarde?'),
        (4, 'in',  case when r.n % 2 = 0 then 'À tarde fica melhor pra mim. Tem horário na quinta?' else 'De manhã, depois das 9h. Quanto fica mais ou menos?' end),
        (5, 'out', case when r.n % 2 = 0 then 'Tenho quinta às 15h30 com a Dra. Helena. Posso reservar?' else 'O valor depende da avaliação, mas parcelamos em até 12x sem juros. Quer agendar para sexta às 9h30?' end),
        (6, 'in',  case when r.n % 3 = 0 then 'Pode sim, obrigada!' when r.n % 3 = 1 then 'Perfeito, pode reservar. Preciso levar algum exame?' else 'Vou ver minha agenda e te confirmo ainda hoje.' end)
      ) as x(ordem, dir, texto) where x.ordem <= 3 + (r.n % 4)
      loop
        i := i + 1;
        insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status,
          body, sent_via, sent_by_user_id, sent_at, created_at, delivered_at, read_at)
        values (v_org, v_conv, v_canal, v_contato, 'demo-site-2026-' || gen_random_uuid(), 'text',
          case m.dir when 'in' then 'inbound' else 'outbound' end,
          case m.dir when 'in' then 'received' else 'read' end, m.texto,
          case m.dir when 'in' then 'external_device' else 'user' end,
          case m.dir when 'out' then coalesce(case when r.n in (1,2,5,6,8,10) then v_owner end, u_be) end,
          v_ultima - make_interval(mins => (6 - m.ordem) * 7), v_ultima - make_interval(mins => (6 - m.ordem) * 7),
          case m.dir when 'out' then v_ultima - make_interval(mins => (6 - m.ordem) * 7) end,
          case m.dir when 'out' then v_ultima - make_interval(mins => (6 - m.ordem) * 7 - 1) end);
        v_preview := m.texto;
        if m.dir = 'in' then v_inbound := v_ultima - make_interval(mins => (6 - m.ordem) * 7); end if;
        v_ultima := v_ultima; -- âncora da conversa
      end loop;
      update public.conversations set
        last_message_at = (select max(sent_at) from public.messages where conversation_id = v_conv),
        last_inbound_at = (select max(sent_at) from public.messages where conversation_id = v_conv and direction = 'inbound'),
        last_outbound_at = (select max(sent_at) from public.messages where conversation_id = v_conv and direction = 'outbound'),
        last_message_preview = (select body from public.messages where conversation_id = v_conv order by sent_at desc limit 1)
      where id = v_conv;
    end if;
  end loop;

  -- ---- Meta do mês: vendas ganhas ----
  insert into public.crm_metas (organization_id, periodo, indicador, pipeline_id, alvo, created_by)
  values (v_org, date_trunc('month', now() at time zone 'America/Sao_Paulo')::date, 'vendas_ganhas', null, 8, u_ju);

  raise notice 'dados criados: % negócios, % conversas, % tarefas',
    (select count(*) from public.crm_leads where organization_id = v_org),
    (select count(*) from public.conversations where organization_id = v_org),
    (select count(*) from public.crm_tasks where organization_id = v_org);
end $$;
