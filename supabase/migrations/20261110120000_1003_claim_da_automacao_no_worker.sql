-- manifest: **O claim das automações para o laço rápido do worker (lote 6 das Automações, fork Hiperbold).** Função nova `fn_claim_due_automacao_enrollments(p_limit, p_lease_seconds)`: a MESMA definição vigente de `fn_claim_due_followup_enrollments` (rodízio justo entre organizações, só organização `active`, lease repetido no UPDATE), com UM filtro a mais — `lane = 'automacao'` nas duas leituras. O `agent-worker` a chama a cada ~5 s (`AUTOMACAO_RUNNER_INTERVAL_MS`) para que uma espera curta da automação retome em segundos; o cron `followup-flow-worker` (1×/min) continua como piso e reclama TODAS as raias. Os dois escrevem o mesmo `claimed_until`, então uma execução reclamada por um não é reclamada pelo outro até o lease vencer. Nenhuma tabela muda. `security definer`, revogada de public/anon/authenticated, concedida só a service_role.

-- ============================================================================
-- 1003 — O CLAIM DAS AUTOMAÇÕES PARA O LAÇO RÁPIDO DO WORKER
--
-- Por que uma função nova, e não um parâmetro na antiga: a antiga é chamada
-- pelo cron e pelo relógio HTTP com dois argumentos; trocar a assinatura
-- quebraria quem atualiza o app antes do banco (e vice-versa). Uma função a
-- mais, com o mesmo corpo e um filtro, não muda nada para quem já chama.
--
-- Por que filtrar a raia: o laço de 5 s não pode andar os follow-ups (que
-- enfileiram turno de IA e têm o próprio ritmo de 1 min); só as automações têm
-- espera em segundos.
-- ============================================================================

create or replace function fn_claim_due_automacao_enrollments(p_limit int, p_lease_seconds int)
returns setof followup_enrollments
language sql
security definer
set search_path = public
as $$
  with orgs as (
    -- Sem a condição de claim aqui de propósito: o lateral abaixo a aplica, e uma
    -- organização cujos vencidos estão todos com lease apenas devolve zero linhas.
    select distinct organization_id
      from followup_enrollments
     where lane = 'automacao'
       and status in ('active','waiting_reply','dormente')
       and next_eval_at <= now()
       -- Organização parada (suspensa, redigida, arquivada) não roda follow-up
       -- (migration 0501).
       and exists (select 1 from public.organizations o
                    where o.id = followup_enrollments.organization_id
                      and o.status = 'active')
  ),
  fila as (
    select f.id, f.next_eval_at, f.posicao_na_org
      from orgs
      cross join lateral (
        select d.id,
               d.next_eval_at,
               row_number() over (order by d.next_eval_at) as posicao_na_org
          from followup_enrollments d
         where d.organization_id = orgs.organization_id
           and d.lane = 'automacao'
           and d.status in ('active','waiting_reply','dormente')
           and d.next_eval_at <= now()
           and (d.claimed_until is null or d.claimed_until < now())
         order by d.next_eval_at
         limit p_limit
      ) f
  ),
  escolhidos as (
    -- O rodízio: posição 1 de todas as organizações, depois a 2 de todas, etc.
    -- Empate na mesma posição vai para quem esperou mais.
    select id from fila order by posicao_na_org, next_eval_at limit p_limit
  ),
  travados as (
    select e.id from followup_enrollments e
     where e.id in (select id from escolhidos)
     for update skip locked
  )
  update followup_enrollments e
     set claimed_until = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where e.id in (select id from travados)
     -- A condição de lease É REPETIDA AQUI, e não é redundante com a CTE `fila`.
     -- Sem ela, duas conexões simultâneas reclamam as MESMAS linhas: a segunda
     -- espera o lock da primeira, e quando ele sai o Postgres (READ COMMITTED)
     -- reavalia só o WHERE do UPDATE — que não olhava `claimed_until` — e grava
     -- por cima. O `skip locked` da CTE não salva: as duas materializam a mesma
     -- lista antes de qualquer lock existir. Medido: interseção de 5 em 5 no
     -- invariante de concorrência (followup-schema.test.ts).
     and (e.claimed_until is null or e.claimed_until < now())
  returning e.*;
$$;

revoke execute on function fn_claim_due_automacao_enrollments(int, int) from public, anon, authenticated;
grant execute on function fn_claim_due_automacao_enrollments(int, int) to service_role;
