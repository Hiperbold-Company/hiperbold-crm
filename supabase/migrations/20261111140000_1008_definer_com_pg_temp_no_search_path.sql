-- 1008, toda função security definer de `public` termina o search_path com pg_temp (D-223, fork Hiperbold).
--
-- O defeito. Sem `pg_temp` escrito no search_path, o Postgres procura o schema temporário da sessão ANTES
-- de todos os outros para tabela, view e tipo. Quem chama uma definer pode criar uma tabela temporária com o
-- nome de uma tabela que a função lê sem schema e fazer a função, que roda com o poder do dono, ler o dado
-- dele. Escrever `pg_temp` no fim do search_path põe o schema temporário por último. Medido num baseline
-- fresco em 11/11/2026: 202 das 436 definer de `public` sem `pg_temp` (164 com `public`, 33 com o caminho
-- vazio, 5 com outras listas).
--
-- A correção. Uma varredura em pg_proc: para cada definer de `public` que não pertence a extensão,
--  - search_path sem pg_temp: `alter routine ... set search_path = <o que já tinha>, pg_temp`;
--  - search_path vazio (`""`): `set search_path = pg_temp` (o vazio já não achava nada sem schema);
--  - sem search_path nenhum: `set search_path = public, pg_temp`.
-- Só o atributo muda: o corpo, os grants e o dono ficam como estão. Quem já tem pg_temp não é tocado, então
-- reaplicar não faz nada. Uma subtransação por função: a que o papel atual não pode alterar fica com aviso,
-- sem derrubar as outras.
--
-- ⚠️ POSIÇÃO. `create or replace function` com `set search_path = public` reescreve o atributo e tira o
-- pg_temp de novo. No baseline este bloco é o ÚLTIMO do arquivo, e o update.sh o reaplica inteiro: tudo que
-- vier antes dele é curado no mesmo run. Apêndice novo entra ANTES deste bloco (ou repete a varredura).
-- Função nova deve nascer já com `set search_path = public, pg_temp`.
--
-- Gate: tests/invariants/definer-com-pg-temp-e-escrita-de-negocios.test.ts.

do $hb_1008_definer_pg_temp$
declare
 f record;
 v_sp text;
 v_novo text;
 v_curadas integer := 0;
begin
 perform set_config('lock_timeout', '3s', true);
 for f in
  select format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) as assinatura,
         (select substr(c, length('search_path=') + 1)
            from unnest(coalesce(p.proconfig, '{}'::text[])) as c
           where c like 'search_path=%') as sp
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and p.prokind in ('f', 'p')
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
   order by p.oid
 loop
  v_sp := f.sp;
  if v_sp is not null and exists (
       select 1 from unnest(string_to_array(v_sp, ',')) as e
        where lower(btrim(btrim(e), '"')) = 'pg_temp') then
   continue;
  end if;
  v_novo := case
              when v_sp is null then 'public, pg_temp'
              when btrim(v_sp) in ('', '""') then 'pg_temp'
              else v_sp || ', pg_temp'
            end;
  begin
   execute format('alter routine %s set search_path = %s', f.assinatura, v_novo);
   v_curadas := v_curadas + 1;
  exception when insufficient_privilege or lock_not_available then
   raise warning '1008: % ficou sem pg_temp (%)', f.assinatura, sqlerrm;
  end;
 end loop;
 raise notice '1008: % função(ões) security definer ganharam pg_temp no search_path', v_curadas;
end
$hb_1008_definer_pg_temp$;
