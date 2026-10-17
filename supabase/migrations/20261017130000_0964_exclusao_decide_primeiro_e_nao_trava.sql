-- 0964, a exclusão dos dados decide PRIMEIRO no banco e a rodada nunca trava sem aviso (fork Hiperbold, D-209).
--
-- Faixa 09xx reservada ao fork (ver 0901). Duas falhas da auditoria de 17/10/2026 na exclusão da 0959:
--
--   1. IMPASSE SEM AVISO. Programação automática vencida com `aviso_7_dias_em` nulo (aviso nunca enfileirado:
--      rodada perdida, programação criada com menos de 7 dias) ficava presa para sempre: a rodada só avisa o que
--      ainda vai vencer, e a guarda recusava apagar sem o aviso. Agora `fn_exclusao_adiar_para_avisar` empurra
--      `excluir_em` para daqui a 7 dias e zera os marcadores; a mesma rodada enfileira o aviso de D-7 e a
--      exclusão só acontece depois. Nunca se apaga sem aviso.
--   2. CORRIDA COM O PAGAMENTO. O servidor consultava a guarda, apagava Storage e conexões (sem volta) e só então
--      pedia `fn_exclusao_executar`; um pagamento que reativasse o contrato nesse intervalo fazia o banco recusar a
--      exclusão com os arquivos já apagados. Agora `fn_exclusao_iniciar` (transação com o contrato travado)
--      reconfere a guarda e marca a programação como `executando` ANTES de qualquer coisa sem volta. Depois da
--      marca, um trigger em billing_contracts RECUSA tirar o contrato de cancelada/suspensa (a reativação por
--      pagamento ou pelo admin falha com `billing_org_em_exclusao`; o evento do Asaas fica em erro para o
--      operador tratar, o dinheiro nunca é aceito em silêncio). A exclusão em andamento é irreversível: não se
--      cancela nem se reprograma. `executando` que ficou para trás (Storage falhou) é retomada na rodada seguinte.
--      Exclusão forçada pelo admin da plataforma continua dispensando programação e não marca nada.
--
-- Recria fn_exclusao_pode_executar, fn_exclusao_programar e fn_exclusao_cancelar (corpo da 0959 com o estado novo)
-- e cria fn_exclusao_iniciar, fn_exclusao_adiar_para_avisar e o trigger. fn_exclusao_executar e
-- fn_exclusao_sincronizar ficam como estão (a primeira chama a guarda recriada aqui). Reaplicável.

set lock_timeout = '3s';

-- ── 1. O estado "executando" ──
alter table public.org_exclusoes_programadas add column if not exists executando_desde timestamptz;

do $estado_executando$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'org_exclusoes_programadas_estado_valido'
       and conrelid = 'public.org_exclusoes_programadas'::regclass
       and pg_get_constraintdef(oid) like '%executando%'
  ) then
    alter table public.org_exclusoes_programadas drop constraint if exists org_exclusoes_programadas_estado_valido;
    alter table public.org_exclusoes_programadas
      add constraint org_exclusoes_programadas_estado_valido
      check (estado in ('programada', 'cancelada', 'executando'));
  end if;
end
$estado_executando$;

comment on column public.org_exclusoes_programadas.executando_desde is
  '0964: quando fn_exclusao_iniciar marcou a exclusão como executando (a guarda foi reconferida com o contrato travado). A partir daí o contrato não sai de cancelada/suspensa e a programação não se cancela.';

-- ── 2. A guarda aceita "executando" (a exclusão retomada) ──
create or replace function public.fn_exclusao_pode_executar(p_org uuid, p_forcar boolean default false)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog public.org_exclusoes_programadas;
begin
  if p_org is null then
    return 'exclusao_dados_invalidos';
  end if;

  if coalesce(p_forcar, false) then
    if not exists (select 1 from public.organizations where id = p_org) then
      return 'exclusao_org_inexistente';
    end if;
    return 'ok';
  end if;

  select * into v_prog from public.org_exclusoes_programadas where organization_id = p_org;
  if not found then
    return 'exclusao_nao_programada';
  end if;
  if v_prog.estado not in ('programada', 'executando') then
    return 'exclusao_cancelada';
  end if;
  if v_prog.excluir_em > now() then
    return 'exclusao_ainda_nao_venceu';
  end if;
  if v_prog.origem = 'automatica' then
    -- A automática ainda tem de ser verdadeira hoje (reativou ontem à noite = não apaga) e só vale com o aviso
    -- de 7 dias já enfileirado: sem ele o cliente não foi avisado, e a exclusão espera.
    if not exists (select 1 from public.fn_exclusao_candidatas() c where c.organization_id = p_org) then
      return 'exclusao_org_reativada';
    end if;
    if v_prog.aviso_7_dias_em is null then
      return 'exclusao_sem_aviso_de_7_dias';
    end if;
  end if;
  if not exists (select 1 from public.organizations where id = p_org) then
    return 'exclusao_org_inexistente';
  end if;
  return 'ok';
