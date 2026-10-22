-- 0976, filhas e escrita de negócios sem custo por linha para quem vê a organização toda (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. A 0975 tirou o custo por linha da LEITURA de crm_leads e das três filhas diretas, e deixou dois
-- lugares com o mesmo custo:
--   - as 16 policies restritivas `visibilidade_por_atendente` (0939) chamam fn_registro_filho_visivel para CADA
--     linha, e a função começa por fn_user_role_in_org (que relê o contexto do suporte) mesmo para o gerente,
--     que vê tudo;
--   - as policies de escrita de crm_leads (insert, update, delete) chamam fn_role_at_least(organization_id, ...)
--     duas vezes por linha, e cada chamada também passa por fn_user_role_in_org. Mover, editar ou apagar negócios
--     em lote pagava isso por linha alcançada.
--
-- A correção, a mesma da 0975.
--   - Filhas: cada policy passa a perguntar primeiro `organization_id in (select public.fn_orgs_com_visao_total())`
--     (subconsulta sem correlação: avaliada uma vez por consulta, guardada em hash) e só cai em
--     fn_registro_filho_visivel, por linha, quando o atalho não decide. O atalho devolve as organizações de
--     fn_user_org_ids() onde fn_user_role_in_org é viewer, manager ou admin, e para essas a função devolve
--     verdadeiro na primeira linha do corpo: o atalho só diz sim onde a função já dizia. Em voice_calls os dois
--     ramos de quem fez ou atendeu a ligação ficam como estavam.
--   - Escrita de crm_leads: fn_role_at_least(organization_id, X) vira
--     `organization_id in (select o.organizacao from public.fn_user_org_ids() as o(organizacao)
--                           where public.fn_role_at_least(o.organizacao, X))`.
--     A expressão já exige `organization_id in (select public.fn_user_org_ids())` ao lado, e para uma organização
--     desse conjunto pertencer ao subconjunto filtrado é exatamente fn_role_at_least ser verdadeira: a mesma
--     função, chamada uma vez por organização do usuário em vez de uma vez por linha. fn_is_platform_admin()
--     entra como `(select ...)`, como no SELECT da 0975 (sem argumento: o valor é o mesmo para todas as linhas).
--
-- Quem vê e quem escreve o quê não muda. Prova em tests/invariants/filhas-e-escrita-sem-custo-por-linha.test.ts.
--
-- Policies reescritas:
--   visibilidade_por_atendente em agent_cases, ai_agent_runs, ai_invocations, ai_router_decisions,
--     contact_field_proposals, conversation_notes, crm_lead_reactivations, crm_lead_risk_states, crm_lead_scores,
--     demanda_conversas, demandas, followup_enrollments, golden_candidates, jev_observacoes, lead_checkpoints,
--     voice_calls (0939);
--   crm_leads_insert, crm_leads_update, crm_leads_delete (0036, reescritas pela 0975).
--
-- Não cria função. Reaplicável com o app no ar: um DO por tabela com lock_timeout curto, drop policy if exists e
-- create policy colados, nada que reescreva linha.

do $t_agent_cases$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.agent_cases;
 create policy visibilidade_por_atendente on public.agent_cases as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, conversation_id, lead_id)));
end
$t_agent_cases$;

do $t_ai_agent_runs$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.ai_agent_runs;
 create policy visibilidade_por_atendente on public.ai_agent_runs as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, conversation_id, null)));
end
$t_ai_agent_runs$;

do $t_ai_invocations$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.ai_invocations;
 create policy visibilidade_por_atendente on public.ai_invocations as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, conversation_id, null)));
end
$t_ai_invocations$;

do $t_ai_router_decisions$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.ai_router_decisions;
 create policy visibilidade_por_atendente on public.ai_router_decisions as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, conversation_id, null)));
end
$t_ai_router_decisions$;

do $t_contact_field_proposals$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.contact_field_proposals;
 create policy visibilidade_por_atendente on public.contact_field_proposals as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, conversation_id, null)));
end
$t_contact_field_proposals$;

do $t_conversation_notes$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.conversation_notes;
 create policy visibilidade_por_atendente on public.conversation_notes as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, conversation_id, null)));
end
$t_conversation_notes$;

do $t_crm_lead_reactivations$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.crm_lead_reactivations;
 create policy visibilidade_por_atendente on public.crm_lead_reactivations as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, null, lead_id)));
end
$t_crm_lead_reactivations$;

do $t_crm_lead_risk_states$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.crm_lead_risk_states;
 create policy visibilidade_por_atendente on public.crm_lead_risk_states as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, null, lead_id)));
end
$t_crm_lead_risk_states$;

