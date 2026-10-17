-- 0962, api_tokens: só o servidor escreve (fork Hiperbold, correção de segurança, auditoria de 17/10/2026).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito (dois achados de gravidade alta, mesma causa). A policy api_tokens_admin_only deixava gravar quem
-- fosse admin da organização OU qualquer linha de platform_admins (fn_is_platform_admin() ignora o escopo), e o
-- papel authenticated tinha GRANT ALL na tabela. Pela chave pública do projeto e o PostgREST, sem passar por
-- nenhuma rota do app:
--   1. um admin de plataforma com escopo support_readonly (só leitura) inseria um token com
--      scopes ['role:admin','mcp:write'] para QUALQUER organização e o usava nas rotas de administração por
--      bearer, que passaram a existir na fase 1 da API;
--   2. o admin de um tenant com TOTP cadastrado, em sessão aal1 (sem o segundo fator), inseria um token e agia
--      por ele sem nunca provar o fator, porque um token não tem sessão nem aal.
-- (A 0918 já barra o aal1 de quem tem fator na RLS, mas o desenho continuava dependendo de cada policy lembrar
-- da prova; o conserto abaixo tira a escrita do caminho do usuário de uma vez.)
--
-- A correção, em duas camadas:
--   a) privilégio: authenticated e anon perdem TODOS os privilégios em api_tokens, a leitura inclusive. Quem
--      emite, lista e revoga token é o servidor (service_role), depois de requireRole("admin") com a prova do
--      segundo fator, com a organização da sessão, created_by = quem está na sessão e o teto de papel nos
--      escopos (app/api/v1/settings/api-tokens). Função security definer segue lendo a tabela como dona.
--   b) policy, para o dia em que algum grant voltar (o default ACL do Supabase concede tudo a cada tabela
--      nova, e um restore ou uma ferramenta pode reintroduzir): api_tokens_admin_only perde o ramo de plataforma.
--      Ler exige ser admin da organização; escrever exige ser admin da organização E created_by = auth.uid(),
--      isto é, ninguém grava token em nome de outra pessoa.
--
-- As policies RESTRICTIVE de MFA da 0918 (api_tokens_mfa_*) ficam como estão.
--
-- Reaplicável: revoke é declarativo; a policy é trocada com alter policy (atômico, sem drop, sem janela sem
-- policy) e criada só se faltar. Sem função nova: nada a revogar de PUBLIC/anon.

set lock_timeout = '3s';

revoke all on public.api_tokens from public, anon, authenticated;

do $api_tokens_so_o_servidor$
begin
 if exists (select 1 from pg_policy where polname = 'api_tokens_admin_only' and polrelid = 'public.api_tokens'::regclass) then
  alter policy api_tokens_admin_only on public.api_tokens
   using (public.fn_role_at_least(organization_id, 'admin'))
   with check (public.fn_role_at_least(organization_id, 'admin') and created_by = (select auth.uid()));
 else
  create policy api_tokens_admin_only on public.api_tokens
   using (public.fn_role_at_least(organization_id, 'admin'))
   with check (public.fn_role_at_least(organization_id, 'admin') and created_by = (select auth.uid()));
 end if;
end
$api_tokens_so_o_servidor$;

reset lock_timeout;
