-- ============================================================================
-- 0982 — DESEMPENHO (BI): agregações da aba ATENDIMENTO no servidor.
--
-- O que conta como ATENDIMENTO: o par (conversa, service_revision) das
-- mensagens — a fronteira de atendimento da 0222. Cada encerramento abre uma
-- revisão nova; mensagem antiga sem revisão (antes da 0222) vale como revisão 0,
-- a conversa inteira. Um atendimento entra na janela quando COMEÇA nela (a
-- primeira mensagem da revisão está em [p_from, p_to)).
--
--   finalizado  = revisão já superada pela conversa, ou revisão em curso com
--                 service_closed_at preenchido;
--   em aberto   = o resto;
--   aguardando  = em aberto, revisão em curso, e a última mensagem do cliente é
--                 posterior à última nossa (last_inbound_at > last_outbound_at).
--
-- Tempos (só resposta HUMANA: sent_by_user_id preenchido; robô não conta, como
-- em fn_attendant_metrics):
--   primeira resposta = 1ª mensagem do cliente no atendimento → 1ª resposta
--                       humana depois dela, na mesma revisão;
--   resposta          = cada TURNO do cliente (mensagem dele cuja anterior não
--                       era dele) → a próxima mensagem nossa, quando ela é de
--                       pessoa. Atribuída a quem respondeu.
-- Contagem por atendente usa o responsável ATUAL da conversa
-- (assigned_to_user_id) — o schema não guarda o responsável de cada revisão.
-- Mapa de calor = mensagens RECEBIDAS por dia da semana × hora, no fuso da
-- organização.
--
-- NÃO medido (o schema atual não dá): duração do atendimento (revisão antiga não
-- guarda quando encerrou), departamento (não existe), tempo para iniciar
-- (atribuição por revisão não é guardada).
--
-- Filtro de funil: conversa cujo contato tem negócio naquele funil. Grupos ficam
-- de fora (is_group). Comparação: a janela anterior de mesmo tamanho.
--
-- Isolamento: SECURITY INVOKER; a RLS de conversations e messages escopa o
-- atendente ao que ele já vê na Inbox. `p_org` filtra toda tabela.
-- Reaplicável: create or replace. Revoga EXECUTE de PUBLIC e anon.
-- ============================================================================

