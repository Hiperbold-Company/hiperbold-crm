-- ============================================================================
-- 0979 — FILTRO "EVENTOS MANUAIS" NO QUADRO DO FUNIL: quantos eventos cada
-- negócio tem registrados à mão, contados no banco.
--
-- Pedido da CBEXS (28/10/2026): filtrar o quadro por quantidade de eventos
-- manuais ("maior que 5", "igual a 0"), para achar quem já recebeu muito
-- contato da equipe ou quem nunca recebeu nenhum.
--
-- A contagem é por negócio, só dos eventos registrados à mão ("Registrar evento" da
-- ficha): `crm_lead_activities` com type = 'note' e source_module = 'manual'
-- (lib/leads/evento-manual.ts, ORIGEM_DO_EVENTO_MANUAL). Nenhuma outra origem conta:
-- nota que o agente de IA ou uma automação escreve tem outro source_module.
--
-- Por que no banco: o quadro filtra no navegador, mas trazer a timeline inteira de
-- centenas de negócios só para contar linhas é o custo errado. A função devolve UMA
-- linha por negócio que tem ao menos um evento manual (quem não aparece tem zero).
--
-- Isolamento: SECURITY INVOKER — a RLS de crm_leads e de crm_lead_activities do
-- chamador vale inteira (inclusive a visão "só os meus" do atendente) — e, além
-- dela, o filtro explícito por p_organization_id nas DUAS tabelas, que a rota tira
-- da sessão, nunca da URL nem do corpo.
--
-- Desempenho: índice parcial (organization_id, lead_id) só das linhas manuais, que
-- são uma fração pequena da timeline (mensagens e mudanças de etapa são a maioria).
--
-- Reaplicável: create index if not exists + create or replace function.

set lock_timeout = '3s';

create index if not exists idx_lead_activities_manuais_por_lead
  on public.crm_lead_activities (organization_id, lead_id)
  where type = 'note' and source_module = 'manual';

create or replace function public.fn_contar_eventos_manuais_do_funil(
  p_organization_id uuid,
  p_pipeline_id uuid
)
returns table (lead_id uuid, total integer)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select a.lead_id, count(*)::integer as total
    from public.crm_lead_activities a
    join public.crm_leads l
      on l.id = a.lead_id
     and l.organization_id = p_organization_id
   where a.organization_id = p_organization_id
     and l.pipeline_id = p_pipeline_id
     and a.type = 'note'
     and a.source_module = 'manual'
   group by a.lead_id;
$$;

revoke execute on function public.fn_contar_eventos_manuais_do_funil(uuid, uuid) from public, anon;
grant execute on function public.fn_contar_eventos_manuais_do_funil(uuid, uuid) to authenticated, service_role;

comment on function public.fn_contar_eventos_manuais_do_funil(uuid, uuid) is
  'Eventos registrados à mão (type note, source_module manual) por negócio de um funil. Security invoker: a RLS do chamador vale; filtro explícito por organização. Só negócios com ao menos um evento.';

reset lock_timeout;
