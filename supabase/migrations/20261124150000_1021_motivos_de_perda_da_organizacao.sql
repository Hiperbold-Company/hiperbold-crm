-- manifest: **Motivos de perda passam a ser da ORGANIZAÇÃO (fork Hiperbold, decisão do dono 24/11/2026).** Fonte única em `organizations.settings.lost_reasons` (texto ou `{label,categoria}`, até 50). `fn_fundir_motivos_de_perda_da_organizacao(org)` (só service_role, roda uma vez por organização: quem já tem a chave não é tocado) une as listas dos funis sem repetir rótulo (ignora maiúsculas/espaços), o funil mais antigo vence, e conflito de categoria e excedente de 50 vão para `organizations.settings.motivos_conflitos`; as listas dos funis ficam como legado. `fn_acrescentar_motivos_de_perda_da_organizacao(org, motivos)` (só service_role) acrescenta sem apagar (API de configuração do funil, MCP, Cold Call). `fn_validate_lost_reason_required` aceita canônico ∪ organização ∪ legado do funil e vira security definer (EXECUTE só service_role). Espelho no apêndice do `supabase/baseline.sql`; prova em `tests/invariants/motivos-de-perda-da-organizacao.test.ts`.
-- 1021 — MOTIVOS DE PERDA DA ORGANIZAÇÃO (fork Hiperbold, decisão do dono do produto em 24/11/2026).
--
-- ═══ Por quê ═══
--
-- Cada funil tinha a sua lista em `crm_pipelines.settings.lost_reasons`: quem tinha cinco funis
-- cadastrava "Sem orçamento" cinco vezes, e o relatório de perdas agrupava por cinco régua diferentes.
-- A partir daqui a lista é UMA, da organização: `organizations.settings.lost_reasons`, no MESMO
-- formato (texto puro ou `{label, categoria}`, até 50 itens).
--
-- ═══ O que este arquivo faz ═══
--
--  1. `fn_fundir_motivos_de_perda_da_organizacao(org)`: a FUSÃO, por organização (só service_role).
--     Une as listas de todos os funis (ordem: `created_at`, `id`, depois a ordem de cada lista), sem
--     repetir rótulo — a comparação ignora maiúsculas e espaços (`lower` + espaços colapsados). O
--     rótulo que fica é o do funil mais antigo, como estava gravado. Mesmo rótulo com categoria
--     diferente: vence o funil mais antigo e a diferença vai para
--     `organizations.settings.motivos_conflitos` (`tipo = 'categoria'`). Acima de 50, o excedente
--     vai para o mesmo lugar (`tipo = 'excedente'`): nada some.
--     RODA UMA VEZ por organização: a organização que já tem a chave `lost_reasons` (mesmo `[]`)
--     não é tocada. Sem isso, cada `update.sh` (que reaplica o baseline) traria de volta o motivo que
--     o administrador apagou da lista da empresa. As listas dos funis NÃO são apagadas: ficam como
--     legado aceito pelo gatilho (item 3) e como caminho de volta.
--  2. `fn_acrescentar_motivos_de_perda_da_organizacao(org, motivos)`: acrescenta à lista da
--     organização SEM apagar os outros (API de configuração do funil, MCP, Cold Call). Rótulo que já
--     existe (mesma comparação) não duplica; se o item traz categoria, ela substitui a gravada. Trava
--     a linha da organização. O que não cabe no teto de 50 volta em `nao_couberam`. Só service_role.
--  3. `fn_validate_lost_reason_required` aceita canônico ∪ lista da ORGANIZAÇÃO ∪ lista legada do
--     FUNIL (transição: negócio histórico e automação publicada com motivo do funil continuam
--     passando). Vira `security definer` (`search_path = public, pg_temp`): a sessão sem segundo
--     fator não lê `organizations` (1006), e o gatilho recusaria em silêncio o motivo da empresa.
--     EXECUTE revogado de public, anon e authenticated — gatilho dispara sem EXECUTE de quem escreve.
--
-- Idempotente: create or replace, revoke/grant e a fusão guardada pela presença da chave.
-- Gate: tests/invariants/motivos-de-perda-da-organizacao.test.ts.

