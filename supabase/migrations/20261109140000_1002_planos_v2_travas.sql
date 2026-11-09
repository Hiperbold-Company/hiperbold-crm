-- manifest: **Planos v2: as travas de agentes de IA e de automações, e a organização nova no Max (D-227, fork Hiperbold).** Dois gatilhos novos, no padrão do de funis: `trg_billing_trava_ai_agents` (antes do INSERT de agente não arquivado e da volta de `archived_at` para nulo) e `trg_billing_trava_followup_flow_pointers` (antes do INSERT de fluxo da superfície `automacao`). Cada um confere modo leitura, `fn_billing_bloqueia` e `fn_billing_conferir_teto`, e recusa com PT402 e `detail` = `agentes_ia` ou `automacoes`. `fn_billing_bloqueia` passa a tratar `agentes_ia` e `automacoes` como `conexoes`: bloqueiam sempre, qualquer que seja `billing_settings.modo` (os outros itens seguem o modo). `fn_billing_uso` e `fn_billing_pode_criar` ganham as duas contagens: agente = linha de `ai_agents` com `archived_at` nulo (rascunho conta); automação = linha de `followup_flow_pointers` com `surface = 'automacao'` (a tabela não tem marca de exclusão; excluir apaga a linha). `automation_rules` não conta. Organização já acima do teto não perde nada: só a criação nova é recusada. `fn_billing_contrato_da_organizacao_nova` passa a gravar o plano `max` (era `pro`) para o cadastro do próprio visitante; só afeta organizações novas. Também: erro ao ler o teto efetivo ou o modo leitura libera, só para agentes e automações; e dois gatilhos (`trg_ai_agents_organizacao_imutavel`, `trg_followup_flow_pointers_organizacao_imutavel`) recusam, com 23514, a troca de `organization_id` de agente e de automação, que furaria o teto e misturaria tenants.

-- ============================================================================
-- 1002 — PLANOS V2: AS TRAVAS DE AGENTES DE IA E DE AUTOMAÇÕES
--
-- Decisão do dono do produto (D-227, 05/11 e 09/11/2026). A 1001 gravou no
-- catálogo `agentes_ia` (Pro 1, Max 3, Scale 10) e `automacoes` (10, 20, 30);
-- aqui o banco passa a cumprir.
--
-- ─── Por que bloqueia sempre, como Conexões ───────────────────────────────
-- Os itens antigos só bloqueiam com `billing_settings.modo = 'bloquear'` e a
-- carência vencida, e toda instalação segue em `avisar`. Um teto que nunca
-- recusa não é o limite do plano que se vende. Por isso `fn_billing_bloqueia`
-- trata os dois itens novos como `conexoes` (0954): vai direto ao teto
-- efetivo. Instalação sem plano com limite (Ilimitado, ajuste nulo, plano v1
-- sem as chaves novas) segue livre, porque teto efetivo nulo sai antes de
-- qualquer contagem.
--
-- ─── O que conta ──────────────────────────────────────────────────────────
-- Agente: `ai_agents` da organização com `archived_at is null`, de qualquer
-- `kind` e em qualquer estado (rascunho, pausado e publicado contam). É a única
-- marca de exclusão da tabela. Automação: `followup_flow_pointers` com
-- `surface = 'automacao'`, em qualquer `status`; a tabela não tem coluna de
-- arquivo e excluir a automação apaga a linha. A superfície é imutável
-- (`trg_superficie_do_fluxo_imutavel`), então só o INSERT cria automação.
--
-- ─── Desarquivar é criar ──────────────────────────────────────────────────
-- O gatilho de agentes também roda em `update of archived_at`, quando a
-- coluna passa de preenchida para nula: o agente volta a ocupar vaga.
--
-- ─── Quem já passou do teto ───────────────────────────────────────────────
-- Nada é apagado, arquivado nem pausado. O gatilho só olha INSERT e a volta do
-- arquivo; editar, pausar e publicar um agente existente seguem livres.
--
-- ─── Leitura que falha ────────────────────────────────────────────────────
-- Libera, como todo o módulo: `fn_billing_bloqueia` devolve false em qualquer
-- falha interna e `fn_billing_conferir_teto` nunca lança. As leituras que antes
-- ficavam fora do `begin/exception` (o teto efetivo em `fn_billing_bloqueia` e
-- `fn_billing_modo_leitura` nos dois gatilhos novos) agora também liberam, mas
-- SÓ para `agentes_ia` e `automacoes`: para os itens antigos (`conexoes`,
-- `funis` etc.) o erro do teto efetivo continua propagando, como na 0907/0954,
-- porque mudar isso alteraria o comportamento de quem já está em produção.
--
-- ─── A organização de um agente ou de uma automação é imutável ─────────────
-- A policy dessas tabelas é só de tenant: quem é admin/manager de duas
-- organizações poderia, pela REST, trocar `organization_id` de um agente ou de
-- uma automação e (a) furar o teto da organização de origem, empurrando a linha
-- para uma que ainda tem vaga, e (b) misturar tenants, já que as versões, bases
-- de conhecimento e inscrições filhas continuam apontando para a organização
-- antiga. Dois gatilhos `before update of organization_id` recusam a troca
-- (23514, a mesma forma de `trg_superficie_do_fluxo_imutavel`). Nenhum caminho
-- do produto troca a organização dessas linhas (conferido no código e nas
-- funções SQL), então nada legítimo é recusado.
--
-- ─── A organização nova nasce no Max ──────────────────────────────────────
-- Decisão do dono em 09/11/2026: o cadastro do próprio visitante passa a
-- gravar o plano `max` na linha do contrato (era `pro`). Na falta do Max ativo,
-- o Ilimitado, como antes. Só o CORPO da função muda; contrato já gravado não é
-- tocado.
--
-- Reaplicável com o app no ar: create or replace (mesma assinatura e o mesmo
-- ACL repetido), drop trigger if exists antes de recriar, lock_timeout curto.
-- ============================================================================