do $t_crm_lead_scores$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.crm_lead_scores;
 create policy visibilidade_por_atendente on public.crm_lead_scores as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, null, lead_id)));
end
$t_crm_lead_scores$;

do $t_demanda_conversas$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.demanda_conversas;
 create policy visibilidade_por_atendente on public.demanda_conversas as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, conversation_id, null)));
end
$t_demanda_conversas$;

do $t_demandas$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.demandas;
 create policy visibilidade_por_atendente on public.demandas as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, null, lead_id)));
end
$t_demandas$;

do $t_followup_enrollments$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.followup_enrollments;
 create policy visibilidade_por_atendente on public.followup_enrollments as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, conversation_id, null)));
end
$t_followup_enrollments$;

do $t_golden_candidates$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.golden_candidates;
 create policy visibilidade_por_atendente on public.golden_candidates as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, null, lead_id)));
end
$t_golden_candidates$;

do $t_jev_observacoes$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.jev_observacoes;
 create policy visibilidade_por_atendente on public.jev_observacoes as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, conversation_id, null)));
end
$t_jev_observacoes$;

do $t_lead_checkpoints$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.lead_checkpoints;
 create policy visibilidade_por_atendente on public.lead_checkpoints as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, conversation_id, null)));
end
$t_lead_checkpoints$;

do $t_voice_calls$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists visibilidade_por_atendente on public.voice_calls;
 create policy visibilidade_por_atendente on public.voice_calls as restrictive for select using ((organization_id in (select public.fn_orgs_com_visao_total()) or public.fn_registro_filho_visivel(organization_id, null, lead_id) or owner_user_id = (select auth.uid()) or created_by = (select auth.uid())));
end
$t_voice_calls$;

do $t_crm_leads_escrita$
begin
 perform set_config('lock_timeout','3s',true);

 drop policy if exists "crm_leads_insert" on public.crm_leads;
 create policy "crm_leads_insert" on public.crm_leads
   for insert with check (
     (select public.fn_is_platform_admin())
     or ((organization_id in (select public.fn_user_org_ids()))
         and organization_id in (select o.organizacao from public.fn_user_org_ids() as o(organizacao)
                                  where public.fn_role_at_least(o.organizacao, 'agent'))
         and (organization_id in (select o.organizacao from public.fn_user_org_ids() as o(organizacao)
                                   where public.fn_role_at_least(o.organizacao, 'manager'))
              or (organization_id in (select public.fn_orgs_com_visao_total())
                  or public.fn_can_view_lead(organization_id, owner_user_id))))
   );

 drop policy if exists "crm_leads_update" on public.crm_leads;
 create policy "crm_leads_update" on public.crm_leads
   for update using (
     (select public.fn_is_platform_admin())
     or ((organization_id in (select public.fn_user_org_ids()))
         and organization_id in (select o.organizacao from public.fn_user_org_ids() as o(organizacao)
                                  where public.fn_role_at_least(o.organizacao, 'agent'))
         and (organization_id in (select o.organizacao from public.fn_user_org_ids() as o(organizacao)
                                   where public.fn_role_at_least(o.organizacao, 'manager'))
              or (organization_id in (select public.fn_orgs_com_visao_total())
                  or public.fn_can_view_lead(organization_id, owner_user_id))))
   ) with check (
     (select public.fn_is_platform_admin())
     or ((organization_id in (select public.fn_user_org_ids()))
         and organization_id in (select o.organizacao from public.fn_user_org_ids() as o(organizacao)
                                  where public.fn_role_at_least(o.organizacao, 'agent'))
         and (organization_id in (select o.organizacao from public.fn_user_org_ids() as o(organizacao)
                                   where public.fn_role_at_least(o.organizacao, 'manager'))
              or (organization_id in (select public.fn_orgs_com_visao_total())
                  or public.fn_can_view_lead(organization_id, owner_user_id))))
   );

 drop policy if exists "crm_leads_delete" on public.crm_leads;
 create policy "crm_leads_delete" on public.crm_leads
   for delete using (
     (select public.fn_is_platform_admin())
     or ((organization_id in (select public.fn_user_org_ids()))
         and organization_id in (select o.organizacao from public.fn_user_org_ids() as o(organizacao)
                                  where public.fn_role_at_least(o.organizacao, 'agent'))
         and (organization_id in (select o.organizacao from public.fn_user_org_ids() as o(organizacao)
                                   where public.fn_role_at_least(o.organizacao, 'manager'))
              or (organization_id in (select public.fn_orgs_com_visao_total())
                  or public.fn_can_view_lead(organization_id, owner_user_id))))
   );
end
$t_crm_leads_escrita$;

notify pgrst, 'reload schema';
