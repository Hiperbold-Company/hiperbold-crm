-- 1006, a sessão sem o segundo fator também não LÊ o dado da empresa (D-092, 3a parte) (fork Hiperbold).
--
-- O defeito. A 0918, a 0949 e a 0950 fecharam a ESCRITA de 28 tabelas para a sessão aal1 de quem TEM
-- fator TOTP verificado, mas a leitura seguia livre. Com a senha de um admin com TOTP e a chave pública do
-- projeto (vai para o browser), um token aal1 tirado direto do GoTrue lia pelo PostgREST toda a Inbox,
-- contatos, negócios e o resto do dado de cliente da empresa, sem nunca passar pelo /login/mfa.
--
-- A correção. Uma política RESTRICTIVE `for all to authenticated`, chamada `sessao_com_prova_de_mfa`, em
-- toda tabela tenant-aware de `public` (RLS ligada, coluna `organization_id`, com ao menos uma política
-- permissiva), pela ponte `fn_session_mfa_proven_rls()` da 0918: sessão aal2, OU dispositivo confiável
-- ainda no prazo, OU o usuário não tem fator TOTP verificado (quem nunca cadastrou não é trancado fora).
-- `(select ...)` vira initplan: a pergunta roda uma vez por consulta, não uma vez por linha.
--
-- O que NÃO muda. service_role (o app e os workers, inclusive o bearer `dsk_`, que resolve no servidor) e
-- função security definer não são `authenticated`. anon não tem porta nessas tabelas. Quem não tem fator,
-- ou provou o fator, lê e grava como antes.
--
-- FICAM DE FORA, de propósito:
--  - `organizations` e `user_organizations`: é com a sessão aal1 que `loadAuthUser` monta as
--    organizações do usuário (user_organizations com o embed de organizations) e que o layout de /app
--    decide mandar a pessoa ao /login/mfa. Travadas, a pessoa com fator cairia em /get-started (sem
--    organização) em vez de ir ao desafio. A escrita delas já exige a prova (0918 e 0949).
--  - tabela só do servidor (RLS ligada e nenhuma política permissiva): `authenticated` já não alcança
--    nada, e o contrato dessas tabelas é ter zero políticas.
--  - tabela de módulo criada depois, pela função provisionadora (ADR-0002): só recebe a trava quando o
--    baseline for reaplicado (update.sh), como as travas de suporte.
--  - `platform_admins` e as tabelas por usuário sem `organization_id`: não são dado de empresa.
--
-- Reaplicável com o app no ar: uma política por tabela, criada só se não existir (sem drop policy, que
-- deixaria a tabela sem a trava no meio), lock_timeout curto e uma subtransação por tabela: a tabela
-- movimentada que não solta a trava a tempo fica para a próxima aplicação, com aviso, sem segurar as
-- outras. Sem função nova: nada a ver com a VARREDURA anon.

do $hb_1006_mfa_na_leitura$
declare
 r record;
begin
 perform set_config('lock_timeout', '3s', true);
 for r in
  select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and not c.relispartition
     and c.relrowsecurity
     and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
     and c.relname not in ('organizations', 'user_organizations')
     and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polpermissive)
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'sessao_com_prova_de_mfa')
   order by c.relname
 loop
  begin
   execute format(
    'create policy sessao_com_prova_de_mfa on public.%I as restrictive for all to authenticated '
    'using ((select public.fn_session_mfa_proven_rls())) with check ((select public.fn_session_mfa_proven_rls()))',
    r.relname);
  exception when lock_not_available then
   raise warning '1006: % ocupada, a trava de MFA na leitura fica para a próxima aplicação', r.relname;
  end;
 end loop;
end
$hb_1006_mfa_na_leitura$;