set lock_timeout = '5s';

-- ── 1. fn_billing_bloqueia: agentes_ia e automacoes bloqueiam sempre ──
create or replace function public.fn_billing_bloqueia(p_org uuid, p_item text, p_pipeline uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_modo text;
  v_bloqueio_a_partir_de timestamptz;
  v_teto integer;
  v_resultado jsonb;
begin
  -- 0954: `conexoes` bloqueia sempre; 1002: `agentes_ia` e `automacoes` também.
  -- Não leem modo nem carência.
  if p_item is null or p_item not in ('conexoes', 'agentes_ia', 'automacoes') then
    select modo into v_modo from public.billing_settings where id = 1;

    if v_modo is distinct from 'bloquear' then
      return false;
    end if;

    select bc.bloqueio_a_partir_de into v_bloqueio_a_partir_de
    from public.billing_contracts bc
    where bc.organization_id = p_org;

    -- Nulo = não bloqueia; data no futuro = ainda em carência.
    if v_bloqueio_a_partir_de is null or v_bloqueio_a_partir_de > now() then
      return false;
    end if;
  end if;

  -- 1002: erro ao ler o teto efetivo (ex.: cast do jsonb) LIBERA, mas só para os
  -- itens novos; nos antigos o erro continua propagando, como na 0907/0954.
  begin
    v_teto := (public.fn_billing_limites_efetivos(p_org) ->> p_item)::integer;
  exception
    when others then
      if p_item in ('agentes_ia', 'automacoes') then
        raise warning 'billing_bloqueia_teto_falhou: organizacao=%, item=%, sqlerrm=%', p_org, p_item, sqlerrm;
        return false;
      end if;
      raise;
  end;

  -- Organização Ilimitado (ou item sem teto efetivo) nunca bloqueia.
  if v_teto is null then
    return false;
  end if;

  -- MESMA trava bloqueante de fn_billing_conferir_teto, nunca a variante _try_.
  perform pg_advisory_xact_lock(hashtextextended('billing:' || p_org::text || ':' || p_item, 0));

  begin
    v_resultado := public.fn_billing_pode_criar(p_org, p_item, p_pipeline);
    return not (v_resultado ->> 'pode')::boolean;
  exception
    when others then
      -- Falha interna LIBERA (nunca bloqueia por acidente).
      raise warning 'billing_bloqueia_falhou: organizacao=%, item=%, sqlerrm=%', p_org, p_item, sqlerrm;
      return false;
  end;
end;
$$;

comment on function public.fn_billing_bloqueia(uuid, text, uuid) is
  '0907, 0954 e 1002: o veredito de bloqueio de verdade. Para conexoes (0954), agentes_ia e automacoes (1002) é true sempre que o teto efetivo existe e fn_billing_pode_criar diz que não pode, SEM ler billing_settings.modo nem a carência; erro ao ler o teto efetivo libera só para agentes_ia e automacoes. Para os demais itens, true só com modo=bloquear, bloqueio_a_partir_de vencido, teto não nulo e fn_billing_pode_criar dizendo que não pode. Pega pg_advisory_xact_lock BLOQUEANTE pela chave billing:<org>:<item> antes de contar; qualquer falha interna devolve false (raise warning). Quem chama levanta o PT402 (este código nunca lança).';

revoke execute on function public.fn_billing_bloqueia(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_bloqueia(uuid, text, uuid) to service_role;

-- ── 2. fn_billing_uso: as duas contagens novas ──
create or replace function public.fn_billing_uso(p_org uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_funis bigint;
  v_etapas_por_funil bigint;
  v_leads bigint;
  v_membros bigint;
  v_conexoes bigint;
  v_integracoes_webhook bigint;
  v_agentes_ia bigint;
  v_automacoes bigint;
begin
  select count(*) into v_funis
  from public.crm_pipelines
  where organization_id = p_org and is_archived = false;

  select coalesce(max(t.qtd), 0) into v_etapas_por_funil
  from (
    select p.id, count(s.id) filter (where s.is_archived = false) as qtd
    from public.crm_pipelines p
    left join public.crm_stages s on s.pipeline_id = p.id
    where p.organization_id = p_org and p.is_archived = false
    group by p.id
  ) t;

  select coalesce(buc.valor, 0) into v_leads
  from public.billing_usage_counters buc
  where buc.organization_id = p_org and buc.item = 'leads';
  v_leads := coalesce(v_leads, 0);

  select
    (
      select count(*) from public.user_organizations uo
      where uo.organization_id = p_org
        and uo.accepted_at is not null
        and uo.revoked_at is null
        and not uo.provisional_until_handover
        and not uo.membro_da_agencia
    )
    +
    (
      select count(*) from public.team_invites ti
      where ti.organization_id = p_org
        and ti.accepted_at is null
        and ti.revoked_at is null
        and ti.expires_at > now()
        and not public.fn_billing_convite_ja_tem_vinculo_ativo(ti.id)
    )
  into v_membros;

  select count(*) into v_conexoes
  from public.channel_sessions
  where organization_id = p_org and archived_at is null;

  select count(*) into v_integracoes_webhook
  from public.webhook_sources
  where organization_id = p_org and is_active = true;

  select count(*) into v_agentes_ia
  from public.ai_agents
  where organization_id = p_org and archived_at is null;

  select count(*) into v_automacoes
  from public.followup_flow_pointers
  where organization_id = p_org and surface = 'automacao';

  return jsonb_build_object(
    'funis', v_funis,
    'etapas_por_funil', v_etapas_por_funil,
    'leads', v_leads,
    'membros', v_membros,
    'conexoes', v_conexoes,
    'integracoes_webhook', v_integracoes_webhook,
    'agentes_ia', v_agentes_ia,
    'automacoes', v_automacoes
  );
end;
$$;

revoke execute on function public.fn_billing_uso(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_uso(uuid) to service_role;

-- ── 3. fn_billing_pode_criar: os dois itens novos ──
create or replace function public.fn_billing_pode_criar(p_org uuid, p_item text, p_pipeline uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_tetos jsonb;
  v_teto integer;
  v_atual bigint;
  v_pode boolean;
  v_motivo text;
begin
  if p_item not in (
    'funis', 'etapas_por_funil', 'leads', 'membros', 'conexoes', 'integracoes_webhook',
    'agentes_ia', 'automacoes'
  ) then
    raise exception 'billing_item_desconhecido' using errcode = '22023';
  end if;

  v_tetos := public.fn_billing_limites_efetivos(p_org);
  v_teto := (v_tetos ->> p_item)::integer;

  if v_teto is null then
    return jsonb_build_object('pode', true, 'motivo', 'sem_limite', 'atual', null, 'teto', null);
  end if;

  if p_item = 'funis' then
    select count(*) into v_atual
    from public.crm_pipelines
    where organization_id = p_org and is_archived = false;
  elsif p_item = 'etapas_por_funil' then
    if p_pipeline is null then
      raise exception 'billing_pipeline_obrigatorio_para_etapas_por_funil' using errcode = '22023';
    end if;

    select count(*) into v_atual
    from public.crm_stages
    where pipeline_id = p_pipeline and organization_id = p_org and is_archived = false;
  elsif p_item = 'leads' then
    select coalesce(valor, 0) into v_atual
    from public.billing_usage_counters
    where organization_id = p_org and item = 'leads';
    v_atual := coalesce(v_atual, 0);
  elsif p_item = 'membros' then
    select
      (
        select count(*) from public.user_organizations uo
        where uo.organization_id = p_org
          and uo.accepted_at is not null
          and uo.revoked_at is null
          and not uo.provisional_until_handover
          and not uo.membro_da_agencia
      )
      +
      (
        select count(*) from public.team_invites ti
        where ti.organization_id = p_org
          and ti.accepted_at is null
          and ti.revoked_at is null
          and ti.expires_at > now()
          and not public.fn_billing_convite_ja_tem_vinculo_ativo(ti.id)
      )
    into v_atual;
  elsif p_item = 'conexoes' then
    select count(*) into v_atual
    from public.channel_sessions
    where organization_id = p_org and archived_at is null;
  elsif p_item = 'integracoes_webhook' then
    select count(*) into v_atual
    from public.webhook_sources
    where organization_id = p_org and is_active = true;
  elsif p_item = 'agentes_ia' then
    select count(*) into v_atual
    from public.ai_agents
    where organization_id = p_org and archived_at is null;
  elsif p_item = 'automacoes' then
    select count(*) into v_atual
    from public.followup_flow_pointers
    where organization_id = p_org and surface = 'automacao';
  end if;

  v_pode := v_atual < v_teto;
  v_motivo := case when v_pode then 'ok' else 'teto_atingido' end;

  return jsonb_build_object('pode', v_pode, 'motivo', v_motivo, 'atual', v_atual, 'teto', v_teto);
end;
$$;

revoke execute on function public.fn_billing_pode_criar(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_pode_criar(uuid, text, uuid) to service_role;

-- ── 4. A trava de agentes de IA ──
create or replace function public.fn_billing_trava_ai_agents()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_leitura boolean;
begin
  if (tg_op = 'INSERT' and new.archived_at is null)
     or (tg_op = 'UPDATE' and old.archived_at is not null and new.archived_at is null) then
    -- Leitura que falha libera (1002): só a recusa de verdade sai daqui.
    begin
      v_leitura := public.fn_billing_modo_leitura(new.organization_id);
    exception
      when others then
        raise warning 'billing_modo_leitura_falhou: organizacao=%, sqlerrm=%', new.organization_id, sqlerrm;
        v_leitura := false;
    end;
    if v_leitura then
      raise exception 'Conta suspensa' using errcode = 'PT402', detail = 'assinatura_suspensa';
    end if;
    if public.fn_billing_bloqueia(new.organization_id, 'agentes_ia', null) then
      raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'agentes_ia';
    end if;
    perform public.fn_billing_conferir_teto(new.organization_id, 'agentes_ia', null);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_ai_agents() is
  '1002 (D-227): gatilho de plano de ai_agents. No INSERT de agente não arquivado e na volta de archived_at para nulo: modo leitura (PT402/assinatura_suspensa), fn_billing_bloqueia(agentes_ia) (PT402/agentes_ia, bloqueia sempre) e fn_billing_conferir_teto. Não roda em outra atualização: agente que já existe nunca é tocado.';

revoke execute on function public.fn_billing_trava_ai_agents() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_ai_agents() to service_role;

drop trigger if exists trg_billing_trava_ai_agents on public.ai_agents;
create trigger trg_billing_trava_ai_agents
  before insert or update of archived_at on public.ai_agents
  for each row
  execute function public.fn_billing_trava_ai_agents();

-- ── 5. A trava de automações ──
create or replace function public.fn_billing_trava_followup_flow_pointers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_leitura boolean;
begin
  if new.surface = 'automacao' then
    -- Leitura que falha libera (1002): só a recusa de verdade sai daqui.
    begin
      v_leitura := public.fn_billing_modo_leitura(new.organization_id);
    exception
      when others then
        raise warning 'billing_modo_leitura_falhou: organizacao=%, sqlerrm=%', new.organization_id, sqlerrm;
        v_leitura := false;
    end;
    if v_leitura then
      raise exception 'Conta suspensa' using errcode = 'PT402', detail = 'assinatura_suspensa';
    end if;
    if public.fn_billing_bloqueia(new.organization_id, 'automacoes', null) then
      raise exception 'Limite do plano atingido' using errcode = 'PT402', detail = 'automacoes';
    end if;
    perform public.fn_billing_conferir_teto(new.organization_id, 'automacoes', null);
  end if;

  return new;
end;
$$;

comment on function public.fn_billing_trava_followup_flow_pointers() is
  '1002 (D-227): gatilho de plano das automações. No INSERT de followup_flow_pointers com surface = automacao: modo leitura (PT402/assinatura_suspensa), fn_billing_bloqueia(automacoes) (PT402/automacoes, bloqueia sempre) e fn_billing_conferir_teto. Follow-up e roteiro de atendimento não contam; a superfície é imutável, então só o INSERT cria automação.';

revoke execute on function public.fn_billing_trava_followup_flow_pointers() from public, anon, authenticated;
grant execute on function public.fn_billing_trava_followup_flow_pointers() to service_role;

drop trigger if exists trg_billing_trava_followup_flow_pointers on public.followup_flow_pointers;
create trigger trg_billing_trava_followup_flow_pointers
  before insert on public.followup_flow_pointers
  for each row
  execute function public.fn_billing_trava_followup_flow_pointers();

-- ── 5b. A organização de um agente e de uma automação não muda ──
-- Gatilho simples (security invoker): só compara old e new. `before update of
-- organization_id` dispara quando a coluna entra no SET; a função só recusa
-- quando o valor de fato muda. Nome do gatilho antes de `trg_billing_...` na
-- ordem alfabética, então a recusa vem antes da trava de plano.
create or replace function public.fn_ai_agents_organizacao_imutavel()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'a organização de um agente de IA não muda depois de criado'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_ai_agents_organizacao_imutavel() from public, anon, authenticated;

drop trigger if exists trg_ai_agents_organizacao_imutavel on public.ai_agents;
create trigger trg_ai_agents_organizacao_imutavel
  before update of organization_id on public.ai_agents
  for each row
  execute function public.fn_ai_agents_organizacao_imutavel();

create or replace function public.fn_followup_flow_pointers_organizacao_imutavel()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'a organização de um fluxo de follow-up ou automação não muda depois de criado'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_followup_flow_pointers_organizacao_imutavel() from public, anon, authenticated;

drop trigger if exists trg_followup_flow_pointers_organizacao_imutavel on public.followup_flow_pointers;
create trigger trg_followup_flow_pointers_organizacao_imutavel
  before update of organization_id on public.followup_flow_pointers
  for each row
  execute function public.fn_followup_flow_pointers_organizacao_imutavel();

-- ── 6. A organização nova nasce no Max ──
create or replace function public.fn_billing_contrato_da_organizacao_nova()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan_id uuid;
  v_modo text;
begin
  if coalesce(new.settings ->> 'billing_inicio', '') in ('sem_plano', 'avaliacao') then
    select modo into v_modo from public.billing_settings where id = 1;

    if v_modo is distinct from 'desligado' then
      select id into v_plan_id
      from public.billing_plans
      where code = 'max' and active
      limit 1;

      if v_plan_id is null then
        select id into v_plan_id
        from public.billing_plans
        where code = 'ilimitado' and active
        limit 1;
      end if;

      if v_plan_id is not null then
        insert into public.billing_contracts
          (organization_id, plan_id, status, bloqueio_a_partir_de)
        values (new.id, v_plan_id, 'suspensa', now() + interval '5 seconds')
        on conflict (organization_id) do nothing;

        return new;
      end if;

      raise warning 'billing_plano_de_entrada_ausente_na_criacao_da_organizacao';
    end if;
  end if;

  select id into v_plan_id
  from public.billing_plans
  where code = 'ilimitado' and active
  limit 1;

  if v_plan_id is null then
    raise warning 'billing_plano_ilimitado_ausente_na_criacao_da_organizacao';
    return new;
  end if;

  insert into public.billing_contracts (organization_id, plan_id, status)
  values (new.id, v_plan_id, 'ativa')
  on conflict (organization_id) do nothing;

  return new;
end;
$$;

comment on function public.fn_billing_contrato_da_organizacao_nova() is
  '0904, redefinida na 0928, na 0940 e na 1002: organização com settings.billing_inicio = sem_plano (o cadastro do próprio visitante; avaliacao é sinônimo antigo) nasce suspensa, sem período e sem ciclo, com bloqueio_a_partir_de = now() + 5 segundos, no plano max (1002, decisão do dono em 09/11/2026; antes pro) ou no Ilimitado se faltar. Qualquer outra (admin da plataforma, provisionamento externo, instalação, billing desligado) segue ativa no Ilimitado.';

revoke execute on function public.fn_billing_contrato_da_organizacao_nova() from public, anon, authenticated;
grant execute on function public.fn_billing_contrato_da_organizacao_nova() to service_role;

-- ── 7. agent_worker não chama nada disto ──
do $agent_worker_1002$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_bloqueia(uuid, text, uuid), public.fn_billing_uso(uuid), public.fn_billing_pode_criar(uuid, text, uuid), public.fn_billing_trava_ai_agents(), public.fn_billing_trava_followup_flow_pointers(), public.fn_ai_agents_organizacao_imutavel(), public.fn_followup_flow_pointers_organizacao_imutavel(), public.fn_billing_contrato_da_organizacao_nova() from agent_worker';
  end if;
end
$agent_worker_1002$;

reset lock_timeout;
