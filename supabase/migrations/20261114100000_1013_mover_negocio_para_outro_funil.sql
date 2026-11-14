-- 1013, mover um negócio para uma etapa de OUTRO funil por um caminho nomeado (fork Hiperbold,
-- decisão do dono do produto em 14/11/2026).
--
-- Até aqui `crm_leads.pipeline_id` era imutável só na API (P-01: o `/move`, o `moveLeadHandler` e o lote
-- devolvem 422 `pipeline_immutable_use_clone`), e a troca de funil era o CLONE: negócio novo no destino,
-- origem encerrada como `lost`. O banco só conferia que a etapa é do funil da linha
-- (`trg_lead_etapa_do_mesmo_funil`, 0934): um UPDATE que trocasse `pipeline_id` e `stage_id` juntos
-- passava. Agora:
--
--  1. `trg_lead_funil_so_pela_troca_nomeada` (BEFORE UPDATE OF pipeline_id): recusa com PT422 toda troca
--     de `pipeline_id` que não venha da função abaixo. A chave de liberação é de TRANSAÇÃO
--     (`deskcomm.mover_entre_funis` = id do negócio), posta e retirada pela própria função.
--  2. `fn_mover_negocio_para_outro_funil(org, lead, etapa, posição?, updated_at esperado?)`, security
--     definer, só `service_role`: confere negócio, etapa e funil de destino na MESMA organização
--     (erro genérico PT404), recusa etapa/funil arquivado e etapa do mesmo funil (PT422), trava otimista
--     (PT409), e troca `pipeline_id` + `stage_id` + `position_in_stage` numa escrita só. O negócio
--     mantém id, contato, responsável, histórico e `custom_fields` (nada é apagado). Não faz HTTP nem
--     emite evento: quem chama (`moverParaOutroFunilHandler`) emite `lead.stage_changed`, a atividade
--     e a auditoria, como a troca de etapa comum.
--
-- Nenhum escritor do código troca `pipeline_id` de negócio hoje (varrido em TS e SQL), então a trava não
-- quebra caminho existente. Os gatilhos de etapa (fechamento por etapa, stage_changed_at, motivo da
-- perda, plano) continuam disparando no UPDATE da função.
--
-- Idempotente: create or replace + drop/create trigger. Gate: tests/invariants/mover-negocio-entre-funis.test.ts.

create or replace function public.fn_lead_funil_so_pela_troca_nomeada()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.pipeline_id is distinct from old.pipeline_id
     and coalesce(current_setting('deskcomm.mover_entre_funis', true), '') is distinct from new.id::text
  then
    raise exception 'pipeline_immutable_use_clone: troca de funil só por public.fn_mover_negocio_para_outro_funil.'
      using errcode = 'PT422';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_lead_funil_so_pela_troca_nomeada() from public, anon, authenticated;

do $hb_1013_trava_do_funil$
begin
  -- Só cria se não existir: drop+create a cada aplicação do baseline pegaria lock exclusivo em
  -- crm_leads sem necessidade (o corpo da função acima já é atualizado pelo create or replace).
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_lead_funil_so_pela_troca_nomeada'
       and tgrelid = 'public.crm_leads'::regclass
       and not tgisinternal
  ) then
    perform set_config('lock_timeout', '3s', true);
    create trigger trg_lead_funil_so_pela_troca_nomeada
      before update of pipeline_id on public.crm_leads
      for each row execute function public.fn_lead_funil_so_pela_troca_nomeada();
  end if;
end
$hb_1013_trava_do_funil$;