end;
$$;

comment on function public.fn_exclusao_pode_executar(uuid, boolean) is
  '0959: a guarda da exclusão, só de leitura. Devolve ok ou o código da recusa: exclusao_nao_programada, exclusao_cancelada, exclusao_ainda_nao_venceu, exclusao_org_reativada (a automática não é mais elegível), exclusao_sem_aviso_de_7_dias (a automática sem o aviso de 7 dias enfileirado), exclusao_org_inexistente. p_forcar (exclusão pedida à mão pelo admin da plataforma) só exige que a organização exista.';

revoke execute on function public.fn_exclusao_pode_executar(uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_exclusao_pode_executar(uuid, boolean) to service_role;

-- ── 2b. Programar e cancelar respeitam "executando" ──
create or replace function public.fn_exclusao_programar(p_org uuid, p_quando timestamptz, p_actor uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if p_org is null or p_quando is null or p_actor is null then
    raise exception 'exclusao_dados_invalidos' using errcode = '22023';
  end if;
  if p_quando > now() + interval '10 years' then
    raise exception 'exclusao_data_invalida' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'exclusao_org_inexistente' using errcode = 'P0002';
  end if;

  insert into public.org_exclusoes_programadas
    (organization_id, origem, motivo, estado, fim_da_assinatura_em, excluir_em, programada_por)
  values (p_org, 'manual', 'manual', 'programada', null, p_quando, p_actor)
  on conflict (organization_id) do update
    set origem = 'manual',
        motivo = 'manual',
        estado = 'programada',
        fim_da_assinatura_em = null,
        excluir_em = excluded.excluir_em,
        aviso_30_dias_em = null,
        aviso_7_dias_em = null,
        programada_por = excluded.programada_por,
        cancelada_por = null,
        cancelada_em = null
    where public.org_exclusoes_programadas.estado <> 'executando';

  if exists (select 1 from public.org_exclusoes_programadas where organization_id = p_org and estado = 'executando') then
    raise exception 'exclusao_em_execucao' using errcode = '22023';
  end if;

  return jsonb_build_object('organization_id', p_org, 'excluir_em', p_quando);
end;
$$;

comment on function public.fn_exclusao_programar(uuid, timestamptz, uuid) is
  '0959: o admin da plataforma programa (ou reprograma) a exclusão de QUALQUER organização para p_quando. Vira programação manual: a sincronização automática não a toca. "Excluir agora" é programar para agora e executar em seguida.';

revoke execute on function public.fn_exclusao_programar(uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.fn_exclusao_programar(uuid, timestamptz, uuid) to service_role;

create or replace function public.fn_exclusao_cancelar(p_org uuid, p_actor uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_linha public.org_exclusoes_programadas;
begin
  if p_org is null or p_actor is null then
    raise exception 'exclusao_dados_invalidos' using errcode = '22023';
  end if;

  select * into v_linha from public.org_exclusoes_programadas where organization_id = p_org for update;
  if not found then
    return 'inexistente';
  end if;

  -- Manual: a linha só existia por causa do admin, então sai. Automática: a linha FICA, marcada como cancelada,
  -- senão a sincronização a recriaria no mesmo dia (o contrato continua cancelado).
  -- 0964: a exclusão já começou (Storage e conexões sendo apagados): não há mais o que cancelar.
  if v_linha.estado = 'executando' then
    return 'em_execucao';
  end if;
  if v_linha.origem = 'manual' then
    delete from public.org_exclusoes_programadas where organization_id = p_org;
    return 'removida';
  end if;
  if v_linha.estado = 'cancelada' then
    return 'ja_cancelada';
  end if;
  update public.org_exclusoes_programadas
     set estado = 'cancelada', cancelada_por = p_actor, cancelada_em = now()
   where organization_id = p_org;
  return 'cancelada';
end;
$$;

comment on function public.fn_exclusao_cancelar(uuid, uuid) is
  '0959: o admin da plataforma cancela a exclusão programada. Manual: a linha é apagada (devolve removida). Automática: a linha fica com estado cancelada para a sincronização não recriá-la (devolve cancelada, ou ja_cancelada). Sem programação: inexistente.';

revoke execute on function public.fn_exclusao_cancelar(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_exclusao_cancelar(uuid, uuid) to service_role;

-- ── 3. fn_exclusao_iniciar: o banco decide primeiro e marca ──
create or replace function public.fn_exclusao_iniciar(p_org uuid, p_forcar boolean default false)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_veredito text;
begin
  if p_org is null then
    return 'exclusao_dados_invalidos';
  end if;

  -- A mesma trava de fn_exclusao_executar, e o contrato travado ANTES da conferência: um pagamento que está
  -- reativando agora espera esta transação (e vê a marca) ou termina antes (e a guarda vê o contrato novo).
  perform pg_advisory_xact_lock(hashtextextended('org_exclusao:' || p_org::text, 0));
  perform 1 from public.billing_contracts where organization_id = p_org for update;

  v_veredito := public.fn_exclusao_pode_executar(p_org, p_forcar);
  if v_veredito <> 'ok' then
    return v_veredito;
  end if;

  -- Forçada (admin da plataforma): dispensa programação, não há linha para marcar.
  if coalesce(p_forcar, false) then
    return 'ok';
  end if;

  update public.org_exclusoes_programadas
     set estado = 'executando',
         executando_desde = coalesce(executando_desde, now())
   where organization_id = p_org
     and estado in ('programada', 'executando');
  return 'ok';
end;
$$;

comment on function public.fn_exclusao_iniciar(uuid, boolean) is
  '0964: o servidor chama ANTES de apagar Storage e conexões. Trava o contrato, reconfere a guarda (fn_exclusao_pode_executar) e marca a programação como executando; devolve ok ou o código da recusa. Depois da marca o trigger de billing_contracts recusa a reativação e a programação não se cancela. Idempotente (executando continua ok, para retomar). p_forcar não marca nada. Só service_role.';

revoke execute on function public.fn_exclusao_iniciar(uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_exclusao_iniciar(uuid, boolean) to service_role;

-- ── 4. Reativar durante a exclusão é recusado ──
create or replace function public.fn_billing_contracts_barra_reativacao_em_exclusao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status in ('cancelada', 'suspensa')
     and new.status not in ('cancelada', 'suspensa')
     and exists (
       select 1 from public.org_exclusoes_programadas x
        where x.organization_id = new.organization_id and x.estado = 'executando'
     )
  then
    raise exception 'billing_org_em_exclusao' using errcode = '55000';
  end if;
  return new;
end;
$$;

comment on function public.fn_billing_contracts_barra_reativacao_em_exclusao() is
  '0964: recusa tirar o contrato de cancelada/suspensa quando a exclusão dos dados da organização já está executando (billing_org_em_exclusao). Só olha a troca de estado; as transições entre cancelada e suspensa do conferidor diário passam.';

revoke execute on function public.fn_billing_contracts_barra_reativacao_em_exclusao() from public, anon, authenticated;

drop trigger if exists trg_billing_contracts_barra_reativacao_em_exclusao on public.billing_contracts;
create trigger trg_billing_contracts_barra_reativacao_em_exclusao
  before update of status on public.billing_contracts
  for each row execute function public.fn_billing_contracts_barra_reativacao_em_exclusao();

-- ── 5. fn_exclusao_adiar_para_avisar: vencida sem aviso volta a esperar 7 dias ──
create or replace function public.fn_exclusao_adiar_para_avisar()
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_adiadas integer;
begin
  with adiadas as (
    update public.org_exclusoes_programadas x
       set excluir_em = now() + interval '7 days',
           aviso_30_dias_em = null,
           aviso_7_dias_em = null
     where x.origem = 'automatica'
       and x.estado = 'programada'
       and x.excluir_em <= now()
       and x.aviso_7_dias_em is null
       and exists (select 1 from public.fn_exclusao_candidatas() c where c.organization_id = x.organization_id)
    returning 1
  )
  select count(*) into v_adiadas from adiadas;
  return v_adiadas;
end;
$$;

comment on function public.fn_exclusao_adiar_para_avisar() is
  '0964: programação AUTOMÁTICA vencida e ainda elegível cujo aviso de 7 dias nunca foi enfileirado tem excluir_em empurrado para daqui a 7 dias e os marcadores zerados; a mesma rodada enfileira o aviso de D-7. Nunca se apaga sem aviso. Devolve quantas adiou. Só service_role.';

revoke execute on function public.fn_exclusao_adiar_para_avisar() from public, anon, authenticated;
grant execute on function public.fn_exclusao_adiar_para_avisar() to service_role;

do $agent_worker_exclusao_0964$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_exclusao_iniciar(uuid, boolean), public.fn_exclusao_adiar_para_avisar() from agent_worker';
  end if;
end
$agent_worker_exclusao_0964$;

reset lock_timeout;
