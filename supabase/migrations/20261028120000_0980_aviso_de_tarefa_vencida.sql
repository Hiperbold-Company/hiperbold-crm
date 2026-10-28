-- ============================================================================
-- 0980 — A TAREFA AVISA QUEM PRECISA QUANDO VENCE (CBEXS, 28/10/2026).
--
-- `crm_tasks` (0210) tinha prazo e nenhum aviso: o prazo chegava em silêncio, e
-- quem marcou "ligar de volta às 10h" só descobria abrindo a tela de Tarefas.
-- Esta migration dá ao vencimento um ACONTECIMENTO: a varredura
-- `app/api/v1/cron/tarefas-vencidas` chama `fn_reivindicar_tarefas_vencidas`,
-- que marca a tarefa e emite `crm_task.due` no `event_log`; quem manda o push
-- ao celular de quem criou e do responsável é o consumidor do barramento
-- (`lib/notifications/push.handler.ts`). Nenhum gatilho, nenhum HTTP no banco.
--
-- UM AVISO POR TAREFA POR VENCIMENTO. `due_notified_for` guarda o prazo que já
-- foi avisado. A reivindicação só pega a linha quando `due_notified_for` é
-- diferente de `due_date` — então rodar de novo não avisa de novo, e REMARCAR
-- o prazo (03/11 vira 05/11) rearma o aviso sozinho, sem ninguém limpar nada.
-- O `update ... from (select ... for update skip locked)` torna a marca e a
-- emissão uma coisa só: duas rodadas sobrepostas do cron nunca pegam a mesma
-- linha, e se a emissão falhar a marca volta junto (mesma transação).
--
-- JANELA DE 24 HORAS. Só entra o que venceu nas últimas 24h. Sem a janela, a
-- primeira rodada depois do deploy avisaria de uma vez todas as tarefas
-- atrasadas há meses de toda instalação; com ela, o atraso antigo continua
-- visível na lista (e no sino da tela, que é derivado de `crm_tasks`), mas não
-- vira enxurrada no celular. A consequência, declarada: se o cron ficar parado
-- mais de 24h, os vencimentos desse intervalo não vão ao celular.
--
-- O EFEITO COLATERAL ACEITO. Marcar a tarefa passa pelo `trg_crm_tasks_updated_at`
-- e move o `updated_at`. Nenhuma tela ordena nem filtra tarefa por esse campo.
--
-- Isolamento: a função não recebe organização nem id; cada evento leva a
-- organização da PRÓPRIA linha (`p_organization_id => t.organization_id`). Ela
-- só é executável por `service_role` (revogada de public, anon e authenticated).
-- Idempotente: `add column if not exists`, `create index if not exists`,
-- `create or replace function`.
-- ============================================================================

alter table public.crm_tasks
  add column if not exists due_notified_for timestamptz;

comment on column public.crm_tasks.due_notified_for is
  '0980: o prazo (due_date) que já foi avisado a quem criou e ao responsável. Diferente de due_date = ainda não avisado neste vencimento; remarcar o prazo rearma o aviso. Escrito só por fn_reivindicar_tarefas_vencidas.';

-- A varredura de minuto em minuto: só o que está aberto e tem prazo.
create index if not exists crm_tasks_vencimento_aberto_idx
  on public.crm_tasks (due_date)
  where due_date is not null and status in ('pending', 'in_progress');

create or replace function public.fn_reivindicar_tarefas_vencidas(p_limite integer default 200)
returns table (task_id uuid, organization_id uuid, due_date timestamptz)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_linha record;
begin
  for v_linha in
    update public.crm_tasks t
       set due_notified_for = t.due_date
      from (
        select c.id
          from public.crm_tasks c
         where c.due_date is not null
           and c.status in ('pending', 'in_progress')
           and c.due_date <= now()
           and c.due_date > now() - interval '24 hours'
           and c.due_notified_for is distinct from c.due_date
         order by c.due_date, c.id
         limit greatest(1, least(coalesce(p_limite, 200), 1000))
         for update of c skip locked
      ) alvo
     where t.id = alvo.id
    returning t.id, t.organization_id, t.due_date, t.lead_id, t.contact_id, t.created_by, t.assigned_to
  loop
    perform public.emit_event(
      'crm_task.due',
      'crm_task',
      v_linha.id,
      jsonb_build_object(
        'task_id', v_linha.id,
        'lead_id', v_linha.lead_id,
        'contact_id', v_linha.contact_id,
        'due_date', v_linha.due_date,
        'created_by', v_linha.created_by,
        'assigned_to', v_linha.assigned_to
      ),
      jsonb_build_object('actor_kind', 'system', 'source', 'cron/tarefas-vencidas'),
      v_linha.organization_id
    );
    task_id := v_linha.id;
    organization_id := v_linha.organization_id;
    due_date := v_linha.due_date;
    return next;
  end loop;
end;
$$;

comment on function public.fn_reivindicar_tarefas_vencidas(integer) is
  '0980: marca (due_notified_for = due_date) as tarefas abertas que venceram nas últimas 24h e ainda não foram avisadas neste vencimento, e emite crm_task.due para cada uma, na organização da própria linha. Uma vez por tarefa por vencimento; skip locked contra rodadas sobrepostas. Chamada pelo cron tarefas-vencidas. Sem HTTP.';

revoke execute on function public.fn_reivindicar_tarefas_vencidas(integer) from public, anon, authenticated;
grant execute on function public.fn_reivindicar_tarefas_vencidas(integer) to service_role;

notify pgrst, 'reload schema';
