-- ---- grants por coluna reaplicados no fim (migration 0998, fork Hiperbold) ----
-- 0967 (contacts sem cpf_hash/cpf_encrypted, D-216) e 0948 (tokens de webhook, D-128) dão grant
-- coluna a coluna com a lista do catálogo NO PONTO em que o bloco roda. O merge do upstream de
-- 04/11/2026 acrescentou colunas DEPOIS desses blocos (contacts.ai_opt_out e contact_type;
-- channel_sessions.meta_social_page_id, zernio_*, meta_webhook_override_*...). Na instalação nova
-- (install.sh, banco do e2e) elas nasciam sem grant e todo SELECT do usuário que as pedia caía em
-- "permission denied for table contacts" (500 em criar e listar contatos, Inbox vazia). O update.sh
-- não via o defeito porque a segunda aplicação já encontrava as colunas. Este bloco fica no fim do
-- arquivo para cobrir toda coluna criada antes dele; a cerca
-- tests/unit/grants-por-coluna-depois-da-ultima-coluna.test.ts reprova coluna nova depois dele.
do $hb_0998_grants_por_coluna$
declare
  alvo record;
  v_colunas text;
begin
  perform set_config('lock_timeout', '3s', true);

  select string_agg(format('%I', a.attname), ', ' order by a.attnum)
    into v_colunas
    from pg_attribute a
   where a.attrelid = 'public.contacts'::regclass
     and a.attnum > 0
     and not a.attisdropped
     and a.attname not in ('cpf_hash', 'cpf_encrypted');
  revoke select, insert, update on table public.contacts from anon, authenticated;
  execute format('grant select (%s) on table public.contacts to anon, authenticated', v_colunas);
  execute format('grant insert (%s) on table public.contacts to anon, authenticated', v_colunas);
  execute format('grant update (%s) on table public.contacts to anon, authenticated', v_colunas);

  for alvo in
    select * from (values
      ('channel_sessions', 'webhook_path_token'),
      ('webhook_sources', 'path_token'),
      ('tenant_integrations', 'webhook_path_token')
    ) as v(tabela, coluna)
  loop
    select string_agg(format('%I', a.attname), ', ' order by a.attnum)
      into v_colunas
      from pg_attribute a
     where a.attrelid = format('public.%I', alvo.tabela)::regclass
       and a.attnum > 0
       and not a.attisdropped
       and a.attname <> alvo.coluna;
    execute format('revoke select on public.%I from authenticated, anon', alvo.tabela);
    execute format('grant select (%s) on public.%I to authenticated', v_colunas, alvo.tabela);
  end loop;
end
$hb_0998_grants_por_coluna$;
