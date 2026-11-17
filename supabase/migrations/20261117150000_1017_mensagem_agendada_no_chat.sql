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
--  4. LGPD: `fn_lgpd_cascade_redact_contact` (corpo vigente, a da 9043) ganha o passo 6z — `body`
--     redigido e `template` zerado em toda agendada do contato; a pendente vira `cancelada`.
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
-- Molde do `messages_select`/`cae_select`: o `exists` sobre `conversations` herda a RLS da conversa
-- (visibilidade por atendente); o filtro de org responde se a LINHA é da sua organização.
create policy tenant_isolation_scheduled_messages_select on public.scheduled_messages
  for select using (
    organization_id in (select public.fn_user_org_ids())
    and exists (
      select 1 from public.conversations c
       where c.id = scheduled_messages.conversation_id
    )
  );

drop policy if exists tenant_isolation_scheduled_messages_write on public.scheduled_messages;
create policy tenant_isolation_scheduled_messages_write on public.scheduled_messages
  for all
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and exists (select 1 from public.conversations c where c.id = scheduled_messages.conversation_id)
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and exists (select 1 from public.conversations c where c.id = scheduled_messages.conversation_id)
  );

-- `service_role` também sai do `revoke all` (o default ACL do Supabase dá tudo aos três papéis) e
-- recebe de volta só o que usa, como na 1015.
revoke all on public.scheduled_messages from public, anon, authenticated, service_role;
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

-- A cascata de anonimização alcança a mensagem agendada (1017). `create or replace` com o corpo
-- VIGENTE de `fn_lgpd_cascade_redact_contact` (a última definição deste arquivo, a da 9043) mais o
-- passo 6z: `body` redigido e `template` zerado em toda agendada do contato, e a pendente
-- (`agendada`) vira `cancelada`. Mesma assinatura; grants reaplicados.
create or replace function public.fn_lgpd_cascade_redact_contact(p_organization_id uuid, p_contact_id uuid, p_request_id uuid) returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'extensions', 'pg_temp'
    as $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
  v_variantes text[] := '{}';
  v_secao record;
  v_secoes jsonb := '{}'::jsonb;