create or replace function public.fn_mover_negocio_para_outro_funil(
  p_organization_id uuid,
  p_lead_id uuid,
  p_stage_id uuid,
  p_position_in_stage numeric default null,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lead_funil uuid;
  v_lead_etapa uuid;
  v_lead_atualizado timestamptz;
  v_etapa_funil uuid;
  v_etapa_arquivada boolean;
  v_funil_arquivado boolean;
  v_posicao numeric;
  v_antes text;
begin
  if p_organization_id is null or p_lead_id is null or p_stage_id is null then
    raise exception 'Organização, negócio e etapa são obrigatórios.' using errcode = 'PT422';
  end if;

  -- O negócio é da organização informada por quem chama (a inscrição da automação, o ctx da rota),
  -- nunca do corpo. FOR UPDATE: duas trocas simultâneas do mesmo negócio entram em fila.
  select l.pipeline_id, l.stage_id, l.updated_at
    into v_lead_funil, v_lead_etapa, v_lead_atualizado
    from public.crm_leads l
   where l.id = p_lead_id
     and l.organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'Negócio não encontrado.' using errcode = 'PT404';
  end if;

  -- Etapa E funil de destino da MESMA organização. Erro genérico: não diz se o id existe noutra.
  select s.pipeline_id, s.is_archived, p.is_archived
    into v_etapa_funil, v_etapa_arquivada, v_funil_arquivado
    from public.crm_stages s
    join public.crm_pipelines p
      on p.id = s.pipeline_id
     and p.organization_id = p_organization_id
   where s.id = p_stage_id
     and s.organization_id = p_organization_id;
  if not found then
    raise exception 'Etapa não encontrada.' using errcode = 'PT404';
  end if;
  if v_etapa_arquivada or v_funil_arquivado then
    raise exception 'Etapa ou funil de destino arquivado.' using errcode = 'PT422';
  end if;
  if v_etapa_funil = v_lead_funil then
    raise exception 'Etapa do mesmo funil: use a troca de etapa.' using errcode = 'PT422';
  end if;
  if p_expected_updated_at is not null and v_lead_atualizado is distinct from p_expected_updated_at then
    raise exception 'Negócio foi modificado concorrentemente.' using errcode = 'PT409';
  end if;

  -- Sem posição: a entrada vai para o TOPO da etapa (MIN - 1000; 1000 na etapa vazia), a mesma
  -- régua de lib/kanban/entrada-na-etapa.ts.
  v_posicao := p_position_in_stage;
  if v_posicao is null then
    select min(l.position_in_stage) - 1000
      into v_posicao
      from public.crm_leads l
     where l.organization_id = p_organization_id
       and l.stage_id = p_stage_id;
    v_posicao := coalesce(v_posicao, 1000);
  end if;

  -- A chave libera a trava SÓ para este negócio e SÓ nesta transação.
  v_antes := current_setting('deskcomm.mover_entre_funis', true);
  perform set_config('deskcomm.mover_entre_funis', p_lead_id::text, true);

  update public.crm_leads l
     set pipeline_id       = v_etapa_funil,
         stage_id          = p_stage_id,
         position_in_stage = v_posicao,
         updated_at        = now()
   where l.id = p_lead_id
     and l.organization_id = p_organization_id;

  perform set_config('deskcomm.mover_entre_funis', coalesce(v_antes, ''), true);

  return jsonb_build_object(
    'lead_id', p_lead_id,
    'from_pipeline_id', v_lead_funil,
    'from_stage_id', v_lead_etapa,
    'to_pipeline_id', v_etapa_funil,
    'to_stage_id', p_stage_id,
    'position_in_stage', v_posicao
  );
end;
$$;

revoke execute on function public.fn_mover_negocio_para_outro_funil(uuid, uuid, uuid, numeric, timestamptz)
  from public, anon, authenticated;
grant execute on function public.fn_mover_negocio_para_outro_funil(uuid, uuid, uuid, numeric, timestamptz)
  to service_role;

comment on function public.fn_mover_negocio_para_outro_funil(uuid, uuid, uuid, numeric, timestamptz) is
  'Migration 1013 (fork Hiperbold): o ÚNICO caminho que troca crm_leads.pipeline_id. Leva o MESMO negócio (id, contato, responsável, histórico e custom_fields intactos) para uma etapa de outro funil da mesma organização. Só service_role; quem chama é moverParaOutroFunilHandler (app/api/v1/leads/_handler.ts), que emite lead.stage_changed, a atividade e a auditoria.';
