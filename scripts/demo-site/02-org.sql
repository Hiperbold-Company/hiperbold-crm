-- Org de demonstração do site de vendas (Supabase LOCAL). Só cria; se já existe, não faz nada.
do $$
declare v_org uuid; v_dono uuid;
begin
  if exists (select 1 from public.organizations where slug = 'demo-site-2026') then
    raise notice 'org demo-site-2026 já existe, nada feito'; return;
  end if;
  select id into v_dono from auth.users where email = 'juliana.ferraz@exemplo.com.br';
  if v_dono is null then raise exception 'rode 01-usuarios.sh antes'; end if;
  insert into public.organizations (slug, display_name, legal_name, locale, timezone, currency, country, created_by, interface_settings)
  values ('demo-site-2026', 'Clínica Demonstração', 'Clínica Demonstração Odontologia Ltda', 'pt-BR', 'America/Sao_Paulo', 'BRL', 'BR', v_dono, '{"preset":"completa"}')
  returning id into v_org;
  insert into public.user_organizations (user_id, organization_id, role, accepted_at)
  select u.id, v_org, r.role, now() - interval '60 days'
  from (values ('juliana.ferraz@exemplo.com.br','admin'),('ricardo.almeida@exemplo.com.br','manager'),
               ('beatriz.santos@exemplo.com.br','agent'),('lucas.moreira@exemplo.com.br','agent')) r(email, role)
  join auth.users u on u.email = r.email
  on conflict (user_id, organization_id) do nothing;
  perform public.fn_billing_trocar_plano(v_org, 'max', v_dono);
  update public.organizations set onboarded_at = now() - interval '60 days', created_at = now() - interval '60 days' where id = v_org;
  raise notice 'org criada: %', v_org;
end $$;
