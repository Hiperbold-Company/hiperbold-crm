-- manifest: **"Nova etiqueta" acrescenta ao vocabulário de forma atômica (fork Hiperbold).** `fn_acrescentar_etiqueta_ao_vocabulario(p_org, p_nome, p_cor, p_teto)` trava a linha da organização, recusa duplicata (case-insensitive) e teto, e acrescenta a entrada em `organizations.settings.tags` num passo só; antes a rota lia a lista e a regravava inteira, e duas criações simultâneas perdiam uma. EXECUTE só service_role; sem tabela nem coluna nova. Espelho no apêndice do `supabase/baseline.sql`.
-- Cria função: entra ANTES da VARREDURA anon.

create or replace function public.fn_acrescentar_etiqueta_ao_vocabulario(
  p_org   uuid,
  p_nome  text,
  p_cor   text,
  p_teto  integer
) returns text
    language plpgsql
    volatile
    security definer
    set search_path to 'public', 'pg_temp'
as $$
declare
  v_settings jsonb;
  v_curadas  jsonb;
  v_nome     text := left(lower(btrim(coalesce(p_nome, ''))), 40);
  v_entrada  jsonb;
begin
  if p_org is null or v_nome = '' then
    raise exception 'etiqueta_argumento_invalido' using errcode = '22023';
  end if;
  if not public.fn_billing_e_servidor()
     and not public.fn_role_at_least(p_org, 'manager')
     and not public.fn_is_platform_admin()
  then
    raise exception 'etiqueta_sem_permissao' using errcode = '42501';
  end if;

  -- A linha fica travada até o fim da transação: dois "criar" se enfileiram aqui e o segundo
  -- parte da lista que o primeiro acabou de gravar.
  select coalesce(o.settings, '{}'::jsonb) into v_settings
    from public.organizations o
   where o.id = p_org
     for update;
  if not found then
    return 'organizacao_nao_encontrada';
  end if;

  v_curadas := case when jsonb_typeof(v_settings -> 'tags') = 'array' then v_settings -> 'tags' else '[]'::jsonb end;

  if exists (
    select 1
      from jsonb_array_elements(v_curadas) as e(v)
     where left(lower(btrim(case jsonb_typeof(e.v)
                              when 'string' then e.v #>> '{}'
                              when 'object' then coalesce(e.v ->> 'tag', '')
                              else '' end)), 40) = v_nome
  ) then
    return 'ja_existe';
  end if;
  if jsonb_array_length(v_curadas) >= coalesce(p_teto, 200) then
    return 'limite';
  end if;

  v_entrada := case when p_cor is null then jsonb_build_object('tag', v_nome)
                    else jsonb_build_object('tag', v_nome, 'cor', p_cor) end;
  update public.organizations o
     set settings = jsonb_set(v_settings, '{tags}', v_curadas || jsonb_build_array(v_entrada), true)
   where o.id = p_org;
  return 'criada';
end;
$$;

comment on function public.fn_acrescentar_etiqueta_ao_vocabulario(uuid, text, text, integer) is
  'Acrescenta UMA etiqueta ao vocabulário curado (organizations.settings.tags) com a linha travada: duas criações simultâneas não perdem nenhuma. Devolve criada | ja_existe | limite | organizacao_nao_encontrada. Servidor, manager da organização ou admin de plataforma; senão 42501.';

revoke execute on function public.fn_acrescentar_etiqueta_ao_vocabulario(uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.fn_acrescentar_etiqueta_ao_vocabulario(uuid, text, text, integer)
  to service_role;
