-- 0975, visão de negócios sem custo por linha (fork Hiperbold, medido em produção em 21/10/2026).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. A policy de SELECT de crm_leads chamava fn_can_view_lead(organization_id, owner_user_id) para CADA
-- linha, e ela chama fn_user_role_in_org duas vezes, cada uma relendo o contexto do suporte (fn_support_context:
-- join em platform_support_sessions, organizations, platform_admins e auth.sessions). Numa organização com 6.588
-- negócios, `select custom_fields from crm_leads where organization_id = ... order by updated_at desc limit 300`
-- levava 19 s para um gerente (0,7 s para o admin da plataforma, que sai no primeiro ramo). O navegador desistia
-- em 10 s: a tela de Contatos ficava sem os funis, e o kanban e as listas também pagavam o custo.
--
-- A correção. fn_orgs_com_visao_total() devolve, UMA vez por consulta, as organizações em que o papel EFETIVO de
-- quem chama é viewer, manager ou admin. Por construção é a mesma regra de fn_can_view_lead: a função percorre
-- fn_user_org_ids() (vínculos ativos mais a organização do suporte ativo) e filtra por fn_user_role_in_org, que é
-- quem fn_can_view_lead consulta. As policies passam a perguntar primeiro
-- `organization_id in (select public.fn_orgs_com_visao_total())` (subconsulta sem correlação: o Postgres a avalia
-- uma vez e guarda em hash) e só caem em fn_can_view_lead, linha a linha, para quem é agent. O atalho só devolve
-- verdadeiro onde fn_can_view_lead já devolveria verdadeiro: quem vê o quê não muda.
--
-- Policies reescritas (o resto de cada expressão fica idêntico):
--   crm_leads: crm_leads_select (também com `(select fn_is_platform_admin())` na frente), crm_leads_insert,
--     crm_leads_update, crm_leads_delete (0036);
--   crm_lead_activities_select e crm_lead_links_select (0042);
--   tenant_isolation_crm_lead_itens_select/_insert/_update/_delete (0972).
--
-- Fica de fora: fn_registro_filho_visivel (0939). Ela só chega a fn_can_view_lead para o agent, então o atalho
-- dentro dela não muda nada; o custo por linha ali é o fn_user_role_in_org da própria função.
--
-- Reaplicável: create or replace function e drop policy if exists + create policy, um par colado por policy.
-- Cria função: revoga de public e anon (as duas origens de EXECUTE) e concede só a authenticated e service_role.

set lock_timeout = '3s';

create or replace function public.fn_orgs_com_visao_total()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select o.organizacao
    from public.fn_user_org_ids() as o(organizacao)
   where public.fn_user_role_in_org(o.organizacao) in ('viewer', 'manager', 'admin');
$$;

revoke execute on function public.fn_orgs_com_visao_total() from public, anon;
grant execute on function public.fn_orgs_com_visao_total() to authenticated, service_role;

comment on function public.fn_orgs_com_visao_total() is
  'Migration 0975: organizações em que o papel efetivo de auth.uid() (fn_user_role_in_org, com o suporte ativo) é viewer, manager ou admin. Atalho das policies de negócio: avaliado uma vez por consulta, antes de fn_can_view_lead por linha.';

-- ---- crm_leads (0036) ----

drop policy if exists "crm_leads_select" on public.crm_leads;
create policy "crm_leads_select" on public.crm_leads
  for select using (
    (select public.fn_is_platform_admin())
    or organization_id in (select public.fn_orgs_com_visao_total())
    or public.fn_can_view_lead(organization_id, owner_user_id)
  );

drop policy if exists "crm_leads_insert" on public.crm_leads;
create policy "crm_leads_insert" on public.crm_leads
  for insert with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or (organization_id in (select public.fn_orgs_com_visao_total())
                 or public.fn_can_view_lead(organization_id, owner_user_id))))
  );

drop policy if exists "crm_leads_update" on public.crm_leads;
create policy "crm_leads_update" on public.crm_leads
  for update using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or (organization_id in (select public.fn_orgs_com_visao_total())
                 or public.fn_can_view_lead(organization_id, owner_user_id))))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or (organization_id in (select public.fn_orgs_com_visao_total())
                 or public.fn_can_view_lead(organization_id, owner_user_id))))
  );

drop policy if exists "crm_leads_delete" on public.crm_leads;
create policy "crm_leads_delete" on public.crm_leads
  for delete using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or (organization_id in (select public.fn_orgs_com_visao_total())
                 or public.fn_can_view_lead(organization_id, owner_user_id))))
  );

-- ---- crm_lead_activities e crm_lead_links (0042) ----

drop policy if exists "crm_lead_activities_select" on public.crm_lead_activities;
create policy "crm_lead_activities_select" on public.crm_lead_activities
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_activities.lead_id
        and (l.organization_id in (select public.fn_orgs_com_visao_total())
             or public.fn_can_view_lead(l.organization_id, l.owner_user_id))
    )
  );

drop policy if exists "crm_lead_links_select" on public.crm_lead_links;
create policy "crm_lead_links_select" on public.crm_lead_links
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_links.lead_id
        and (l.organization_id in (select public.fn_orgs_com_visao_total())
             or public.fn_can_view_lead(l.organization_id, l.owner_user_id))
    )
  );

-- ---- crm_lead_itens (0972) ----

drop policy if exists tenant_isolation_crm_lead_itens_select on public.crm_lead_itens;
create policy tenant_isolation_crm_lead_itens_select on public.crm_lead_itens
  for select using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_itens.lead_id
           and l.organization_id = crm_lead_itens.organization_id
           and (l.organization_id in (select public.fn_orgs_com_visao_total())
                or public.fn_can_view_lead(l.organization_id, l.owner_user_id))
      )
    )
  );

drop policy if exists tenant_isolation_crm_lead_itens_insert on public.crm_lead_itens;
create policy tenant_isolation_crm_lead_itens_insert on public.crm_lead_itens
  for insert with check (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_itens.lead_id
           and l.organization_id = crm_lead_itens.organization_id
           and (l.organization_id in (select public.fn_orgs_com_visao_total())
                or public.fn_can_view_lead(l.organization_id, l.owner_user_id))
      )
    )
  );

drop policy if exists tenant_isolation_crm_lead_itens_update on public.crm_lead_itens;
create policy tenant_isolation_crm_lead_itens_update on public.crm_lead_itens
  for update using (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_itens.lead_id
           and l.organization_id = crm_lead_itens.organization_id
           and (l.organization_id in (select public.fn_orgs_com_visao_total())
                or public.fn_can_view_lead(l.organization_id, l.owner_user_id))
      )
    )
  ) with check (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_itens.lead_id
           and l.organization_id = crm_lead_itens.organization_id
           and (l.organization_id in (select public.fn_orgs_com_visao_total())
                or public.fn_can_view_lead(l.organization_id, l.owner_user_id))
      )
    )
  );

drop policy if exists tenant_isolation_crm_lead_itens_delete on public.crm_lead_itens;
create policy tenant_isolation_crm_lead_itens_delete on public.crm_lead_itens
  for delete using (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_itens.lead_id
           and l.organization_id = crm_lead_itens.organization_id
           and (l.organization_id in (select public.fn_orgs_com_visao_total())
                or public.fn_can_view_lead(l.organization_id, l.owner_user_id))
      )
    )
  );

reset lock_timeout;

notify pgrst, 'reload schema';
