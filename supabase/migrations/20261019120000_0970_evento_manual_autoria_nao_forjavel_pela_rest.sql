-- 0970, evento manual da linha do tempo: a autoria e a data não se forjam pela REST (fork Hiperbold, achado de média
-- gravidade da auditoria da ficha do negócio, 19/10/2026).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. A rota POST /api/v1/leads/[id]/activities grava o "Registrar evento" da ficha pelo cliente da SESSÃO
-- (RLS), com performed_by_user_id = quem está logado e performed_at = a data escolhida. Mas a policy de INSERT de
-- crm_lead_activities (0042) só confere organização e papel agent+: o mesmo membro, falando direto com o PostgREST,
-- podia inserir uma linha manual com performed_by_user_id de OUTRO colega (a timeline mostraria o nome dele como
-- autor) e com data no futuro (a linha ficaria no topo da timeline e jogaria last_activity_at para a frente, o que
-- esconde o negócio do Radar de silêncio).
--
-- A correção. Uma policy RESTRICTIVE de INSERT para authenticated, que se SOMA (AND) à permissiva existente e só
-- olha a linha manual: source_module = 'manual' exige autor = auth.uid(), actor_kind = 'user' e performed_at até
-- 5 minutos à frente do banco (a mesma folga de relógio da rota). Linha de outra origem passa pelo mesmo caminho de
-- antes: a policy não restringe nada que não seja manual. service_role ignora RLS, então os escritores do servidor
-- (agente, crons, outras rotas) não mudam.
--
-- Limite conhecido: quem insere pela REST com source_module diferente de 'manual' continua sem a trava de autoria. É
-- o comportamento de antes e não é afrouxado nem endurecido aqui.
--
-- Reaplicável: drop policy if exists + create. Sem função nova: nada a revogar de PUBLIC/anon.

set lock_timeout = '3s';

drop policy if exists crm_lead_activities_manual_autoria on public.crm_lead_activities;

create policy crm_lead_activities_manual_autoria on public.crm_lead_activities
  as restrictive
  for insert
  to authenticated
  with check (
    source_module <> 'manual'
    or (
      performed_by_user_id = (select auth.uid())
      and actor_kind = 'user'
      and performed_at <= now() + interval '5 minutes'
    )
  );

comment on policy crm_lead_activities_manual_autoria on public.crm_lead_activities is
  'Evento manual da timeline (source_module = manual): autor = quem está logado, ator user e data até 5 min à frente. Restritiva: soma-se à policy de INSERT por papel e não toca nas outras origens.';

reset lock_timeout;
