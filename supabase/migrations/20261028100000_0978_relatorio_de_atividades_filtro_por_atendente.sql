-- 0978 — RELATÓRIO DE ATIVIDADES: filtro por atendente.
--
-- Pedido da CBEXS (28/10/2026): a tela Atividades mostrava a equipe somada; a
-- gestora precisa ver o que UMA pessoa fez. `fn_activity_report` ganha o sexto
-- parâmetro `p_user uuid default null`: com ele, a janela inteira (total, por
-- ator, por tipo, série diária e lista) se restringe às atividades cujo
-- `performed_by_user_id` é essa pessoa. Null = comportamento de antes.
--
-- O filtro só ESTREITA: a função segue SECURITY INVOKER, então a RLS de
-- `crm_lead_activities` continua recortando por quem chama (agent em modo
-- 'own' não vê além do que já via). Quem garante que `p_user` é da mesma
-- organização é a rota (membro ativo de `user_organizations`); aqui, um id de
-- fora da org simplesmente não casa com nenhuma linha da `p_org`.
--
-- A assinatura MUDA (cinco -> seis parâmetros): a antiga é derrubada, senão a
-- RPC ficaria ambígua para o PostgREST (duas candidatas para a mesma chamada).
-- Único chamador: app/api/v1/reports/activities/route.ts.
--
-- Reaplicável: drop function if exists + create or replace + revoke/grant.

set lock_timeout = '3s';

drop function if exists public.fn_activity_report(uuid, timestamptz, timestamptz, text, int);

create or replace function public.fn_activity_report(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_tz text default 'UTC',
  p_limit int default 200,
  p_user uuid default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with janela as (
    select
      a.id,
      a.type,
      a.actor_kind,
      a.performed_by_user_id,
      a.actor_agent_id,
      a.performed_at,
      a.reason,
      a.lead_id,
      a.contact_id
    from public.crm_lead_activities a
    where a.organization_id = p_org
      and a.performed_at >= p_from
      and a.performed_at <  p_to
      -- Filtro por atendente (0978): só o que ESTA pessoa fez. Estreita, nunca
      -- alarga — a RLS de quem chama continua decidindo o que ele enxerga.
      and (p_user is null or a.performed_by_user_id = p_user)
  )
  select jsonb_build_object(
    'total', (select count(*) from janela),
    -- QUEM fez. Agrupa pela tripla (tipo de ator, pessoa, agente) porque duas
    -- pessoas diferentes com o mesmo `actor_kind` são duas linhas, não uma.
    'by_actor', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'actor_kind', g.actor_kind,
          'user_id', g.performed_by_user_id,
          'agent_id', g.actor_agent_id,
          'count', g.c
        ) order by g.c desc, coalesce(g.actor_kind, 'zzz')
      )
      from (
        select actor_kind, performed_by_user_id, actor_agent_id, count(*) as c
        from janela
        group by 1, 2, 3
      ) g
    ), '[]'::jsonb),
    -- O QUE foi feito. O tipo cru; o rótulo legível é do TypeScript
    -- (`ACTIVITY_LABELS`), fonte única de escrita e leitura.
    'by_type', coalesce((
      select jsonb_agg(
        jsonb_build_object('type', g.type, 'count', g.c) order by g.c desc, g.type
      )
      from (select type, count(*) as c from janela group by 1) g
    ), '[]'::jsonb),
    -- QUANDO. Dias sem atividade entram com zero — um buraco no gráfico é a
    -- informação (a operação parou), e omitir a linha esconde justamente isso.
    'daily', coalesce((
      select jsonb_agg(
        jsonb_build_object('date', to_char(d.dia, 'YYYY-MM-DD'), 'count', coalesce(c.n, 0))
        order by d.dia
      )
      from generate_series(
             date_trunc('day', p_from at time zone p_tz),
             date_trunc('day', (p_to - interval '1 microsecond') at time zone p_tz),
             interval '1 day'
           ) as d(dia)
      left join (
        select date_trunc('day', performed_at at time zone p_tz) as dia, count(*) as n
        from janela
        group by 1
      ) c on c.dia = d.dia
    ), '[]'::jsonb),
    -- A LISTA, limitada. O relatório não é a timeline: quem quer o histórico
    -- inteiro de um negócio abre o negócio, e é para lá que cada linha aponta.
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'type', i.type,
          'performed_at', i.performed_at,
          'actor_kind', i.actor_kind,
          'user_id', i.performed_by_user_id,
          'agent_id', i.actor_agent_id,
          'reason', i.reason,
          'lead_id', i.lead_id,
          'lead_title', i.lead_title,
          'contact_id', i.contact_id,
          -- Os TRÊS campos crus, não um rótulo pronto: como esta pessoa se chama
          -- na tela é decisão de `lib/contacts/rotulo-do-contato.ts`, e a cadeia
          -- já divergiu em seis arquivos uma vez.
          'contact_display_name', i.contact_display_name,
          'contact_name', i.contact_name,
          'contact_phone', i.contact_phone
        ) order by i.performed_at desc, i.id
      )
      from (
        select
          j.*,
          l.title as lead_title,
          ct.display_name as contact_display_name,
          ct.name as contact_name,
          ct.phone_number as contact_phone
        from janela j
        left join public.crm_leads l on l.id = j.lead_id
        left join public.contacts ct on ct.id = j.contact_id
        order by j.performed_at desc, j.id
        limit greatest(p_limit, 0)
      ) i
    ), '[]'::jsonb),
    -- A lista foi cortada? Sem isto, um período movimentado pareceria calmo.
    'items_truncated', (select count(*) from janela) > greatest(p_limit, 0)
  );
$$;

revoke all on function public.fn_activity_report(uuid, timestamptz, timestamptz, text, int, uuid) from public;
revoke execute on function public.fn_activity_report(uuid, timestamptz, timestamptz, text, int, uuid) from anon;
grant execute on function public.fn_activity_report(uuid, timestamptz, timestamptz, text, int, uuid)
  to authenticated, service_role;

reset lock_timeout;
