-- 0959, exclusão dos dados da organização depois do cancelamento (fork Hiperbold, D-209).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisões do dono do produto (16/10/2026), que a Política de Privacidade promete: depois do fim da assinatura de
-- um cliente que PAGOU, os dados da conta ficam 90 dias para exportação e depois são excluídos (ou anonimizados),
-- mantendo só o que a lei manda guardar: registros fiscais por 5 anos e registros de acesso por 6 meses.
--
-- O relógio: a organização entra em "exclusão programada" quando o contrato vira 'cancelada' ou 'suspensa'
-- (falta de pagamento) E ela é cliente que comprou (há pagamento do Asaas ou pedido de assinatura pago, e o plano
-- não é o 'ilimitado'). A data é o instante em que o contrato entrou nesse estado (último evento de estado em
-- billing_contract_eventos, ou updated_at do contrato se não houver) mais N dias (configuração da instalação,
-- padrão 90, piso 90 DENTRO da função), mas NUNCA com menos de 30 dias de aviso contados de quando a programação
-- nasceu: cliente cujo fim foi há mais de 60 dias recebe a data de daqui a 30 dias, e o aviso de D-30 sai na hora.
-- Reativar ou pagar de novo tira o contrato de 'cancelada'/'suspensa' e a
-- sincronização apaga a programação. Quem tem acesso concedido na mão pelo admin da plataforma (plano 'ilimitado',
-- sem compra no Asaas) e quem nunca assinou (cadastro próprio ainda sem plano) NUNCA é programado sozinho; o admin
-- da plataforma pode programar ou excluir qualquer organização à mão.
--
-- O que esta migration faz:
--   1. org_exclusoes_programadas: uma linha por organização programada (origem automatica ou manual, motivo,
--      fim da assinatura, data da exclusão, os dois avisos já enfileirados, quem programou/cancelou). RLS ligada
--      sem policy: só o servidor lê (service_role); toda escrita é por função.
--   2. billing_registros_fiscais_arquivados: cópia dos registros de dinheiro da organização (pagamentos e pedidos
--      pagos: valores, datas, ids do Asaas, plano, razão social e CNPJ da organização) feita NA exclusão, sem dado
--      pessoal de contato, guardada 5 anos e só apagada pelo expurgo próprio (fn_exclusao_expurgar_fiscais_vencidos).
--      Sem chave estrangeira para a organização (ela deixa de existir). Só de acréscimo para todos os papéis.
--   3. fn_exclusao_candidatas(): as organizações que a regra automática alcança hoje (fonte única da
--      sincronização e da guarda da execução).
--   4. fn_exclusao_sincronizar(p_dias): cria, atualiza e apaga as programações AUTOMÁTICAS conforme os contratos.
--   5. fn_exclusao_programar / fn_exclusao_cancelar: as duas ações manuais do admin da plataforma.
--   6. fn_exclusao_pode_executar(p_org, p_forcar): a guarda só de leitura (o servidor a consulta antes de apagar
--      Storage e conexões). fn_exclusao_executar(p_org, p_actor, p_forcar): a exclusão em si, numa transação: confere a guarda (programada, não
--      cancelada, data vencida, e a automática ainda elegível), arquiva os registros fiscais, apaga os logs de
--      webhook da organização (que não têm chave estrangeira), grava UMA linha "org.data_purged" na auditoria (só
--      contagens), apaga a organização (a cascata leva o resto) e depois as contas de usuário que pertenciam SÓ a
--      ela e não são administradores da plataforma.
--   7. fn_exclusao_expurgar_fiscais_vencidos: o expurgo dos registros fiscais com mais de 5 anos.
--
-- Auditoria: api_audit_log.organization_id é ON DELETE SET NULL desde o baseline, então as linhas de auditoria
-- (incluindo IP e data de acesso) SOBREVIVEM à exclusão da organização com organization_id nulo, e a retenção de
-- 5 anos (fn_expurgar_auditoria_vencida, piso de 90 dias) é quem as apaga. Nenhuma linha de auditoria é alterada
-- por esta migration: o log segue só de acréscimo. A linha "org.data_purged" guarda o id da organização apagada.
--
-- Reaplicável com o app no ar e sobre a versão anterior: create table if not exists, create or replace,
-- lock_timeout curto, e uma transação única fecha a janela em que as tabelas e as funções novas teriam o ACL
-- padrão do Supabase.

