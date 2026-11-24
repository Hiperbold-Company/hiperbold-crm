-- manifest: **A moeda do campo de moeda é POR CAMPO e chega às telas (fork Hiperbold, decisão do dono do produto em 24/11/2026).** `custom_field_definitions.config.moeda` (`BRL`|`USD`|`EUR`, validada na aplicação; ausente = moeda da organização) passa a ser copiada para o item de `crm_pipelines.settings.fields` por `fn_campos_personalizados_projetados` e por `fn_adotar_campos_legados_da_organizacao` (`c_props`), e os funis de quem já tem `config.moeda` são reprojetados. Mesmos grants (service_role); sem tabela nem coluna nova. Espelho no apêndice do `supabase/baseline.sql`; prova em `tests/invariants/moeda-do-campo-na-projecao.test.ts`.
--
-- 1022: a tela de Campos Personalizados grava `config.moeda`, mas as fichas leem `settings.fields`,
-- que o banco deriva e que só copiava seis chaves do `config`. Sem `moeda` nessa lista o campo em
-- dólar aparecia na moeda da organização.

create or replace function public.fn_campos_personalizados_projetados(p_org uuid, p_obrigatorios jsonb)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(item order by ordem_pos, ordem_criado, ordem_chave), '[]'::jsonb)
    from (
      select d.position as ordem_pos,
             d.created_at as ordem_criado,
             d.key as ordem_chave,
             (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                from jsonb_each(
                       (select coalesce(jsonb_object_agg(c.key, c.value), '{}'::jsonb)
                          from jsonb_each(d.config) c
                         where c.key in ('options', 'mostrar_quando', 'padrao', 'mensagem_padrao',
                                         'allow_new', 'multiple', 'moeda'))
                       || jsonb_build_object(
                            'key', d.key,
                            'label', d.label,
                            'type', d.type,
                            'required', case when d.obrigatorio then true end,
                            'grupo', d.grupo,
                            'escopo', case when d.entidade = 'contato' then 'contato' end,
                            'descricao', d.descricao,
                            'publico', case when not d.publico then false end,
                            'sempre_visivel', case when d.sempre_visivel then true end,
                            'exibir_no_perfil', case when d.exibir_no_perfil then true end,
                            'dica_de_ajuda', d.dica_de_ajuda,
                            'obrigatorio_em',
                              case when jsonb_typeof(p_obrigatorios) = 'object'
                                    and jsonb_typeof(p_obrigatorios -> d.key) = 'object'
                                   then p_obrigatorios -> d.key end
                          )) e
               where e.value <> 'null'::jsonb) as item
        from public.custom_field_definitions d
       where d.organization_id = p_org
    ) projetados;
$$;