set lock_timeout = '3s';

create or replace function public.fn_motivo_de_perda_normalizado(p_rotulo text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select lower(regexp_replace(btrim(coalesce(p_rotulo, '')), '\s+', ' ', 'g'));
$$;

revoke execute on function public.fn_motivo_de_perda_normalizado(text) from public, anon, authenticated;
grant execute on function public.fn_motivo_de_perda_normalizado(text) to service_role;

create or replace function public.fn_fundir_motivos_de_perda_da_organizacao(p_org uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb;
  v_lista jsonb := '[]'::jsonb;
  v_conflitos jsonb := '[]'::jsonb;
  v_vistos jsonb := '{}'::jsonb;   -- rótulo normalizado -> { idx, categoria }
  v_item record;
  v_rotulo text;
  v_categoria text;
  v_norm text;
  v_visto jsonb;
begin
  select coalesce(o.settings, '{}'::jsonb) into v_settings
    from public.organizations o
   where o.id = p_org
   for update;
  if not found or jsonb_typeof(v_settings) is distinct from 'object' then
    return 0;
  end if;
  -- Uma vez por organização: a chave presente (mesmo `[]`) é a decisão de quem administra.
  if v_settings ? 'lost_reasons' then
    return 0;
  end if;

  for v_item in
    select p.id as funil, p.name as nome, e.valor
      from public.crm_pipelines p
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(p.settings -> 'lost_reasons') = 'array'
             then p.settings -> 'lost_reasons' else '[]'::jsonb end
      ) with ordinality as e(valor, ordem)
     where p.organization_id = p_org
     order by p.created_at, p.id, e.ordem
  loop
    if jsonb_typeof(v_item.valor) = 'object' then
      v_rotulo := v_item.valor ->> 'label';
      v_categoria := nullif(btrim(coalesce(v_item.valor ->> 'categoria', '')), '');
    elsif jsonb_typeof(v_item.valor) = 'string' then
      v_rotulo := v_item.valor #>> '{}';
      v_categoria := null;
    else
      continue;
    end if;
    if v_rotulo is null or btrim(v_rotulo) = '' or length(btrim(v_rotulo)) > 80 then
      continue;
    end if;
    if v_categoria is not null and length(v_categoria) > 40 then
      v_categoria := null;
    end if;
    v_norm := public.fn_motivo_de_perda_normalizado(v_rotulo);
    v_visto := v_vistos -> v_norm;

    if v_visto is not null then
      if (v_visto ->> 'categoria') is distinct from v_categoria then
        v_conflitos := v_conflitos || jsonb_build_array(jsonb_build_object(
          'tipo', 'categoria',
          'motivo', v_visto ->> 'rotulo',
          'categoria_mantida', v_visto -> 'categoria',
          'categoria_descartada', to_jsonb(v_categoria),
          'funil_id', v_item.funil,
          'funil', v_item.nome));
      end if;
      continue;
    end if;

    if jsonb_array_length(v_lista) >= 50 then
      v_conflitos := v_conflitos || jsonb_build_array(jsonb_build_object(
        'tipo', 'excedente',
        'motivo', v_rotulo,
        'categoria', to_jsonb(v_categoria),
        'funil_id', v_item.funil,
        'funil', v_item.nome));
      -- Marca como visto: a mesma grafia em outro funil não vira um segundo excedente.
      v_vistos := v_vistos || jsonb_build_object(v_norm,
        jsonb_build_object('rotulo', v_rotulo, 'categoria', to_jsonb(v_categoria)));
      continue;
    end if;

    v_lista := v_lista || jsonb_build_array(
      case when v_categoria is null then to_jsonb(v_rotulo)
           else jsonb_build_object('label', v_rotulo, 'categoria', v_categoria) end);
    v_vistos := v_vistos || jsonb_build_object(v_norm,
      jsonb_build_object('rotulo', v_rotulo, 'categoria', to_jsonb(v_categoria)));
  end loop;

  update public.organizations o
     set settings = v_settings
         || jsonb_build_object('lost_reasons', v_lista)
         || case when jsonb_array_length(v_conflitos) > 0
                 then jsonb_build_object('motivos_conflitos',
                        case when jsonb_typeof(v_settings -> 'motivos_conflitos') = 'array'
                             then v_settings -> 'motivos_conflitos' else '[]'::jsonb end || v_conflitos)
                 else '{}'::jsonb end
   where o.id = p_org;

  if jsonb_array_length(v_conflitos) > 0 then
    raise notice '1021: % conflito(s) de motivo de perda na organização % (gravados em organizations.settings.motivos_conflitos)',
      jsonb_array_length(v_conflitos), p_org;
  end if;
  return jsonb_array_length(v_lista);
end;
$$;

revoke execute on function public.fn_fundir_motivos_de_perda_da_organizacao(uuid) from public, anon, authenticated;
grant execute on function public.fn_fundir_motivos_de_perda_da_organizacao(uuid) to service_role;

comment on function public.fn_fundir_motivos_de_perda_da_organizacao(uuid) is
  'Migration 1021 (fork Hiperbold): une as settings.lost_reasons dos funis em organizations.settings.lost_reasons, sem repetir rótulo (ignora maiúsculas/espaços), funil mais antigo vence, conflito de categoria e excedente de 50 em settings.motivos_conflitos. Roda uma vez: organização que já tem a chave lost_reasons não é tocada.';

create or replace function public.fn_acrescentar_motivos_de_perda_da_organizacao(p_org uuid, p_motivos jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb;
  v_lista jsonb;
  v_antes jsonb;
  v_nao_couberam jsonb := '[]'::jsonb;
  v_item jsonb;
  v_rotulo text;
  v_categoria text;
  v_norm text;
  v_idx int;
  v_achou int;
begin
  if p_org is null or jsonb_typeof(p_motivos) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'motivos_invalidos';
  end if;

  select coalesce(o.settings, '{}'::jsonb) into v_settings
    from public.organizations o
   where o.id = p_org
   for update;
  if not found then
    return null;
  end if;
  v_lista := case when jsonb_typeof(v_settings -> 'lost_reasons') = 'array'
                  then v_settings -> 'lost_reasons' else '[]'::jsonb end;
  v_antes := v_lista;

  for v_item in select e from jsonb_array_elements(p_motivos) as t(e) loop
    if jsonb_typeof(v_item) = 'object' then
      v_rotulo := btrim(coalesce(v_item ->> 'label', ''));
      v_categoria := nullif(btrim(coalesce(v_item ->> 'categoria', '')), '');
    elsif jsonb_typeof(v_item) = 'string' then
      v_rotulo := btrim(v_item #>> '{}');
      v_categoria := null;
    else
      continue;
    end if;
    if v_rotulo = '' or length(v_rotulo) > 80 or (v_categoria is not null and length(v_categoria) > 40) then
      raise exception using errcode = '22023', message = 'motivo_invalido';
    end if;
    v_norm := public.fn_motivo_de_perda_normalizado(v_rotulo);

    v_achou := null;
    select (e.ordem - 1)::int into v_achou
      from jsonb_array_elements(v_lista) with ordinality as e(valor, ordem)
     where public.fn_motivo_de_perda_normalizado(
             case when jsonb_typeof(e.valor) = 'object' then e.valor ->> 'label' else e.valor #>> '{}' end
           ) = v_norm
     limit 1;

    if v_achou is not null then
      -- Já existe: só a categoria informada substitui a gravada. O rótulo fica como estava.
      if v_categoria is not null then
        v_idx := v_achou;
        v_lista := jsonb_set(v_lista, array[v_idx::text], jsonb_build_object(
          'label',
          case when jsonb_typeof(v_lista -> v_idx) = 'object' then v_lista -> v_idx ->> 'label'
               else v_lista -> v_idx #>> '{}' end,
          'categoria', v_categoria));
      end if;
      continue;
    end if;

    if jsonb_array_length(v_lista) >= 50 then
      v_nao_couberam := v_nao_couberam || jsonb_build_array(v_item);
      continue;
    end if;
    v_lista := v_lista || jsonb_build_array(
      case when v_categoria is null then to_jsonb(v_rotulo)
           else jsonb_build_object('label', v_rotulo, 'categoria', v_categoria) end);
  end loop;

  if v_lista is distinct from v_antes or not (v_settings ? 'lost_reasons') then
    update public.organizations o
       set settings = coalesce(o.settings, '{}'::jsonb) || jsonb_build_object('lost_reasons', v_lista)
     where o.id = p_org;
  end if;

  return jsonb_build_object(
    'lista', v_lista,
    'mudou', v_lista is distinct from v_antes,
    'nao_couberam', v_nao_couberam);
end;
$$;

revoke execute on function public.fn_acrescentar_motivos_de_perda_da_organizacao(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_acrescentar_motivos_de_perda_da_organizacao(uuid, jsonb) to service_role;

comment on function public.fn_acrescentar_motivos_de_perda_da_organizacao(uuid, jsonb) is
  'Migration 1021 (fork Hiperbold): acrescenta motivos à organizations.settings.lost_reasons sem apagar os outros (rótulo repetido não duplica; categoria informada substitui). Teto de 50: o que não cabe volta em nao_couberam. Devolve {lista, mudou, nao_couberam}; null se a organização não existe. Só service_role.';

create or replace function public.fn_validate_lost_reason_required() returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_canonical text[] := array['requested_by_customer','price','no_response','product_unavailable',
                              'cancelled_by_store','cancelled_by_customer','payment_failed','other',
                              'moved_to_another_pipeline',
                              -- migration 0513 (#2049): quem respondeu PARAR. Conta como perda.
                              'opted_out_of_messages'];
  v_pipeline_extra text[];
  v_org_extra text[];
begin
  if new.status = 'lost' then
    if new.lost_reason is null or length(new.lost_reason) = 0 then
      raise exception 'lost_reason_required' using errcode = '22023';
    end if;

    if new.lost_reason = any (v_canonical) then
      return new;
    end if;

    -- 1021: a lista da ORGANIZAÇÃO é a fonte. `settings.lost_reasons` aceita texto puro E
    -- `{ label, categoria }` (#1537); o que se compara é o RÓTULO nos dois formatos.
    select coalesce(
      array(
        select case when jsonb_typeof(e) = 'object'
                    then nullif(e ->> 'label', '')
                    else nullif(e #>> '{}', '') end
          from jsonb_array_elements(
            case when jsonb_typeof(o.settings -> 'lost_reasons') = 'array'
                 then o.settings -> 'lost_reasons' else '[]'::jsonb end) as t(e)
      ), '{}'::text[]
    ) into v_org_extra
    from public.organizations o where o.id = new.organization_id;

    if new.lost_reason = any (coalesce(v_org_extra, '{}'::text[])) then
      return new;
    end if;

    -- Transição (1021): a lista legada do FUNIL continua aceita — negócio histórico e automação
    -- publicada com motivo do funil não quebram.
    select coalesce(
      array(
        select case when jsonb_typeof(e) = 'object'
                    then nullif(e ->> 'label', '')
                    else nullif(e #>> '{}', '') end
          from jsonb_array_elements(
            case when jsonb_typeof(settings -> 'lost_reasons') = 'array'
                 then settings -> 'lost_reasons' else '[]'::jsonb end) as t(e)
      ), '{}'::text[]
    ) into v_pipeline_extra
    from public.crm_pipelines where id = new.pipeline_id;

    if not (new.lost_reason = any (coalesce(v_pipeline_extra, '{}'::text[]))) then
      raise exception 'lost_reason_invalid: %', new.lost_reason using errcode = '22023';
    end if;
  end if;
  return new;
end$$;

revoke execute on function public.fn_validate_lost_reason_required() from public, anon, authenticated;
grant execute on function public.fn_validate_lost_reason_required() to service_role;

-- A FUSÃO de toda organização que ainda não tem a lista própria.
do $fusao$
declare
  v_org uuid;
begin
  for v_org in
    select o.id from public.organizations o
     where not (coalesce(o.settings, '{}'::jsonb) ? 'lost_reasons')
     order by o.created_at, o.id
  loop
    perform public.fn_fundir_motivos_de_perda_da_organizacao(v_org);
  end loop;
end
$fusao$;