set lock_timeout = '3s';

-- ── 1. org_exclusoes_programadas ──
create table if not exists public.org_exclusoes_programadas (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  origem text not null,
  motivo text not null,
  estado text not null default 'programada',
  fim_da_assinatura_em timestamptz,
  excluir_em timestamptz not null,
  aviso_30_dias_em timestamptz,
  aviso_7_dias_em timestamptz,
  programada_por uuid,
  cancelada_por uuid,
  cancelada_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_exclusoes_programadas_origem_valida check (origem in ('automatica', 'manual')),
  constraint org_exclusoes_programadas_motivo_valido check (motivo in ('cancelada', 'suspensa', 'manual')),
  constraint org_exclusoes_programadas_estado_valido check (estado in ('programada', 'cancelada')),
  constraint org_exclusoes_programadas_coerencia check (
    (origem = 'automatica' and motivo in ('cancelada', 'suspensa') and fim_da_assinatura_em is not null)
    or (origem = 'manual' and motivo = 'manual')
  )
);

comment on table public.org_exclusoes_programadas is
  '0959: organizações com a exclusão dos dados programada. origem automatica = o contrato acabou (cancelada ou suspensa) de um cliente que pagou, e excluir_em = fim_da_assinatura_em + N dias (padrão 90); manual = o admin da plataforma programou. estado cancelada só existe em programação automática cancelada à mão pelo admin (a sincronização não a recria enquanto o contrato continuar elegível); programação manual cancelada é apagada. aviso_30_dias_em e aviso_7_dias_em marcam os avisos já enfileirados (e-mail COB-12). Só service_role lê; escrita só por função.';
comment on column public.org_exclusoes_programadas.fim_da_assinatura_em is
  '0959: o instante em que o contrato entrou em cancelada/suspensa (último evento de estado em billing_contract_eventos; sem evento, updated_at do contrato). Nulo na programação manual.';

drop trigger if exists trg_org_exclusoes_programadas_updated_at on public.org_exclusoes_programadas;
create trigger trg_org_exclusoes_programadas_updated_at
  before update on public.org_exclusoes_programadas
  for each row execute function public.fn_set_updated_at();

create index if not exists org_exclusoes_programadas_vencimento_idx
  on public.org_exclusoes_programadas (excluir_em)
  where estado = 'programada';

alter table public.org_exclusoes_programadas enable row level security;

-- As duas origens de grant: o default ACL do Supabase (tudo a anon/authenticated/service_role) e o do dono.
revoke all on public.org_exclusoes_programadas from anon, authenticated, service_role;
grant select on public.org_exclusoes_programadas to service_role;
-- Só os dois marcadores de aviso são escritos direto pelo servidor; o resto é por função.
grant update (aviso_30_dias_em, aviso_7_dias_em) on public.org_exclusoes_programadas to service_role;

-- ── 2. billing_registros_fiscais_arquivados ──
create table if not exists public.billing_registros_fiscais_arquivados (
  id uuid primary key default gen_random_uuid(),
  -- Sem chave estrangeira, de propósito: a organização deixa de existir; o registro fiscal fica.
  organizacao_id_origem uuid not null,
  organizacao_razao_social text,
  organizacao_cnpj text,
  fonte text not null,
  fonte_id uuid not null,
  tipo text not null,
  status text not null,
  valor_cents integer not null,
  moeda text not null default 'BRL',
  pago_em timestamptz,
  periodo_inicio timestamptz,
  periodo_fim timestamptz,
  plano_codigo text,
  plano_nome text,
  ciclo text,
  metodo text,
  ambiente text,
  tokens bigint,
  asaas_payment_id text,
  asaas_subscription_id text,
  asaas_customer_id text,
  estorna_fonte_id uuid,
  arquivado_em timestamptz not null default now(),
  reter_ate timestamptz not null default (now() + interval '5 years'),
  constraint billing_registros_fiscais_arquivados_fonte_valida check (fonte in ('pagamento', 'pedido')),
  constraint billing_registros_fiscais_arquivados_fonte_unica unique (fonte, fonte_id)
);

