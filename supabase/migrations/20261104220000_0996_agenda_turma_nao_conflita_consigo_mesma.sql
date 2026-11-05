-- 0996, a turma não conflita consigo mesma na trava de agenda (D-160) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- A trava da 0937 (`fn_agenda_sem_sobreposicao`) recusa dois compromissos ativos do mesmo dono no
-- mesmo período. Depois do merge com o upstream (serviços e turmas, `fn_calendar_service_book`) isso
-- barrava o segundo participante de uma turma: os participantes de uma ocorrência dividem o dono, o
-- horário e o `service_occurrence_id`, e a turma ocupa o profissional UMA vez. A condição agora
-- ignora a linha da MESMA ocorrência; toda outra sobreposição (compromisso comum, outra ocorrência,
-- outra turma no mesmo horário) segue recusada com 23P01. Só a condição muda: gatilho, security
-- definer, search_path e revokes ficam como na 0937. Reaplicável: `create or replace`.

create or replace function public.fn_agenda_sem_sobreposicao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.owner_user_id is null or new.status not in ('pending', 'confirmed') then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.starts_at is not distinct from old.starts_at
     and new.ends_at is not distinct from old.ends_at
     and new.owner_user_id is not distinct from old.owner_user_id
     and new.organization_id is not distinct from old.organization_id
  then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('agenda_dono:' || new.organization_id::text || ':' || new.owner_user_id::text, 0));

  if exists (
    select 1 from public.calendar_appointments o
     where o.organization_id = new.organization_id
       and o.owner_user_id = new.owner_user_id
       and o.id <> new.id
       -- Participantes da MESMA turma (`service_occurrence_id`) são um só compromisso do profissional.
       and not (new.service_occurrence_id is not null
                and o.service_occurrence_id is not distinct from new.service_occurrence_id)
       and o.status in ('pending', 'confirmed')
       and o.starts_at < new.ends_at
       and o.ends_at > new.starts_at
  )
  then
    raise exception 'Horário indisponível: o responsável já tem um compromisso nesse período.' using errcode = '23P01';
  end if;

  return new;
end;
$$;

revoke execute on function public.fn_agenda_sem_sobreposicao() from public, anon, authenticated;
