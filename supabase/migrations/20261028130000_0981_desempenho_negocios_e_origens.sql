-- ============================================================================
-- 0981 — DESEMPENHO (BI): agregações de NEGÓCIOS e de ORIGENS no servidor.
--
-- A tela Desempenho (/app/metrics) vira a área de inteligência de dados do CRM,
-- com filtro global de período, funil e atendente. Os números saem daqui, já
-- agregados: o navegador nunca recebe as linhas de negócio para somar.
--
-- fn_desempenho_negocios — cartões (criados, ganhos, perdidos, em aberto e
--   carteira aberta), série diária no fuso da organização, negócios abertos por
--   etapa (funil escolhido) ou por funil (todos), movimentações de etapa no
--   período (crm_lead_activities type='stage_changed', destino em
--   payload.to_stage_id ou payload.para, as duas formas que os emissores gravam)
--   e o ranking por responsável.
-- fn_desempenho_origens — negócios CRIADOS no período por
--   custom_fields.utm_source / utm_medium / utm_campaign (minúsculas, sem espaço
--   nas pontas), com ganhos, perdidos, abertos, valor ganho e taxa de ganho
--   (ganhos ÷ criados). Chave nula = sem origem.
--
-- Regras de conta, iguais às de fn_attendant_metrics:
--   * perda por transferência entre funis ('moved_to_another_pipeline') não é
--     perda comercial (0266);
--   * janela semiaberta [p_from, p_to).
-- Dinheiro: só a MOEDA PRINCIPAL (a mais frequente entre os negócios do escopo
-- com valor) entra nas somas; `fora_da_moeda` conta o que ficou de fora. Somar
-- BRL com USD seria número inventado.
--
-- Isolamento: SECURITY INVOKER. Roda com o client da sessão, então a RLS de
-- crm_leads (0975) e de crm_lead_activities escopa o atendente aos negócios que
-- ele já vê hoje; gerente e admin veem a organização. `p_org` filtra
-- explicitamente toda tabela. Sem efeito: nada a auditar.
--
-- Reaplicável: create or replace. Revoga EXECUTE de PUBLIC e anon (as duas
-- origens: grant de criação a PUBLIC e default ACL do Supabase a anon).
-- ============================================================================