revoke execute on function public.fn_campos_personalizados_projetados(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_campos_personalizados_projetados(uuid, jsonb) to service_role;

create or replace function public.fn_adotar_campos_legados_da_organizacao(p_org uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_tipos constant text[] := array['text', 'textarea', 'number', 'currency', 'date', 'select', 'multiselect',
                                   'searchable_select', 'boolean', 'email', 'phone', 'url', 'file'];
  c_props constant text[] := array['options', 'mostrar_quando', 'padrao', 'mensagem_padrao', 'allow_new', 'multiple', 'moeda'];
  r record;
  v_ent text;
  v_outra text;
  v_lk text;
  v_chave text;
  v_cand text;
  v_i integer;
  v_grupo jsonb;
  v_venc jsonb;
  v_dif jsonb;
  v_canon jsonb := '{}'::jsonb;      -- lower(chave) -> { entidade: {chave, original, item, funil, funil_nome, renomeado} }
  v_ordem jsonb := '[]'::jsonb;      -- [[lower(chave), entidade], ...] na ordem em que apareceram
  v_obrig jsonb := '{}'::jsonb;      -- funil -> { chave: obrigatorio_em }
  v_conflitos jsonb := '[]'::jsonb;
  v_todas jsonb;
  v_usadas jsonb := '{}'::jsonb;
  v_par jsonb;
  v_n integer;
  v_def jsonb;
  v_item jsonb;
  v_ins integer;
  v_inseridas integer := 0;
  v_restritas jsonb := '{}'::jsonb;  -- lower(chave) -> true quando QUALQUER ocorrência tem publico:false
begin
  if p_org is null then
    return 0;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hb_1015_campos:' || p_org::text, 0));
  if exists (select 1 from public.custom_field_definitions d where d.organization_id = p_org) then
    return 0;
  end if;
  perform set_config('hb.campos_adocao', p_org::text, true);

  -- Toda chave válida que já existe na organização: a chave distinta de uma entidade nunca pode
  -- cair em cima de outra que aparece mais adiante.
  select coalesce(jsonb_object_agg(k, true), '{}'::jsonb)
    into v_todas
    from (select distinct lower(f.item ->> 'key') as k
            from public.crm_pipelines p
           cross join lateral jsonb_array_elements(
                   case when jsonb_typeof(p.settings -> 'fields') = 'array' then p.settings -> 'fields'
                        else '[]'::jsonb end) as f(item)
           where p.organization_id = p_org
             and jsonb_typeof(f.item) = 'object'
             and coalesce(f.item ->> 'key', '') ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$') chaves;

  for r in
    select p.id as funil, p.name as funil_nome, f.item, f.ord
      from public.crm_pipelines p
     cross join lateral jsonb_array_elements(
             case when jsonb_typeof(p.settings -> 'fields') = 'array' then p.settings -> 'fields'
                  else '[]'::jsonb end) with ordinality as f(item, ord)
     where p.organization_id = p_org
       and jsonb_typeof(p.settings) = 'object'
     order by p.created_at, p.id, f.ord
  loop
    continue when jsonb_typeof(r.item) is distinct from 'object'
      or coalesce(r.item ->> 'key', '') !~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'
      or btrim(coalesce(r.item ->> 'label', '')) = ''
      or not (coalesce(r.item ->> 'type', '') = any (c_tipos));

    v_ent := case when r.item ->> 'escopo' = 'contato' then 'contato' else 'negocio' end;
    v_outra := case when v_ent = 'contato' then 'negocio' else 'contato' end;
    v_lk := lower(r.item ->> 'key');
    -- Restrito vence: basta UMA ocorrência da chave (sem diferenciar maiúsculas, em qualquer funil
    -- e em qualquer entidade) com `publico:false` para toda definição dessa chave nascer restrita.
    -- Herdar do funil mais antigo deixava à vista da IA e do cliente um valor que outro funil marcou
    -- como só do admin — inclusive o valor antigo que fica na chave original depois da cópia.
    if r.item -> 'publico' = 'false'::jsonb then
      v_restritas := v_restritas || jsonb_build_object(v_lk, true);
    end if;
    v_grupo := coalesce(v_canon -> v_lk, '{}'::jsonb);
    v_venc := v_grupo -> v_ent;

    if v_venc is null then
      if v_grupo ? v_outra then
        -- A mesma chave já é da OUTRA entidade: chave própria, nunca fusão.
        v_i := 1;
        loop
          v_cand := case when v_i = 1 then left(r.item ->> 'key', 31) || '_' || v_ent
                         else left(r.item ->> 'key', 31 - length(v_i::text)) || '_' || v_ent || v_i::text end;
          exit when not (v_todas ? lower(v_cand)) and not (v_usadas ? lower(v_cand));
          v_i := v_i + 1;
        end loop;
        v_chave := v_cand;
        v_usadas := v_usadas || jsonb_build_object(lower(v_chave), true);
        v_conflitos := v_conflitos || jsonb_build_array(jsonb_build_object(
          'chave', v_grupo -> v_outra ->> 'chave',
          'chave_nova', v_chave,
          'entidade_nova', v_ent,
          'funis', jsonb_build_array(
            jsonb_build_object('id', v_grupo -> v_outra ->> 'funil', 'nome', v_grupo -> v_outra ->> 'funil_nome'),
            jsonb_build_object('id', r.funil, 'nome', r.funil_nome)),
          'diferenca', jsonb_build_array('entidade'),
          'resolucao', 'chave_distinta_com_valores_copiados'));
      else
        v_chave := r.item ->> 'key';
      end if;
      v_venc := jsonb_build_object('chave', v_chave, 'original', r.item ->> 'key', 'item', r.item,
                                   'funil', r.funil, 'funil_nome', r.funil_nome,
                                   'renomeado', v_chave is distinct from r.item ->> 'key');
      v_canon := v_canon || jsonb_build_object(v_lk, v_grupo || jsonb_build_object(v_ent, v_venc));
      v_ordem := v_ordem || jsonb_build_array(jsonb_build_array(v_lk, v_ent));
    else
      v_dif := '[]'::jsonb;
      if (r.item ->> 'type') is distinct from (v_venc -> 'item' ->> 'type') then
        v_dif := v_dif || '["tipo"]'::jsonb;
      end if;
      if (r.item -> 'options') is distinct from (v_venc -> 'item' -> 'options') then
        v_dif := v_dif || '["opcoes"]'::jsonb;
      end if;
      if coalesce(r.item -> 'required' = 'true'::jsonb, false)
         is distinct from coalesce(v_venc -> 'item' -> 'required' = 'true'::jsonb, false) then
        v_dif := v_dif || '["obrigatorio"]'::jsonb;
      end if;
      if (r.item ->> 'key') is distinct from (v_venc ->> 'original') then
        v_dif := v_dif || '["maiusculas"]'::jsonb;
      end if;
      -- `publico` NÃO segue o funil mais antigo (ver `v_restritas`): a diferença fica gravada.
      if coalesce(r.item -> 'publico' <> 'false'::jsonb, true)
         is distinct from coalesce(v_venc -> 'item' -> 'publico' <> 'false'::jsonb, true) then
        v_dif := v_dif || '["publico"]'::jsonb;
      end if;
      if jsonb_array_length(v_dif) > 0 then
        v_conflitos := v_conflitos || jsonb_build_array(jsonb_build_object(
          'chave', v_venc ->> 'chave',
          'chave_no_funil', r.item ->> 'key',
          'entidade', v_ent,
          'funis', jsonb_build_array(
            jsonb_build_object('id', v_venc ->> 'funil', 'nome', v_venc ->> 'funil_nome'),
            jsonb_build_object('id', r.funil, 'nome', r.funil_nome)),
          'diferenca', v_dif,
          'resolucao', 'vale_o_funil_mais_antigo'));
      end if;
      v_chave := v_venc ->> 'chave';
    end if;

    -- Chave final diferente da do funil (chave própria da outra entidade, OU a mesma chave com
    -- maiúsculas diferentes que caiu na definição do funil mais antigo): COPIA os valores para a
    -- chave final (a antiga fica onde estava). Só olhar `renomeado` deixava `Cidade` do segundo
    -- funil fora da definição `cidade`.
    if v_chave is distinct from (r.item ->> 'key') then
      if v_ent = 'contato' then
        update public.contacts c
           set custom_fields = c.custom_fields || jsonb_build_object(v_chave, c.custom_fields -> (r.item ->> 'key'))
         where c.organization_id = p_org
           and c.is_anonymized is not true
           and jsonb_typeof(c.custom_fields) = 'object'
           and c.custom_fields ? (r.item ->> 'key')
           and not c.custom_fields ? v_chave;
      else
        update public.crm_leads l
           set custom_fields = l.custom_fields || jsonb_build_object(v_chave, l.custom_fields -> (r.item ->> 'key'))
         where l.organization_id = p_org
           and l.pipeline_id = r.funil
           and jsonb_typeof(l.custom_fields) = 'object'
           and l.custom_fields ? (r.item ->> 'key')
           and not l.custom_fields ? v_chave;
      end if;
    end if;

    -- A obrigatoriedade do funil, na chave final; a primeira ocorrência no funil vence.
    if jsonb_typeof(r.item -> 'obrigatorio_em') = 'object'
       and not (coalesce(v_obrig -> (r.funil::text), '{}'::jsonb) ? v_chave) then
      v_obrig := v_obrig || jsonb_build_object(r.funil::text,
        coalesce(v_obrig -> (r.funil::text), '{}'::jsonb) || jsonb_build_object(v_chave, r.item -> 'obrigatorio_em'));
    end if;
  end loop;

  if jsonb_array_length(v_ordem) = 0 then
    perform set_config('hb.campos_adocao', '', true);
    return 0;
  end if;

  -- (1) rollback e obrigatoriedade, ANTES de a projeção reescrever `fields`. A regra que já estava
  -- em `campos_obrigatorios` vence a que vem do item.
  update public.crm_pipelines p
     set settings = p.settings
         || case when p.settings ? 'campos_legados' then '{}'::jsonb
                 else jsonb_build_object('campos_legados', p.settings -> 'fields') end
         || jsonb_build_object('campos_obrigatorios',
              coalesce(v_obrig -> (p.id::text), '{}'::jsonb)
              || case when jsonb_typeof(p.settings -> 'campos_obrigatorios') = 'object'
                      then p.settings -> 'campos_obrigatorios' else '{}'::jsonb end)
   where p.organization_id = p_org
     and jsonb_typeof(p.settings) = 'object'
     and jsonb_typeof(p.settings -> 'fields') = 'array'
     and jsonb_array_length(p.settings -> 'fields') > 0;

  -- (2) uma definição por chave final. A projeção corre pelo gatilho AFTER, linha a linha.
  for v_par, v_n in
    select x.e, x.o::integer from jsonb_array_elements(v_ordem) with ordinality as x(e, o)
  loop
    v_def := v_canon -> (v_par ->> 0) -> (v_par ->> 1);
    v_item := v_def -> 'item';
    insert into public.custom_field_definitions
      (organization_id, entidade, key, label, type, obrigatorio, grupo, descricao, publico, sempre_visivel,
       exibir_no_perfil, dica_de_ajuda, config, position)
    values (
      p_org,
      v_par ->> 1,
      v_def ->> 'chave',
      left(btrim(v_item ->> 'label'), 80),
      v_item ->> 'type',
      coalesce(v_item -> 'required' = 'true'::jsonb, false),
      case when v_item ->> 'grupo' in ('dados', 'rastreamento') then v_item ->> 'grupo' end,
      case when jsonb_typeof(v_item -> 'descricao') = 'string' then nullif(left(v_item ->> 'descricao', 500), '') end,
      coalesce(v_item -> 'publico' <> 'false'::jsonb, true) and not (v_restritas ? (v_par ->> 0)),
      coalesce(v_item -> 'sempre_visivel' = 'true'::jsonb, false),
      coalesce(v_item -> 'exibir_no_perfil' = 'true'::jsonb, false),
      case when jsonb_typeof(v_item -> 'dica_de_ajuda') = 'string' then nullif(left(v_item ->> 'dica_de_ajuda', 300), '') end,
      (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
         from jsonb_each(v_item) e
        where e.key = any (c_props) and e.value <> 'null'::jsonb),
      v_n * 1000
    )
    on conflict do nothing;
    get diagnostics v_ins = row_count;
    v_inseridas := v_inseridas + v_ins;
  end loop;

  -- (3) o conflito fica GRAVADO na organização (a tela e o suporte o leem depois).
  if jsonb_array_length(v_conflitos) > 0 then
    update public.organizations o
       set settings = coalesce(o.settings, '{}'::jsonb)
           || jsonb_build_object('campos_conflitos',
                case when jsonb_typeof(o.settings -> 'campos_conflitos') = 'array'
                     then o.settings -> 'campos_conflitos' else '[]'::jsonb end || v_conflitos)
     where o.id = p_org
       and jsonb_typeof(coalesce(o.settings, '{}'::jsonb)) = 'object';
    raise notice '1015: % conflito(s) de campo personalizado na organização % (gravados em organizations.settings.campos_conflitos)',
      jsonb_array_length(v_conflitos), p_org;
  end if;

  perform set_config('hb.campos_adocao', '', true);
  return v_inseridas;
end;
$$;

revoke execute on function public.fn_adotar_campos_legados_da_organizacao(uuid) from public, anon, authenticated;
grant execute on function public.fn_adotar_campos_legados_da_organizacao(uuid) to service_role;

-- Reprojeta os funis das organizações que JÁ têm um campo com `config.moeda` (hoje nenhuma: a chave
-- ainda não era projetada). Idempotente: a projeção é função pura das definições, reaplicar grava o
-- mesmo `fields`.
update public.crm_pipelines p
   set settings = jsonb_set(
         p.settings,
         '{fields}',
         public.fn_campos_personalizados_projetados(p.organization_id, p.settings -> 'campos_obrigatorios')
       )
 where jsonb_typeof(p.settings) = 'object'
   and exists (select 1 from public.custom_field_definitions d
                where d.organization_id = p.organization_id and d.config ? 'moeda');
