-- 1011, a view de reconciliação do Google volta a ter todas as colunas da agenda (D-194, fork Hiperbold).
--
-- O defeito. `calendar_google_reconcilable_appointments` é `select a.* from calendar_appointments a where ...`
-- (migration 0225). O Postgres EXPANDE o `*` no instante em que a view é criada, e a view só o refaz quando
-- alguém a recria. No `baseline.sql` a view era criada no bloco da 0225, ANTES de as colunas `meeting_*`,
-- `service_*`, `guest_email`, `reminder_sent_offsets_minutes`, `starts_at_marked_at` e as demais chegarem à
-- tabela base pelos apêndices seguintes. Medido num Postgres descartável, baseline aplicado uma vez
-- (o `install.sh`): a view tinha 51 colunas contra 79 da tabela. Só uma segunda aplicação (o `update.sh`)
-- a levava a 79, porque `create or replace view` acrescenta as colunas que faltam no fim — e por isso a
-- produção (que já passou por updates) tem as 79 e a instalação nova, até o primeiro update, não.
--
-- A correção. Recriar a view DEPOIS de todas as colunas existirem: `drop view if exists` + `create view`
-- (não `create or replace`, que só acrescenta ao fim e preserva a ordem errada), com a MESMA definição e o
-- MESMO filtro da 0225 (titular anonimizado fica de fora) e `security_invoker`. Mesmos revoke e grant: só o
-- `service_role` lê. Nada depende da view (conferido em pg_depend), então o drop não precisa de cascade.
--
-- Efeito na produção: a ordem das colunas da view passa a seguir a da tabela (`needs_google_push` sobe da
-- 63a para a 51a posição). O consumidor (`agenda-google-sync`) lê por nome, não por posição.
--
-- Esta migration vai ao fim do apêndice do baseline (antes só da varredura da 1008), para que todo update.sh
-- recrie a view depois de qualquer coluna nova da `calendar_appointments`.

drop view if exists public.calendar_google_reconcilable_appointments;

create view public.calendar_google_reconcilable_appointments with (security_invoker=true) as
 select a.* from public.calendar_appointments a where not exists(
  select 1 from public.contacts c where c.organization_id=a.organization_id and c.id=a.contact_id and c.is_anonymized);

revoke all on public.calendar_google_reconcilable_appointments from public,anon,authenticated;
grant select on public.calendar_google_reconcilable_appointments to service_role;

notify pgrst,'reload schema';