create or replace function public.fn_desempenho_atendimento(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_pipeline uuid default null,
  p_owner uuid default null
) returns jsonb
language sql stable
security invoker
set search_path = public
as $$
  with
  cfg as (
    select coalesce(
      (select o.timezone from public.organizations o
        where o.id = p_org
          and exists (select 1 from pg_timezone_names z where z.name = o.timezone)),
      'America/Sao_Paulo'
    ) as tz,
    p_from - (p_to - p_from) as anterior
  ),
  conv as (
    select c.id, c.assigned_to_user_id, c.service_revision, c.service_closed_at,
           c.service_started_at, c.last_inbound_at, c.last_outbound_at
    from public.conversations c
    where c.organization_id = p_org
      and coalesce(c.is_group, false) = false
      and (p_owner is null or c.assigned_to_user_id = p_owner)
      and (p_pipeline is null or exists (
        select 1 from public.crm_leads l
        where l.organization_id = p_org and l.pipeline_id = p_pipeline and l.contact_id = c.contact_id
      ))
  ),
  msg as (
    select m.id, m.conversation_id, coalesce(m.service_revision, 0) as rev,
           m.direction, m.sent_at, m.sent_by_user_id
    from public.messages m
    join conv c on c.id = m.conversation_id
    cross join cfg
    where m.organization_id = p_org
      and m.sent_at >= cfg.anterior and m.sent_at < p_to
  ),
  g0 as (
    select conversation_id, rev, min(sent_at) as inicio,
           min(sent_at) filter (where direction = 'inbound') as entrada
    from msg
    group by conversation_id, rev
  ),
  g1 as (
    select g0.conversation_id, g0.rev, g0.inicio, g0.entrada, min(m.sent_at) as primeira_resp
    from g0
    left join msg m
      on m.conversation_id = g0.conversation_id and m.rev = g0.rev
     and m.direction = 'outbound' and m.sent_by_user_id is not null
     and m.sent_at > g0.entrada
    group by g0.conversation_id, g0.rev, g0.inicio, g0.entrada
  ),
  atend as (
    select g1.*, c.assigned_to_user_id,
           (g1.inicio >= p_from) as na_janela,
           ((g1.rev > 0 and g1.rev < c.service_revision)
             or ((g1.rev = 0 or g1.rev = c.service_revision) and c.service_closed_at is not null)) as finalizado,
           ((g1.rev = 0 or g1.rev = c.service_revision)
             and c.last_inbound_at is not null
             and c.last_inbound_at > coalesce(c.last_outbound_at, '-infinity'::timestamptz)) as cliente_esperando
    from g1
    join conv c on c.id = g1.conversation_id
    cross join cfg
    where case
      when g1.rev = c.service_revision and c.service_started_at is not null
        then c.service_started_at >= cfg.anterior
      else not exists (
        select 1 from public.messages m2
        where m2.conversation_id = g1.conversation_id
          and coalesce(m2.service_revision, 0) = g1.rev
          and m2.sent_at < cfg.anterior
      )
    end
  ),
  atual as (
    select a.*, extract(epoch from (a.primeira_resp - a.entrada)) as primeira_seg
    from atend a where a.na_janela
  ),
  ordenadas as (
    select m.id, m.conversation_id, m.direction, m.sent_at,
           lag(m.direction) over (partition by m.conversation_id order by m.sent_at, m.id) as dir_anterior,
           min(m.sent_at) filter (where m.direction = 'outbound') over (
             partition by m.conversation_id order by m.sent_at desc, m.id desc
             rows between unbounded preceding and 1 preceding
           ) as prox_saida
    from msg m
  ),
  turnos as (
    select distinct on (t.id)
           t.id, t.sent_at, o.sent_by_user_id as respondeu,
           extract(epoch from (t.prox_saida - t.sent_at)) as seg
    from ordenadas t
    join msg o on o.conversation_id = t.conversation_id and o.sent_at = t.prox_saida and o.direction = 'outbound'
    where t.direction = 'inbound'
      and t.dir_anterior is distinct from 'inbound'
      and t.sent_at >= p_from and t.sent_at < p_to
    order by t.id, o.sent_by_user_id nulls last
  ),
  turnos_humanos as (
    select * from turnos where respondeu is not null
  ),
  dias as (
    select d::date as dia
    from cfg, generate_series(
      (p_from at time zone cfg.tz)::date,
      ((p_to - interval '1 microsecond') at time zone cfg.tz)::date,
      interval '1 day'
    ) d
  ),
  a_dia as (
    select (a.inicio at time zone cfg.tz)::date as dia, count(*) as q, avg(a.primeira_seg) as primeira_seg
    from atual a cross join cfg group by 1
  ),
  t_dia as (
    select (t.sent_at at time zone cfg.tz)::date as dia, avg(t.seg) as seg
    from turnos_humanos t cross join cfg group by 1
  ),
  calor as (
    select extract(dow from (m.sent_at at time zone cfg.tz))::int as dow,
           extract(hour from (m.sent_at at time zone cfg.tz))::int as hora,
           count(*) as q
    from msg m cross join cfg
    where m.direction = 'inbound' and m.sent_at >= p_from
    group by 1, 2
  ),
  por_dono as (
    select a.assigned_to_user_id as user_id,
           count(*) as atendimentos,
           count(*) filter (where a.finalizado) as finalizados,
           count(*) filter (where not a.finalizado) as em_aberto,
           avg(a.primeira_seg) as primeira_seg
    from atual a group by a.assigned_to_user_id
  ),
  por_resp as (
    select t.respondeu as user_id, count(*) as respostas, avg(t.seg) as seg
    from turnos_humanos t group by t.respondeu
  )
  select jsonb_build_object(
    'fuso', (select tz from cfg),
    'cartoes', jsonb_build_object(
      'atendimentos', (select count(*) from atual),
      'atendimentos_anterior', (select count(*) from atend where not na_janela),
      'finalizados', (select count(*) from atual where finalizado),
      'em_aberto', (select count(*) from atual where not finalizado),
      'aguardando', (select count(*) from atual where not finalizado and cliente_esperando)
    ),
    'tempos', jsonb_build_object(
      'primeira_resposta_seg', (select round(avg(primeira_seg)::numeric, 1) from atual),
      'resposta_seg', (select round(avg(seg)::numeric, 1) from turnos_humanos),
      'respostas', (select count(*) from turnos_humanos)
    ),
    'diario', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dia', to_char(d.dia, 'YYYY-MM-DD'),
        'atendimentos', coalesce(ad.q, 0),
        'primeira_resposta_seg', round(ad.primeira_seg::numeric, 1),
        'resposta_seg', round(td.seg::numeric, 1)
      ) order by d.dia)
      from dias d
      left join a_dia ad on ad.dia = d.dia
      left join t_dia td on td.dia = d.dia
    ), '[]'::jsonb),
    'mapa_de_calor', coalesce((
      select jsonb_agg(jsonb_build_object('dow', c.dow, 'hora', c.hora, 'quantidade', c.q) order by c.dow, c.hora)
      from calor c
    ), '[]'::jsonb),
    'atendentes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', coalesce(d.user_id, r.user_id),
        'atendimentos', coalesce(d.atendimentos, 0),
        'finalizados', coalesce(d.finalizados, 0),
        'em_aberto', coalesce(d.em_aberto, 0),
        'primeira_resposta_seg', round(d.primeira_seg::numeric, 1),
        'respostas', coalesce(r.respostas, 0),
        'resposta_seg', round(r.seg::numeric, 1)
      ) order by coalesce(d.atendimentos, 0) desc, coalesce(r.respostas, 0) desc, coalesce(d.user_id, r.user_id) nulls last)
      from por_dono d
      full outer join por_resp r on r.user_id = d.user_id
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.fn_desempenho_atendimento(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.fn_desempenho_atendimento(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated, service_role;

comment on function public.fn_desempenho_atendimento(uuid, timestamptz, timestamptz, uuid, uuid) is
  'Migration 0982: agregações da aba Atendimento de Desempenho (atendimentos = conversa × service_revision, tempos de primeira resposta e de resposta humanas, mapa de calor de mensagens recebidas, ranking). SECURITY INVOKER: a RLS de conversations e messages escopa o atendente.';

notify pgrst, 'reload schema';
