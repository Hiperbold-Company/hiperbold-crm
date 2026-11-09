-- manifest: **O worker acorda por NOTIFY em vez de perguntar ao banco a cada poucos segundos (fork Hiperbold).** Gatilhos por COMANDO (`for each statement`) em `event_log` (INSERT, canal `hb_event_log`, payload = tipos distintos inseridos) e em `job_queue` (INSERT, e UPDATE que deixa linha em `pending`, canal `hb_job_queue`) só fazem `pg_notify` — transacional e local, sem HTTP. `calendar_appointments` sai da publicação `supabase_realtime`: nenhum código a assina.

-- ============================================================================
-- 1000 — O WORKER ACORDA PELO BANCO, NÃO PELO RELÓGIO
--
-- Medido em produção (pg_stat_statements, ~52 dias): o laço do `event_log`
-- consultava o PostgREST ~18 mil vezes/dia e o relógio da `job_queue`
-- (`faltaParaOProximoJob`) ~40 mil vezes/dia, quase tudo com a fila vazia.
-- As linhas do `event_log` nascem em sua maioria de TRIGGERS — o app não sabe
-- quando elas aparecem —, então o aviso tem de sair do próprio banco.
--
-- ─── Por que NOTIFY não fere a regra "trigger nunca faz HTTP" ─────────────
-- `pg_notify` não sai do Postgres e é TRANSACIONAL: a notificação só é entregue
-- no COMMIT (rollback descarta), e notificações iguais na mesma transação viram
-- uma. Não espera rede, não segura lock de ninguém. O ouvinte é o worker
-- (`lib/agent-engine/ouvinte-do-banco.ts`), numa conexão própria.
--
-- ─── Por que por COMANDO e não por linha ──────────────────────────────────
-- Um lote de 200 eventos vira UMA notificação. O payload do `event_log` leva os
-- tipos DISTINTOS inseridos, para o worker não acordar o laço dos handlers por
-- evento que nenhum handler dele consome (ex.: `ai_agent.dispatch_requested`).
-- Payload longo demais (limite de 8000 bytes do NOTIFY) vira `*`, que o worker
-- lê como "pode ser qualquer tipo".
--
-- ─── Por que UPDATE na job_queue também ───────────────────────────────────
-- O retry (`failJob`), o reagendamento sem gastar tentativa (`rescheduleJob`), o
-- reaper e a liberação do hold de sessão devolvem o job a `pending` por UPDATE.
-- Só notifica quando ALGUMA linha atualizada ficou `pending`: o claim
-- (`pending` → `running`) e o fim do job não acordam ninguém.
--
-- ─── Por que `security invoker` ───────────────────────────────────────────
-- `pg_notify` é executável por PUBLIC; a função não lê nem escreve tabela
-- nenhuma além da tabela de transição do próprio comando. Não precisa de
-- definer. O EXECUTE de função de trigger só é conferido no CREATE TRIGGER,
-- então revogar de todos os papéis do PostgREST não muda o disparo.
--
-- ─── calendar_appointments sai da publicação ──────────────────────────────
-- A 0183 a publicou para um assinante que nunca foi escrito: nenhum
-- `.channel(`/`postgres_changes`/`useRealtimeChannel` em hooks, components,
-- app, lib ou workers a assina. Publicada sem consumidor, cada escrita só
-- custava decodificação no Realtime. Mesmo molde da 9046: `drop` guardado por
-- `pg_publication_tables` (o comando não aceita `if exists`).
--
-- Idempotente: `create or replace`, `drop trigger if exists`, drop guardado.
-- ============================================================================

create or replace function public.fn_event_log_notifica_worker()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_tipos text;
begin
  select string_agg(distinct n.event_type, ',') into v_tipos from novos n;
  if v_tipos is null then
    return null;
  end if;
  if length(v_tipos) > 7000 then
    v_tipos := '*';
  end if;
  perform pg_notify('hb_event_log', v_tipos);
  return null;
end;
$$;

revoke execute on function public.fn_event_log_notifica_worker() from public, anon, authenticated;

drop trigger if exists trg_event_log_notifica_worker on public.event_log;
create trigger trg_event_log_notifica_worker
  after insert on public.event_log
  referencing new table as novos
  for each statement
  execute function public.fn_event_log_notifica_worker();

create or replace function public.fn_job_queue_notifica_worker()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if not exists (select 1 from novos n where n.status = 'pending') then
      return null;
    end if;
  end if;
  perform pg_notify('hb_job_queue', '');
  return null;
end;
$$;

revoke execute on function public.fn_job_queue_notifica_worker() from public, anon, authenticated;

drop trigger if exists trg_job_queue_notifica_worker on public.job_queue;
create trigger trg_job_queue_notifica_worker
  after insert on public.job_queue
  for each statement
  execute function public.fn_job_queue_notifica_worker();

-- Trigger separado para o UPDATE: tabela de transição não vale para trigger de
-- mais de um evento.
drop trigger if exists trg_job_queue_notifica_worker_update on public.job_queue;
create trigger trg_job_queue_notifica_worker_update
  after update on public.job_queue
  referencing new table as novos
  for each statement
  execute function public.fn_job_queue_notifica_worker();

do $$
begin
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'calendar_appointments'
  ) then
    execute 'alter publication supabase_realtime drop table public.calendar_appointments';
  end if;
end $$;

comment on table public.calendar_appointments is
  'O compromisso COMBINADO: hora marcada, com alguém, ocupando a agenda de um atendente. Distinto do RETORNO agendado (cron_jobs kind=at, job_kind=followup_turn), que é decisão interna do sistema, não ocupa agenda de ninguém e o cliente não sabe. FORA da publicação supabase_realtime desde a 1000: a 0183 a publicou para um assinante que nunca foi escrito. Quem for assinar devolve a tabela à publicação e lembra que, sem replica identity full, o DELETE só traz o id.';