begin
  perform public.fn_service_lock(p_organization_id,p_contact_id);
  select is_anonymized into v_already
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  if v_already then
    return jsonb_build_object('already_anonymized', true, 'counts', v_counts, 'media_paths', v_media_paths);
  end if;

  -- O rótulo NÃO deriva mais do id (issue #2342): `fn_lgpd_rotulo_anonimizado`
  -- gera um sufixo OPACO (aleatório, gravado no passo 1 abaixo). Antes, o
  -- sufixo eram os 8 primeiros caracteres do uuid do contato — quem tem o
  -- banco casava `Cliente Anonimizado #7a5f0011` com a linha `7a5f0011-…` e
  -- reidentificava o titular pelo próprio rótulo (pseudonimização, não
  -- anonimização: RGPD considerando 26, LGPD art. 12 e art. 13 §4).
  v_anon_label := public.fn_lgpd_rotulo_anonimizado(p_contact_id);

  -- Seções de módulo (D8, 0485): a redação delas é do gatilho
  -- `trg_lgpd_secoes_de_modulo`, que não devolve contagem — mas a contagem é
  -- EVIDÊNCIA (vai para `cascaded_to` no audit e no retorno). Uma chave por
  -- seção declarada, com o nome da tabela, contando pela MESMA `ligacao` do
  -- gatilho ($1 = organização, $2 = contato). Conta ANTES do passo 1 (que
  -- dispara o gatilho): a seção que soltar a própria ligação seguiria contada.
  -- Sem o módulo a tabela não existe e a chave não aparece. Seção com ligação
  -- vazia não é contada: o erro nomeado (`modulo_secao_invalida`) é do gatilho.
  for v_secao in
    select tabela, ligacao from public.modulo_secoes_lgpd order by modulo, tabela
  loop
    if to_regclass(format('public.%I', v_secao.tabela)) is not null
       and btrim(v_secao.ligacao) <> '' then
      execute format('select count(*) from public.%I where (%s)', v_secao.tabela, v_secao.ligacao)
        into v_count using p_organization_id, p_contact_id;
      v_secoes := v_secoes || jsonb_build_object(v_secao.tabela, v_count);
    end if;
  end loop;

  -- (9043) As variantes do principal E dos telefones extras, lidas ANTES de
  -- apagar os extras (passo 1b): o candidato da prospecção casado pelo número
  -- extra também é da pessoa que pediu para ser esquecida.
  select coalesce(array_agg(distinct v), '{}')
    into v_variantes
    from (
      select unnest(public.fn_telefone_variantes(c.phone_number)) as v
        from contacts c
       where c.id = p_contact_id and c.organization_id = p_organization_id
      union all
      select unnest(public.fn_telefone_variantes(t.phone_number))
        from contact_phones t
       where t.contact_id = p_contact_id and t.organization_id = p_organization_id
    ) as todas;

  select coalesce(array_agg(distinct media_storage_path) filter (where media_storage_path is not null), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id
      and conversation_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id
      );

  -- 1. contacts (irreversible)
  update contacts set
    name = v_anon_label,
    display_name = v_anon_label,
    email = null,
    phone_number = null,
    phone_type = null,
    phone_whatsapp = null,
    cpf_encrypted = null,
    cpf_hash = null,
    birthdate = null,
    is_anonymized = true,
    anonymized_at = now(),
    consent = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  -- 1b. contact_phones (9043) — os telefones extras, com o `lid` de cada um.
  -- Depois do passo 1: o gatilho de redação das mensagens de grupo, que roda
  -- no `update` acima, ainda precisava lê-los.
  delete from contact_phones
   where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contact_phones', v_count);

  -- 2. conversations metadata + preview strip
  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    last_handoff_reason = null,
    updated_at = now()
  where contact_id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_count);

  -- 3. messages: redact body + null media + strip metadata (preserve status/timestamps/conversation_id)
  update messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    media_derived_text = null,
    -- `external_id` guarda o TELEFONE do titular (número no inbound, id do
    -- provider no outbound) e sobrevivia legível na linha que RESTA da
    -- anonimização — a última PII viva do pedido de exclusão. Zerar não quebra
    -- nada que dependa da coluna: o unique (organization_id, external_id)
    -- trata NULL como distinto de todo NULL, a citação (`reply_to_message_id`)
    -- aponta para o id da linha e não para o `external_id`, e o eco do provider
    -- só deduplica mensagem ainda em voo — pedido de exclusão não manda nada.
    external_id = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('messages', v_count);

  -- 4. crm_lead_activities — strip payload, metadata E reason (migration 0071).
  update crm_lead_activities set
    payload = '{}'::jsonb,
    metadata = '{}'::jsonb,
    reason = null
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or lead_id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
      or lead_id in (
        select id from crm_leads
          where contact_id = p_contact_id and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('activities', v_count);

  -- 5. crm_leads — strip title/description/custom_fields/source_metadata/tags but PRESERVE pipeline/stage/value
  update crm_leads set
    title = v_anon_label,
    description = null,
    custom_fields = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_count);
  -- 5b. lead_field_proposals (0772, #3316) — a proposta de campo que a IA leu
  -- num DOCUMENTO (voucher, bilhete, apólice). `trecho` é o texto do documento
  -- sobre a PESSOA e os dois valores são o dado que a IA extraiu: o MESMO
  -- tratamento do `custom_fields` do próprio negócio (passo 5) — campo, status
  -- e decisão PERMANECEM (a fila continua explicável), o conteúdo identificável
  -- sai. Alcança pelo vínculo do negócio com o contato (direto ou pela
  -- `crm_lead_links`), como os passos 4 e 5.
  -- Gate: tests/invariants/cascata-lgpd-nao-encolhe.test.ts (catraca da lista).
  update lead_field_proposals set
    trecho = v_anon_label,
    valor_proposto = null,
    valor_anterior = null,
    motivo_recusa = null,
    updated_at = now()
  where organization_id = p_organization_id
    and (
      lead_id in (
        select id from crm_leads
         where organization_id = p_organization_id
           and contact_id = p_contact_id
      )
      or lead_id in (
        select lead_id from crm_lead_links
         where target_kind = 'contact'
           and target_id = p_contact_id
           and organization_id = p_organization_id
      )
    )
    -- Redação IDEMPOTENTE: a segunda anonimização não deve contar linha de novo
    -- (o `already_anonymized` já barra, mas a condição também protege o rerun
    -- parcial que a 0414 permite).
    and (trecho is distinct from v_anon_label
         or valor_proposto is not null
         or valor_anterior is not null
         or motivo_recusa is not null);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('lead_field_proposals', v_count);

  -- 6. orders — PRESERVE values + status + timestamps. Strip personal fields from payload jsonb
  --    and replace customer_external_id with null (FK-safe; soft de-link). Keep contact_id null.
  update orders set
    payload = (coalesce(payload, '{}'::jsonb))
      - 'customer'
      - 'customer_name'
      - 'customer_email'
      - 'customer_phone'
      - 'shipping_address'
      - 'billing_address'
      - 'contact_identification',
    customer_external_id = null,
    contact_id = null,
    is_anonymized = true,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_count);

  -- 6b. crm_proposals (migration 0477, #1504) — PRESERVA número, valores,
  -- itens, datas e status; redige só o que identifica a PESSOA. Ver o
  -- cabeçalho desta migration para o porquê de cada coluna.
  -- O PDF que o cliente recebeu (bucket `propostas`, `<org>/<proposta>.pdf`)
  -- tem o nome dele impresso: redigir as colunas e deixar o arquivo seria
  -- anonimizar a linha e manter o documento. Vai para a mesma fila de expurgo
  -- da mídia (passo 7), com o bucket CERTO — a mensagem que levou o PDF
  -- aponta para o mesmo caminho, mas o passo 7 só enfileira `whatsapp-media`.
  -- Lido ANTES de o passo seguinte zerar `pdf_path`.
  insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
  select p_organization_id, p_request_id, 'propostas', pdf_path
    from crm_proposals
   where organization_id = p_organization_id
     and contact_id = p_contact_id
     and pdf_path is not null and length(pdf_path) > 0
     -- só arquivo DESTA organização: o expurgo nunca alcança o PDF de outra
     and pdf_path like p_organization_id::text || '/%'
  on conflict (bucket, object_path) do nothing;
  update crm_proposals set
    destinatario_nome = v_anon_label,
    briefing_json = '{}'::jsonb,
    resumo_comercial = null,
    -- o texto do documento como foi montado e como foi editado à mão: é o
    -- conteúdo do PDF, com o mesmo nome dentro.
    rendered_snapshot = null,
    secoes_editadas = null,
    pdf_path = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('crm_proposals', v_count);

  -- CAMPANHAS: o que foi DITO à pessoa e o endereço para onde foi.
  update campaign_recipients set
    rendered_body = null,
    recipient_address = null,
    variables = '{}'::jsonb,
    last_error_detail = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('campaign_recipients', v_count);

  -- LISTA DE EXCLUSÃO: solta o vínculo e apaga a cauda do telefone.
  update campaign_suppressions set
    address_tail = null,
    reason = null,
    contact_id = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('campaign_suppressions', v_count);

  -- 6c. sales — a comanda SAIU desta cascata (PR #1907, item 1).
  -- Este passo alterava a comanda pelo NOME, e as cinco tabelas da comanda
  -- saíram do baseline para nascerem só na instalação do módulo (ADR-0002
  -- D2/D3): sem o módulo a tabela não existe e a alteração abortava a
  -- ANONIMIZAÇÃO INTEIRA com `relation "sales" does not exist` — 68
  -- ocorrências no CI do #1907 — além de violar a D8 (migration 0485), que
  -- proíbe o núcleo nomear tabela de módulo. A redação da comanda acontece
  -- agora pela SEÇÃO declarada `financeiro/sales` em `modulo_secoes_lgpd`,
  -- que `trg_lgpd_secoes_de_modulo` aplica nos DOIS caminhos de anonimização
  -- (a cascata e a virada `is_anonymized` de `fn_lgpd_anonymize_contact`) —
  -- e pula, sem erro, onde o módulo não está instalado (`to_regclass`), que é
  -- exatamente o contrato.
  -- 6d. conversation_notes (migration 0483, F3 da #1863) — a nota interna é
  -- texto escrito SOBRE a pessoa durante o atendimento, e o anexo dela é mídia
  -- ancorada na conversa: os dois entram no alcance do titular. A 0477 já
  -- mostrou o desenho (arquivo vai para a fila ANTES de a coluna ser zerada).
  -- O bucket é `internal-media`, e não o do passo 7: a nota nunca sobe no
  -- `whatsapp-media` (é o bucket do canal do CLIENTE), e enfileirar o caminho
  -- num bucket onde ele não está deixaria a remoção apontando para o nada —
  -- a mesma falha de não ter anonimizado, um endereço mais para a direita.
  -- Por isso os caminhos de nota também NÃO entram em `v_media_paths`: essa
  -- lista só existe para o passo 7, que enfileira `whatsapp-media`.
  insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
  select p_organization_id, p_request_id, 'internal-media', n.media_storage_path
    from conversation_notes n
   where n.organization_id = p_organization_id
     and n.conversation_id in (
       select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
     )
     and n.media_storage_path is not null and length(n.media_storage_path) > 0
     and n.media_storage_path like p_organization_id::text || '/%'
  on conflict (bucket, object_path) do nothing;
  update conversation_notes set
    body = '[nota interna anonimizada]',
    media_storage_path = null,
    media_mime = null,
    media_size_bytes = null
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
       where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversation_notes', v_count);

  -- 7. enqueue media for async deletion (idempotent via unique (bucket, object_path))
  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
      where path is not null and length(path) > 0
    on conflict (bucket, object_path) do nothing;
  end if;

  -- 7b. voice_calls — o TELEFONE de quem falou ao telefone (migration 0235).
  update voice_calls set
    peer_phone = v_anon_label,
    owner_user_id = null,
    created_by = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('voice_calls', v_count);

  update prospecting_candidates set suppression_salt = gen_random_bytes(32)
  where organization_id = p_organization_id
    and (contact_id = p_contact_id
         or (phone is not null
             and regexp_replace(phone, '\D', '', 'g') = any (v_variantes)))
    and suppression_salt is null;
  update prospecting_candidates set
    suppression_place = hmac(convert_to(place_id, 'UTF8'), suppression_salt, 'sha256'),
    suppression_phone = case when phone is null then null
      else hmac(convert_to(phone, 'UTF8'), suppression_salt, 'sha256') end,
    place_id = 'redacted:' || id::text,
    phone = null,
    data = jsonb_build_object('key', 'redacted:' || id::text,
      'name', v_anon_label, 'phone', null, 'website', null,
      'category', null, 'address', null, 'maps_url', null,
      'rating', null, 'reviews', null, 'emails', '[]'::jsonb, 'socials', '[]'::jsonb),
    status = 'skipped', service_boundary = null, error = null, updated_at = now()
  where organization_id = p_organization_id
    and (contact_id = p_contact_id
         or (phone is not null
             and regexp_replace(phone, '\D', '', 'g') = any (v_variantes)));
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('prospecting_candidates', v_count);

  -- agent_cases — o que a IA escreveu SOBRE a pessoa quando travou (migration 0280).
  update agent_cases set
    title = v_anon_label,
    summary = '[resumo anonimizado]',
    blocker = '[bloqueio anonimizado]',
    context_snapshot = '{}'::jsonb
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_cases', v_count);

  -- agent_case_events — a linha do tempo do caso (migration 0280).
  update agent_case_events set
    body = null,
    metadata = '{}'::jsonb
  where organization_id = p_organization_id
    and case_id in (
      select id from agent_cases
        where organization_id = p_organization_id
          and conversation_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_case_events', v_count);

  -- demandas — o assunto do pedido (migration 0280).
  update demandas set
    assunto = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('demandas', v_count);

  -- agent_inbox_items — o aviso que leva o texto do caso para a Central (migration 0280/0292).
  update agent_inbox_items set
    status = 'resolved',
    resolved_at = now(),
    body = 'Contato anonimizado.',
    ref_id = null
  where organization_id = p_organization_id
    and kind in ('handoff', 'case_stale', 'aviso_de_caso_nao_entregue')
    and (
      (ref_kind = 'contact' and ref_id = p_contact_id)
      or (ref_kind = 'conversation' and ref_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          ))
      or (ref_kind = 'agent_case' and ref_id in (
            select id from agent_cases
              where organization_id = p_organization_id
                and conversation_id in (
                  select id from conversations
                    where contact_id = p_contact_id and organization_id = p_organization_id
                )
          ))
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_inbox_items', v_count);

  -- agent_case_chat_messages — a consulta interna da equipe à IA SOBRE o caso (migration 0281).
  update agent_case_chat_messages set
    body = null,
    redacted_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id
    and redacted_at is null;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('agent_case_chat_messages', v_count);

  -- passagens_de_atendimento — o BRIEFING é sobre a pessoa (migration 0291).
  update passagens_de_atendimento set
    body       = v_anon_label,
    title      = null,
    notes      = null,
    content    = null,
    tentativas = '[]'::jsonb
  where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('passagens_de_atendimento', v_count);

  -- entregas_de_aviso_de_caso — o registro do aviso ao suporte (migration 0292).
  update entregas_de_aviso_de_caso set
    erro_detalhe = null
  where organization_id = p_organization_id
    and case_id in (
      select id from agent_cases
        where organization_id = p_organization_id
          and conversation_id in (
            select id from conversations
              where contact_id = p_contact_id and organization_id = p_organization_id
          )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('entregas_de_aviso_de_caso', v_count);

  -- channel_session_groups.subject — o NOME do grupo, e a FK contact_id aponta
  -- para o placeholder do grupo (contacts.kind = 'whatsapp_group'), nunca para
  -- o titular real sendo anonimizado neste caminho — mas a FK para contacts e o
  -- nome da coluna casam o padrão automático do escopo (migration 0482), e
  -- nulificar não perde nada operacional: número, conversa e liga/desliga ficam.
  update public.channel_session_groups set
    subject = null
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('channel_session_groups', v_count);

  -- 6z. scheduled_messages (migration 1017): a mensagem agendada no chat é o
  --     TEXTO que a empresa ia mandar à pessoa, e `template` guarda os valores
  --     do modelo aprovado. As duas saem de TODA agendada do contato (pelo
  --     contato ou pela conversa dele: `contact_id` é `on delete set null`). A
  --     que ainda não saiu (`agendada`) vira `cancelada`: anonimizado não recebe
  --     mensagem. A LINHA fica (status, horário, quem agendou, `message_id`):
  --     é a trilha do que a equipe fez, sem o conteúdo.
  update public.scheduled_messages set
    body = '[mensagem anonimizada]',
    template = null,
    status = case when status = 'agendada' then 'cancelada' else status end,
    motivo = case when status = 'agendada'
                  then 'Cancelada: o contato foi anonimizado (LGPD).' else motivo end,
    concluida_em = case when status = 'agendada' then now() else concluida_em end,
    updated_at = now()
  where organization_id = p_organization_id
    and (contact_id = p_contact_id
         or conversation_id in (
           select id from conversations
            where contact_id = p_contact_id and organization_id = p_organization_id
         ));
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('scheduled_messages', v_count);

  -- 7z. as contagens das seções de módulo (calculadas antes do passo 1); o
  --     núcleo vence numa colisão de nome.
  v_counts := v_secoes || v_counts;

  -- 8. dense audit row
  insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
  values (
    p_organization_id,
    'lgpd.redact_executed',
    null,
    'contact',
    p_contact_id,
    jsonb_build_object(
      'cascaded_to', v_counts,
      'media_queued', coalesce(array_length(v_media_paths, 1), 0),
      'request_id', p_request_id
    ),
    true
  );

  return jsonb_build_object(
    'already_anonymized', false,
    'counts', v_counts,
    'media_paths', v_media_paths
  );
end;
$$;

revoke execute on function public.fn_lgpd_cascade_redact_contact(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid, uuid, uuid) to service_role;
