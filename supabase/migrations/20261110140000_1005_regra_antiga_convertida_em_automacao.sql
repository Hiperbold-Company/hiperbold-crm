-- manifest: **Converter regra antiga em automação, numa transação só (lote 5 das Automações, "tela única", fork Hiperbold).** Coluna nova `automation_rules.migrated_to_pointer_id` (FK para `followup_flow_pointers`, `on delete set null`): a regra que virou automação aponta para ela, a lista única não a mostra duas vezes, e apagar a automação devolve a regra à lista (desligada). Função nova `fn_automacao_converter_regra(p_org, p_rule, p_pointer, p_graph, p_created_by)`: trava a regra e o ponteiro, desliga a regra, grava o vínculo e publica a versão do ponteiro (`fn_publish_followup_flow_version`) na MESMA transação; recusa regra de outra organização, já convertida ou ponteiro que não é automação. Dois gatilhos de guarda fecham o "dois motores ao mesmo tempo" pelos dois lados: religar uma regra convertida enquanto a automação dela está ligada, ou ligar a automação enquanto a regra de origem está ligada, recusa com PT409. Voltar atrás é manual: desligar a automação e religar a regra. `security definer` revogada de public/anon/authenticated e concedida só a service_role; as funções de gatilho revogadas de public/anon.
-- 1005 — Reaplicável: add column if not exists, create or replace function, drop trigger if exists
-- antes do create, revoke/grant idempotentes.

alter table public.automation_rules
  add column if not exists migrated_to_pointer_id uuid
    references public.followup_flow_pointers(id) on delete set null;

comment on column public.automation_rules.migrated_to_pointer_id is
  '1005: a automação (followup_flow_pointers, surface automacao) em que esta regra foi convertida. Com valor, a regra fica desligada enquanto a automação estiver ligada.';

create index if not exists idx_automation_rules_migrated_to_pointer
  on public.automation_rules (migrated_to_pointer_id)
  where migrated_to_pointer_id is not null;

-- A troca atômica: desliga a regra, grava o vínculo e publica a automação, ou nada.
create or replace function public.fn_automacao_converter_regra(
  p_org uuid,
  p_rule uuid,
  p_pointer uuid,
  p_graph jsonb,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rule record;
  v_ptr record;
begin
  select r.id, r.organization_id, r.migrated_to_pointer_id
    into v_rule
  from automation_rules r
  where r.id = p_rule
  for update;
  if not found or v_rule.organization_id <> p_org then
    raise exception 'rule_not_found' using errcode = 'P0001';
  end if;
  if v_rule.migrated_to_pointer_id is not null then
    raise exception 'rule_already_converted' using errcode = 'P0001';
  end if;

  select p.id, p.organization_id, p.surface
    into v_ptr
  from followup_flow_pointers p
  where p.id = p_pointer
  for update;
  if not found or v_ptr.organization_id <> p_org or v_ptr.surface is distinct from 'automacao' then
    raise exception 'pointer_not_found' using errcode = 'P0001';
  end if;

  -- Desliga ANTES de ligar: o gatilho de guarda do ponteiro olha a regra.
  update automation_rules
     set is_active = false,
         migrated_to_pointer_id = p_pointer,
         updated_at = now()
   where id = p_rule
     and organization_id = p_org;

  return fn_publish_followup_flow_version(p_org, p_pointer, p_graph, p_created_by);
end;
$$;

revoke all on function public.fn_automacao_converter_regra(uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.fn_automacao_converter_regra(uuid, uuid, uuid, jsonb, uuid) to service_role;

-- Guarda do lado da regra: religar a regra convertida com a automação ligada.
create or replace function public.fn_regra_convertida_nao_religa()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_active
     and new.migrated_to_pointer_id is not null
     and exists (
       select 1 from followup_flow_pointers p
        where p.id = new.migrated_to_pointer_id
          and p.organization_id = new.organization_id
          and p.status = 'active'
     ) then
    raise exception 'regra_convertida_com_automacao_ligada' using errcode = 'PT409',
      hint = 'Desligue a automação nova antes de religar a regra antiga.';
  end if;
  return new;
end;
$$;

revoke all on function public.fn_regra_convertida_nao_religa() from public, anon;

drop trigger if exists trg_regra_convertida_nao_religa on public.automation_rules;
create trigger trg_regra_convertida_nao_religa
  before insert or update of is_active, migrated_to_pointer_id on public.automation_rules
  for each row execute function public.fn_regra_convertida_nao_religa();

-- Guarda do lado da automação: ligar a automação com a regra de origem ligada.
create or replace function public.fn_automacao_nao_liga_com_regra_antiga()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from 'active')
     and exists (
       select 1 from automation_rules r
        where r.migrated_to_pointer_id = new.id
          and r.organization_id = new.organization_id
          and r.is_active
     ) then
    raise exception 'automacao_com_regra_antiga_ligada' using errcode = 'PT409',
      hint = 'Desligue a regra antiga antes de ligar a automação que veio dela.';
  end if;
  return new;
end;
$$;

revoke all on function public.fn_automacao_nao_liga_com_regra_antiga() from public, anon;

drop trigger if exists trg_automacao_nao_liga_com_regra_antiga on public.followup_flow_pointers;
create trigger trg_automacao_nao_liga_com_regra_antiga
  before insert or update of status on public.followup_flow_pointers
  for each row execute function public.fn_automacao_nao_liga_com_regra_antiga();

notify pgrst, 'reload schema';