create or replace function public.fn_desempenho_negocios(
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
    ) as tz
  ),
  escopo as (
    select l.id, l.status, l.value_cents, l.currency, l.owner_user_id, l.created_at,
           l.closed_at, l.stage_id, l.pipeline_id, l.lost_reason
    from public.crm_leads l
    where l.organization_id = p_org
      and (p_pipeline is null or l.pipeline_id = p_pipeline)
      and (p_owner is null or l.owner_user_id = p_owner)
  ),
  moeda as (
    select coalesce((
      select e.currency from escopo e
      where e.value_cents is not null and e.currency is not null
        and ((e.created_at >= p_from and e.created_at < p_to)
          or (e.closed_at >= p_from and e.closed_at < p_to)
          or e.status = 'open')
      group by e.currency
      order by count(*) desc, e.currency
      limit 1
    ), 'BRL') as currency
  ),
  fatos as (
    select 'criados'::text as tipo, e.created_at as instante, e.value_cents, e.currency, e.owner_user_id
      from escopo e where e.created_at >= p_from and e.created_at < p_to
    union all
    select 'ganhos', e.closed_at, e.value_cents, e.currency, e.owner_user_id
      from escopo e where e.status = 'won' and e.closed_at >= p_from and e.closed_at < p_to
    union all
    select 'perdidos', e.closed_at, e.value_cents, e.currency, e.owner_user_id
      from escopo e
     where e.status = 'lost'
       and coalesce(e.lost_reason, '') <> 'moved_to_another_pipeline'
       and e.closed_at >= p_from and e.closed_at < p_to
    union all
    select 'em_aberto', e.created_at, e.value_cents, e.currency, e.owner_user_id
      from escopo e where e.status = 'open' and e.created_at >= p_from and e.created_at < p_to
  ),
  fatos_m as (
    select f.tipo, f.instante, f.owner_user_id,
           (f.value_cents is not null and f.currency = m.currency) as na_moeda,
           (f.value_cents is not null and f.currency is distinct from m.currency) as outra_moeda,
           case when f.currency = m.currency then coalesce(f.value_cents, 0) else 0 end as valor
    from fatos f cross join moeda m
  ),
  dias as (
    select d::date as dia
    from cfg, generate_series(
      (p_from at time zone cfg.tz)::date,
      ((p_to - interval '1 microsecond') at time zone cfg.tz)::date,
      interval '1 day'
    ) d
  ),
  fd as (
    select f.tipo, (f.instante at time zone cfg.tz)::date as dia, count(*) as q, sum(f.valor) as v
    from fatos_m f cross join cfg
    group by 1, 2
  ),
  mov as (
    select a.performed_at,
           nullif(coalesce(a.payload->>'to_stage_id', a.payload->>'para'), '') as destino
    from public.crm_lead_activities a
    join escopo e on e.id = a.lead_id
    where a.organization_id = p_org
      and a.type = 'stage_changed'
      and a.performed_at >= p_from and a.performed_at < p_to
  ),
  mov_dia as (
    select (m.performed_at at time zone cfg.tz)::date as dia, count(*) as q
    from mov m cross join cfg
    group by 1
  ),
  abertos as (
    select e.stage_id, e.pipeline_id, count(*) as q,
           sum(case when e.currency = m.currency then coalesce(e.value_cents, 0) else 0 end) as v
    from escopo e cross join moeda m
    where e.status = 'open'
    group by e.stage_id, e.pipeline_id
  ),
  por_dono as (
    select f.owner_user_id,
           count(*) filter (where f.tipo = 'criados') as criados,
           count(*) filter (where f.tipo = 'ganhos') as ganhos,
           count(*) filter (where f.tipo = 'perdidos') as perdidos,
           coalesce(sum(f.valor) filter (where f.tipo = 'ganhos'), 0) as valor_ganho,
           count(*) filter (where f.tipo = 'ganhos' and f.na_moeda) as ganhos_na_moeda
    from fatos_m f
    group by f.owner_user_id
  )
  select jsonb_build_object(
    'moeda', (select currency from moeda),
    'fuso', (select tz from cfg),
    'fora_da_moeda', (select count(*) from fatos_m where outra_moeda),
    'cartoes', jsonb_build_object(
      'criados', (select jsonb_build_object('quantidade', count(*), 'valor_cents', coalesce(sum(valor), 0)) from fatos_m where tipo = 'criados'),
      'ganhos', (select jsonb_build_object('quantidade', count(*), 'valor_cents', coalesce(sum(valor), 0)) from fatos_m where tipo = 'ganhos'),
      'perdidos', (select jsonb_build_object('quantidade', count(*), 'valor_cents', coalesce(sum(valor), 0)) from fatos_m where tipo = 'perdidos'),
      'em_aberto', (select jsonb_build_object('quantidade', count(*), 'valor_cents', coalesce(sum(valor), 0)) from fatos_m where tipo = 'em_aberto'),
      'carteira', (select jsonb_build_object('quantidade', coalesce(sum(q), 0), 'valor_cents', coalesce(sum(v), 0)) from abertos)
    ),
    'diario', coalesce((
      select jsonb_agg(x.obj order by x.dia) from (
        select d.dia, jsonb_build_object(
          'dia', to_char(d.dia, 'YYYY-MM-DD'),
          'criados', coalesce(sum(fd.q) filter (where fd.tipo = 'criados'), 0),
          'criados_valor_cents', coalesce(sum(fd.v) filter (where fd.tipo = 'criados'), 0),
          'ganhos', coalesce(sum(fd.q) filter (where fd.tipo = 'ganhos'), 0),
          'ganhos_valor_cents', coalesce(sum(fd.v) filter (where fd.tipo = 'ganhos'), 0),
          'perdidos', coalesce(sum(fd.q) filter (where fd.tipo = 'perdidos'), 0),
          'perdidos_valor_cents', coalesce(sum(fd.v) filter (where fd.tipo = 'perdidos'), 0),
          'em_aberto', coalesce(sum(fd.q) filter (where fd.tipo = 'em_aberto'), 0),
          'em_aberto_valor_cents', coalesce(sum(fd.v) filter (where fd.tipo = 'em_aberto'), 0),
          'movimentacoes', coalesce((select md.q from mov_dia md where md.dia = d.dia), 0)
        ) as obj
        from dias d left join fd on fd.dia = d.dia
        group by d.dia
      ) x
    ), '[]'::jsonb),
    'etapas', case when p_pipeline is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'stage_id', s.id, 'nome', s.name, 'posicao', s.position,
        'quantidade', coalesce(a.q, 0), 'valor_cents', coalesce(a.v, 0)
      ) order by s.position, s.name)
      from public.crm_stages s
      left join abertos a on a.stage_id = s.id
      where s.organization_id = p_org and s.pipeline_id = p_pipeline and s.is_archived = false
    ), '[]'::jsonb) end,
    'funis', case when p_pipeline is not null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'pipeline_id', p.id, 'nome', p.name,
        'quantidade', coalesce(x.q, 0), 'valor_cents', coalesce(x.v, 0)
      ) order by p.position, p.name)
      from public.crm_pipelines p
      left join (select pipeline_id, sum(q) as q, sum(v) as v from abertos group by pipeline_id) x
        on x.pipeline_id = p.id
      where p.organization_id = p_org and p.is_archived = false
    ), '[]'::jsonb) end,
    'movimentacoes', jsonb_build_object(
      'total', (select count(*) from mov),
      'por_etapa', coalesce((
        select jsonb_agg(jsonb_build_object(
          'stage_id', s.id, 'nome', s.name, 'funil', p.name, 'quantidade', x.q
        ) order by x.q desc, p.position, s.position)
        from (select destino, count(*) as q from mov where destino is not null group by destino) x
        join public.crm_stages s on s.id::text = x.destino and s.organization_id = p_org
        join public.crm_pipelines p on p.id = s.pipeline_id
      ), '[]'::jsonb)
    ),
    'atendentes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', d.owner_user_id,
        'criados', d.criados,
        'ganhos', d.ganhos,
        'perdidos', d.perdidos,
        'valor_ganho_cents', d.valor_ganho,
        'ticket_medio_cents', case when d.ganhos_na_moeda > 0
          then round(d.valor_ganho::numeric / d.ganhos_na_moeda) else null end
      ) order by d.valor_ganho desc, d.ganhos desc, d.criados desc, d.owner_user_id nulls last)
      from por_dono d
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.fn_desempenho_negocios(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.fn_desempenho_negocios(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated, service_role;

comment on function public.fn_desempenho_negocios(uuid, timestamptz, timestamptz, uuid, uuid) is
  'Migration 0981: agregações da aba Negócios de Desempenho (cartões, série diária no fuso da organização, abertos por etapa ou funil, movimentações de etapa, ranking por responsável). SECURITY INVOKER: a RLS de crm_leads escopa o atendente.';

create or replace function public.fn_desempenho_origens(
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
  escopo as (
    select l.status, l.value_cents, l.currency, l.lost_reason,
           nullif(lower(btrim(l.custom_fields->>'utm_source')), '') as src,
           nullif(lower(btrim(l.custom_fields->>'utm_medium')), '') as med,
           nullif(lower(btrim(l.custom_fields->>'utm_campaign')), '') as camp
    from public.crm_leads l
    where l.organization_id = p_org
      and (p_pipeline is null or l.pipeline_id = p_pipeline)
      and (p_owner is null or l.owner_user_id = p_owner)
      and l.created_at >= p_from and l.created_at < p_to
  ),
  moeda as (
    select coalesce((
      select e.currency from escopo e
      where e.value_cents is not null and e.currency is not null
      group by e.currency order by count(*) desc, e.currency limit 1
    ), 'BRL') as currency
  ),
  base as (
    select e.src, e.med, e.camp, e.status,
           (e.status = 'lost' and coalesce(e.lost_reason, '') <> 'moved_to_another_pipeline') as perdido,
           case when e.currency = m.currency then coalesce(e.value_cents, 0) else 0 end as valor
    from escopo e cross join moeda m
  ),
  linhas as (
    select 'source'::text as dim, src as chave, status, perdido, valor from base
    union all select 'medium', med, status, perdido, valor from base
    union all select 'campaign', camp, status, perdido, valor from base
  ),
  agg as (
    select dim, chave,
           count(*) as total,
           count(*) filter (where status = 'won') as ganhos,
           count(*) filter (where perdido) as perdidos,
           count(*) filter (where status = 'open') as abertos,
           coalesce(sum(valor) filter (where status = 'won'), 0) as valor_ganho
    from linhas
    group by dim, chave
  ),
  ordenado as (
    select a.*, row_number() over (partition by a.dim order by a.total desc, a.ganhos desc, a.chave nulls last) as rn
    from agg a
  )
  select jsonb_build_object(
    'moeda', (select currency from moeda),
    'total', (select count(*) from escopo),
    'limite', 50,
    'por_source', coalesce((select jsonb_agg(jsonb_build_object(
        'chave', o.chave, 'total', o.total, 'ganhos', o.ganhos, 'perdidos', o.perdidos,
        'abertos', o.abertos, 'valor_ganho_cents', o.valor_ganho,
        'taxa_de_ganho', round(o.ganhos::numeric / o.total, 4)
      ) order by o.rn) from ordenado o where o.dim = 'source' and o.rn <= 50), '[]'::jsonb),
    'por_medium', coalesce((select jsonb_agg(jsonb_build_object(
        'chave', o.chave, 'total', o.total, 'ganhos', o.ganhos, 'perdidos', o.perdidos,
        'abertos', o.abertos, 'valor_ganho_cents', o.valor_ganho,
        'taxa_de_ganho', round(o.ganhos::numeric / o.total, 4)
      ) order by o.rn) from ordenado o where o.dim = 'medium' and o.rn <= 50), '[]'::jsonb),
    'por_campaign', coalesce((select jsonb_agg(jsonb_build_object(
        'chave', o.chave, 'total', o.total, 'ganhos', o.ganhos, 'perdidos', o.perdidos,
        'abertos', o.abertos, 'valor_ganho_cents', o.valor_ganho,
        'taxa_de_ganho', round(o.ganhos::numeric / o.total, 4)
      ) order by o.rn) from ordenado o where o.dim = 'campaign' and o.rn <= 50), '[]'::jsonb),
    'cortado', jsonb_build_object(
      'source', (select count(*) > 50 from agg where dim = 'source'),
      'medium', (select count(*) > 50 from agg where dim = 'medium'),
      'campaign', (select count(*) > 50 from agg where dim = 'campaign')
    )
  );
$$;

revoke execute on function public.fn_desempenho_origens(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.fn_desempenho_origens(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated, service_role;

comment on function public.fn_desempenho_origens(uuid, timestamptz, timestamptz, uuid, uuid) is
  'Migration 0981: negócios criados no período por utm_source, utm_medium e utm_campaign (custom_fields), com ganhos e taxa de ganho. SECURITY INVOKER: a RLS de crm_leads escopa o atendente.';

notify pgrst, 'reload schema';