comment on table public.billing_registros_fiscais_arquivados is
  '0959: cópia dos registros de dinheiro de uma organização (pagamentos e pedidos pagos) feita no instante em que os dados dela são excluídos, para cumprir a guarda fiscal de 5 anos. Guarda razão social e CNPJ da organização, valores, datas e ids do Asaas; NUNCA dado de contato, nota livre nem usuário. SÓ DE ACRÉSCIMO: nenhum papel tem update, delete nem truncate; o único apagamento é fn_exclusao_expurgar_fiscais_vencidos, que respeita o piso de 5 anos dentro do corpo.';

create index if not exists billing_registros_fiscais_arquivados_org_idx
  on public.billing_registros_fiscais_arquivados (organizacao_id_origem);
create index if not exists billing_registros_fiscais_arquivados_reter_idx
  on public.billing_registros_fiscais_arquivados (reter_ate);

alter table public.billing_registros_fiscais_arquivados enable row level security;

revoke all on public.billing_registros_fiscais_arquivados from anon, authenticated, service_role;
grant select on public.billing_registros_fiscais_arquivados to service_role;

-- ── 3. fn_exclusao_candidatas ──
-- A regra automática, num lugar só. Cliente que COMPROU: pagamento do Asaas ou pedido de assinatura pago, ciclo
-- definido e plano diferente do 'ilimitado' (o plano das contas concedidas na mão). O contrato terminou:
-- cancelada ou suspensa. Quem nunca assinou (suspensa sem período e sem ciclo) e quem tem acesso manual ficam de fora.
create or replace function public.fn_exclusao_candidatas()
returns table (organization_id uuid, motivo text, fim_em timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select bc.organization_id,
         bc.status as motivo,
         coalesce(
           (select max(e.criado_em)
              from public.billing_contract_eventos e
             where e.contract_id = bc.id
               and e.tipo in ('estado', 'conferidor')
               and e.para = bc.status),
           bc.updated_at
         ) as fim_em
    from public.billing_contracts bc
    join public.billing_plans p on p.id = bc.plan_id
   where bc.status in ('cancelada', 'suspensa')
     and bc.cycle is not null
     and p.code <> 'ilimitado'
     and (
       -- Só compra em PRODUÇÃO conta: o sandbox do Asaas não é cliente. Pagamento do Asaas sem pedido
       -- (ambiente desconhecido) também não conta: na dúvida, não se programa sozinho.
       exists (
         select 1 from public.billing_payments pg
           join public.billing_orders po on po.id = pg.order_id
          where pg.organization_id = bc.organization_id and pg.origem = 'asaas' and po.ambiente = 'producao'
       )
       or exists (
         select 1 from public.billing_orders o
          where o.organization_id = bc.organization_id and o.tipo = 'assinatura' and o.pago_em is not null
            and o.ambiente = 'producao'
       )
     );
$$;

comment on function public.fn_exclusao_candidatas() is
  '0959: as organizações que a regra AUTOMÁTICA de exclusão alcança hoje: contrato cancelada ou suspensa, com ciclo, plano diferente de ilimitado e compra no Asaas em produção (pagamento origem asaas ligado a pedido de produção, ou pedido de assinatura pago em produção). fim_em é quando o contrato entrou nesse estado. Fonte única de fn_exclusao_sincronizar e da guarda de fn_exclusao_executar.';

revoke execute on function public.fn_exclusao_candidatas() from public, anon, authenticated;
grant execute on function public.fn_exclusao_candidatas() to service_role;

-- ── 4. fn_exclusao_sincronizar ──
create or replace function public.fn_exclusao_sincronizar(p_dias integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_novas integer := 0;
  v_atualizadas integer := 0;
  v_apagadas integer := 0;
begin
  -- O piso mora no corpo: a Política de Privacidade promete 90 dias, e nenhum chamador (nem um psql na mão)
  -- encurta isso pelo parâmetro.
  if p_dias is null or p_dias < 90 or p_dias > 365 then
    raise exception 'exclusao_dias_invalido' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('org_exclusoes_sincronizar', 0));

  with novas as (
    insert into public.org_exclusoes_programadas
      (organization_id, origem, motivo, fim_da_assinatura_em, excluir_em)
    select c.organization_id, 'automatica', c.motivo, c.fim_em,
           greatest(c.fim_em + make_interval(days => p_dias), now() + interval '30 days')
      from public.fn_exclusao_candidatas() c
     where not exists (
       select 1 from public.org_exclusoes_programadas x where x.organization_id = c.organization_id
     )
    on conflict (organization_id) do nothing
    returning 1
  )
  select count(*) into v_novas from novas;

  -- A data mudou (suspensa que virou cancelada, N alterado, contrato reaberto e acabado de novo): os avisos
  -- anteriores eram de outra data, então os marcadores voltam a nulo e a fila de e-mail, que é por data,
  -- avisa de novo. NUNCA se antecipa uma data para dentro dos próximos 30 dias: diminuir N (ou o contrato
  -- reaberto e acabado antes) não pode trazer a exclusão para hoje sem aviso. A data nova só vale se for mais
  -- tarde que a de hoje, ou se ainda deixar 30 dias; senão a data atual fica como está.
  with alvo as (
    select x.organization_id, c.motivo, c.fim_em,
           case
             when greatest(c.fim_em + make_interval(days => p_dias), x.created_at + interval '30 days') >= x.excluir_em
               then greatest(c.fim_em + make_interval(days => p_dias), x.created_at + interval '30 days')
             when greatest(c.fim_em + make_interval(days => p_dias), x.created_at + interval '30 days') >= now() + interval '30 days'
               then greatest(c.fim_em + make_interval(days => p_dias), x.created_at + interval '30 days')
             else x.excluir_em
           end as nova_data
      from public.org_exclusoes_programadas x
      join public.fn_exclusao_candidatas() c on c.organization_id = x.organization_id
     where x.origem = 'automatica'
       and x.estado = 'programada'
  ), mudou as (
    update public.org_exclusoes_programadas x
       set motivo = a.motivo,
           fim_da_assinatura_em = a.fim_em,
           excluir_em = a.nova_data,
           aviso_30_dias_em = case when x.excluir_em is distinct from a.nova_data then null else x.aviso_30_dias_em end,
           aviso_7_dias_em = case when x.excluir_em is distinct from a.nova_data then null else x.aviso_7_dias_em end
      from alvo a
     where x.organization_id = a.organization_id
       and (x.motivo is distinct from a.motivo
            or x.fim_da_assinatura_em is distinct from a.fim_em
            or x.excluir_em is distinct from a.nova_data)
    returning 1
  )
  select count(*) into v_atualizadas from mudou;

  -- Reativou ou pagou de novo (o contrato saiu de cancelada/suspensa) ou virou conta manual: a programação
  -- AUTOMÁTICA some, inclusive a que o admin tinha cancelado à mão (a próxima vez que acabar é outro ciclo).
  with apagadas as (
    delete from public.org_exclusoes_programadas x
     where x.origem = 'automatica'
       and not exists (select 1 from public.fn_exclusao_candidatas() c where c.organization_id = x.organization_id)
    returning 1
  )
  select count(*) into v_apagadas from apagadas;

  return jsonb_build_object('programadas', v_novas, 'atualizadas', v_atualizadas, 'canceladas_por_reativacao', v_apagadas);
end;
$$;

comment on function public.fn_exclusao_sincronizar(integer) is
  '0959: cria, atualiza e apaga as programações AUTOMÁTICAS de exclusão conforme os contratos de hoje (fn_exclusao_candidatas). p_dias é a guarda após o fim da assinatura (90 a 365; piso e teto moram aqui, os mesmos da configuração). Não toca em programação manual. Devolve as contagens programadas, atualizadas e canceladas_por_reativacao.';

revoke execute on function public.fn_exclusao_sincronizar(integer) from public, anon, authenticated;
grant execute on function public.fn_exclusao_sincronizar(integer) to service_role;

-- ── 5. fn_exclusao_programar e fn_exclusao_cancelar ──
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
        cancelada_em = null;

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

-- ── 6a. fn_exclusao_pode_executar: a GUARDA, só de leitura ──
-- As mesmas regras valem em dois lugares: o servidor pergunta ANTES de tocar no Storage e nas conexões de canal
-- (que não têm volta), e fn_exclusao_executar pergunta de novo, dentro da transação e com o contrato travado.
-- Devolve 'ok' ou o código da recusa. p_forcar é a exclusão que o admin da plataforma pede à mão (nome digitado e
-- confirmação na tela): dispensa programação, prazo, elegibilidade e aviso, e exige só que a organização exista.
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
  if v_prog.estado <> 'programada' then
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

-- ── 6. fn_exclusao_executar ──
-- A exclusão. Tudo numa transação: se qualquer passo falha, nada muda. O Storage e as instâncias do provedor de
-- canal são tratados ANTES, pelo servidor (o Storage não se apaga por SQL), e só depois de fn_exclusao_pode_executar.
create or replace function public.fn_exclusao_executar(p_org uuid, p_actor uuid default null, p_forcar boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_prog public.org_exclusoes_programadas;
  v_motivo_recusa text;
  v_origem text;
  v_motivo text;
  v_org record;
  v_contatos bigint;
  v_conversas bigint;
  v_mensagens bigint;
  v_negocios bigint;
  v_fiscais integer := 0;
  v_fiscais_pedidos integer := 0;
  v_webhooks bigint := 0;
  v_usuarios uuid[];
  v_usuario uuid;
  v_fk record;
  v_referenciado boolean;
  v_existe boolean;
  v_removidos integer := 0;
  v_mantidos integer := 0;
  v_apagou integer;
begin
  if p_org is null then
    raise exception 'exclusao_dados_invalidos' using errcode = '22023';
  end if;

  -- A exclusão de uma organização é longa por natureza (a cascata passa por centenas de tabelas): o limite de
  -- tempo do papel de API não vale aqui, vale a transação.
  perform set_config('statement_timeout', '0', true);
  perform pg_advisory_xact_lock(hashtextextended('org_exclusao:' || p_org::text, 0));

  -- O contrato é travado ANTES de a elegibilidade ser conferida: uma reativação ou um pagamento que está
  -- gravando agora espera esta transação (ou nós esperamos por ele e enxergamos o contrato novo). Sem isso, a
  -- conferência e o delete eram dois instantes, e o pagamento do cliente cabia entre eles.
  perform 1 from public.billing_contracts where organization_id = p_org for update;

  -- A GUARDA: só se apaga o que está programado, não foi cancelado, já venceu e (a automática) ainda é
  -- elegível e foi avisada; a exclusão forçada do admin dispensa isso.
  v_motivo_recusa := public.fn_exclusao_pode_executar(p_org, p_forcar);
  if v_motivo_recusa <> 'ok' then
    raise exception '%', v_motivo_recusa using errcode = '22023';
  end if;

  select * into v_prog from public.org_exclusoes_programadas where organization_id = p_org for update;
  v_origem := coalesce(v_prog.origem, 'manual');
  v_motivo := coalesce(v_prog.motivo, 'manual');

  select id, legal_name, cnpj into v_org from public.organizations where id = p_org for update;
  if not found then
    raise exception 'exclusao_org_inexistente' using errcode = 'P0002';
  end if;

  -- As contagens do recibo (só números). Antes de apagar.
  select count(*) into v_contatos from public.contacts where organization_id = p_org;
  select count(*) into v_conversas from public.conversations where organization_id = p_org;
  select count(*) into v_mensagens from public.messages where organization_id = p_org;
  select count(*) into v_negocios from public.crm_leads where organization_id = p_org;

  -- (c) Os registros fiscais, copiados ANTES da cascata. Pagamentos primeiro (o livro-caixa), depois os pedidos
  -- pagos que não têm pagamento apontando para eles. Nada de nota livre, usuário ou contato.
  insert into public.billing_registros_fiscais_arquivados
    (organizacao_id_origem, organizacao_razao_social, organizacao_cnpj, fonte, fonte_id, tipo, status, valor_cents,
     pago_em, periodo_inicio, periodo_fim, plano_codigo, plano_nome, ciclo, metodo, ambiente, tokens,
     asaas_payment_id, asaas_subscription_id, asaas_customer_id, estorna_fonte_id)
  select pg.organization_id, v_org.legal_name, v_org.cnpj, 'pagamento', pg.id,
         case when o.id is not null then o.tipo else 'manual' end,
         pg.status, pg.gross_cents, pg.paid_at, pg.billing_period_start, pg.billing_period_end,
         coalesce(po.code, pc.code), coalesce(po.name, pc.name), o.ciclo, o.metodo, o.ambiente, o.tokens,
         pg.asaas_payment_id, o.asaas_subscription_id,
         (select cu.asaas_customer_id from public.billing_customers cu
           where cu.organization_id = pg.organization_id and cu.ambiente = o.ambiente limit 1),
         pg.estorna_pagamento_id
    from public.billing_payments pg
    left join public.billing_orders o on o.id = pg.order_id
    left join public.billing_plans po on po.id = o.plan_id
    left join public.billing_contracts bc on bc.id = pg.contract_id
    left join public.billing_plans pc on pc.id = bc.plan_id
   where pg.organization_id = p_org
  on conflict (fonte, fonte_id) do nothing;
  get diagnostics v_fiscais = row_count;

  insert into public.billing_registros_fiscais_arquivados
    (organizacao_id_origem, organizacao_razao_social, organizacao_cnpj, fonte, fonte_id, tipo, status, valor_cents,
     pago_em, plano_codigo, plano_nome, ciclo, metodo, ambiente, tokens,
     asaas_payment_id, asaas_subscription_id, asaas_customer_id)
  select o.organization_id, v_org.legal_name, v_org.cnpj, 'pedido', o.id, o.tipo, o.status, o.amount_cents,
         o.pago_em, po.code, po.name, o.ciclo, o.metodo, o.ambiente, o.tokens,
         o.asaas_payment_id, o.asaas_subscription_id,
         (select cu.asaas_customer_id from public.billing_customers cu
           where cu.organization_id = o.organization_id and cu.ambiente = o.ambiente limit 1)
    from public.billing_orders o
    left join public.billing_plans po on po.id = o.plan_id
   where o.organization_id = p_org
     and o.pago_em is not null
     and not exists (select 1 from public.billing_payments pg where pg.order_id = o.id)
  on conflict (fonte, fonte_id) do nothing;
  get diagnostics v_fiscais_pedidos = row_count;

  -- Os logs de webhook guardam o corpo bruto das mensagens (dado pessoal de contato) e não têm chave
  -- estrangeira para a organização: a cascata não os alcança.
  delete from public.webhook_events_log where organization_id = p_org;
  get diagnostics v_webhooks = row_count;

  -- Os usuários que pertencem SÓ a esta organização e não são administradores da plataforma (qualquer
  -- vínculo, mesmo revogado, com outra organização mantém a conta).
  select coalesce(array_agg(distinct uo.user_id), '{}') into v_usuarios
    from public.user_organizations uo
   where uo.organization_id = p_org
     and not exists (
       select 1 from public.user_organizations outro
        where outro.user_id = uo.user_id and outro.organization_id <> p_org
     )
     and not exists (select 1 from public.platform_admins pa where pa.user_id = uo.user_id);

  -- (f) A linha final da auditoria, antes de a organização sair: só contagens e o id da organização apagada.
  -- organization_id fica nulo de propósito (a organização não existirá mais); a cascata da organização não
  -- toca esta linha, e a retenção de 5 anos da auditoria é quem a apaga um dia.
  insert into public.api_audit_log
    (organization_id, actor_user_id, acting_as_platform_admin, action, resource_type, resource_id, bypassed_rls, metadata)
  values (
    null, p_actor, p_actor is not null, 'org.data_purged', 'organization', p_org, true,
    jsonb_build_object(
      'organization_id', p_org,
      'origem', v_origem,
      'motivo', v_motivo,
      'forcada', coalesce(p_forcar, false),
      'fim_da_assinatura_em', v_prog.fim_da_assinatura_em,
      'excluir_em', v_prog.excluir_em,
      'contatos', v_contatos,
      'conversas', v_conversas,
      'mensagens', v_mensagens,
      'negocios', v_negocios,
      'registros_fiscais_arquivados', v_fiscais + v_fiscais_pedidos,
      'webhook_logs_apagados', v_webhooks,
      'usuarios_a_remover', coalesce(array_length(v_usuarios, 1), 0)
    )
  );

  -- (e) A organização. Todas as tabelas com organization_id e chave estrangeira saem na cascata; a auditoria
  -- fica (ON DELETE SET NULL).
  delete from public.organizations where id = p_org;

  -- Depois dela, as contas. A conta que ainda é REFERENCIADA por linha de outra organização (ou de qualquer
  -- tabela que sobrou) fica: o catálogo é percorrido, sem lista fixa, em toda chave estrangeira de public para
  -- auth.users cuja exclusão apagaria ou barraria a linha (cascade, no action, restrict). As linhas desta
  -- organização já saíram na cascata acima, então o que ainda aponta para o usuário é de fora. Uma conta que não
  -- puder sair por outro motivo também é mantida e contada: nunca derruba a exclusão da organização.
  foreach v_usuario in array v_usuarios loop
    v_referenciado := false;
    for v_fk in
      select c.conrelid::regclass as tabela, a.attname as coluna
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        join pg_class r on r.oid = c.conrelid
        join pg_namespace n on n.oid = r.relnamespace
       where c.contype = 'f'
         and c.confrelid = 'auth.users'::regclass
         and array_length(c.conkey, 1) = 1
         and c.confdeltype in ('c', 'a', 'r')
         and n.nspname = 'public'
    loop
      execute format('select exists (select 1 from %s where %I = $1)', v_fk.tabela, v_fk.coluna)
        into v_existe using v_usuario;
      if v_existe then
        v_referenciado := true;
        exit;
      end if;
    end loop;
    if v_referenciado then
      v_mantidos := v_mantidos + 1;
      continue;
    end if;

    begin
      delete from auth.users where id = v_usuario;
      get diagnostics v_apagou = row_count;
      if v_apagou > 0 then
        v_removidos := v_removidos + 1;
      else
        v_mantidos := v_mantidos + 1;
      end if;
    exception when others then
      v_mantidos := v_mantidos + 1;
    end;
  end loop;

  return jsonb_build_object(
    'organization_id', p_org,
    'origem', v_origem,
    'motivo', v_motivo,
    'contatos', v_contatos,
    'conversas', v_conversas,
    'mensagens', v_mensagens,
    'negocios', v_negocios,
    'registros_fiscais_arquivados', v_fiscais + v_fiscais_pedidos,
    'webhook_logs_apagados', v_webhooks,
    'usuarios_removidos', v_removidos,
    'usuarios_mantidos', v_mantidos
  );
end;
$$;

comment on function public.fn_exclusao_executar(uuid, uuid, boolean) is
  '0959: apaga uma organização inteira, numa transação, SE ela estiver programada, não cancelada, com a data vencida e (a automática) ainda elegível. Arquiva os registros fiscais (5 anos), apaga os logs de webhook que não têm chave estrangeira, grava a linha org.data_purged na auditoria (só contagens), apaga a organização (cascata) e as contas de usuário que pertenciam só a ela e não são admin da plataforma. NÃO apaga arquivos do Storage nem instâncias de canal no provedor: isso o servidor faz antes. p_forcar é a exclusão pedida à mão pelo admin da plataforma (dispensa programação, prazo e aviso; não altera nem cria programação). Trava a linha do contrato antes de conferir a elegibilidade e mantém a conta de usuário ainda referenciada por linha de fora. Só service_role executa.';

revoke execute on function public.fn_exclusao_executar(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_exclusao_executar(uuid, uuid, boolean) to service_role;

-- ── 7. fn_exclusao_expurgar_fiscais_vencidos ──
create or replace function public.fn_exclusao_expurgar_fiscais_vencidos(p_limite integer default 500)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_apagadas integer;
begin
  if p_limite is null or p_limite < 1 or p_limite > 5000 then
    raise exception 'exclusao_limite_invalido' using errcode = '22023';
  end if;

  -- O piso de 5 anos mora no corpo: reter_ate sozinho não basta para apagar.
  with vencidas as (
    select id
      from public.billing_registros_fiscais_arquivados
     where reter_ate < now()
       and arquivado_em < now() - interval '5 years'
     order by reter_ate
     limit p_limite
     for update skip locked
  )
  delete from public.billing_registros_fiscais_arquivados f
   using vencidas v
   where f.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;

comment on function public.fn_exclusao_expurgar_fiscais_vencidos(integer) is
  '0959: apaga, em lotes de até p_limite, os registros fiscais arquivados com mais de 5 anos (reter_ate vencido E arquivado_em anterior a 5 anos: o piso mora aqui). Devolve quantos apagou.';

revoke execute on function public.fn_exclusao_expurgar_fiscais_vencidos(integer) from public, anon, authenticated;
grant execute on function public.fn_exclusao_expurgar_fiscais_vencidos(integer) to service_role;

do $agent_worker_exclusao$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke select, insert, update, delete, truncate on public.org_exclusoes_programadas, public.billing_registros_fiscais_arquivados from agent_worker';
  end if;
end
$agent_worker_exclusao$;

reset lock_timeout;
