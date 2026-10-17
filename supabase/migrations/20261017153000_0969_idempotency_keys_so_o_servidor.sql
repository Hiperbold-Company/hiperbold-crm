-- 0969, idempotency_keys: só o servidor lê e escreve (fork Hiperbold, correção de segurança, achado de média gravidade da
-- auditoria da fase 2 da API, 17/10/2026).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito. O recibo de idempotência (public.idempotency_keys.response_body) guarda, por 24 h, a RESPOSTA do POST de
-- criação: o path_token da URL de captação de uma fonte de contatos, o prompt de sistema de um agente de IA, e o que
-- mais a rota devolver. A policy idempotency_tenant_select deixava QUALQUER membro da organização — inclusive o
-- Visualizador — ler a tabela inteira pela REST com o próprio JWT (select * from idempotency_keys), e o papel
-- authenticated tinha GRANT ALL. O Visualizador não pode abrir a tela de fontes de captação nem a de agentes, mas lia
-- o que elas devolveram.
--
-- A correção, em duas camadas (mesmo desenho da 0962):
--   a) privilégio: anon e authenticated perdem TODOS os privilégios na tabela. Quem reserva, lê e fecha o recibo é o
--      servidor (service_role), com a organização já resolvida da sessão/da linha do token
--      (lib/api/idempotency.ts recebe o cliente de servidor em todos os chamadores). Função security definer segue
--      usando a tabela como dona. O revoke é explícito porque o default ACL do Supabase concede tudo a cada tabela
--      nova e o GRANT enumerado do dump só acrescenta.
--   b) policy, para o dia em que algum grant voltar (restore, ferramenta): as quatro policies de tenant passam a
--      recusar tudo — o recibo não é dado de tenant, é estado do servidor.
--
-- A policy RESTRICTIVE idempotency_platform_creation_server_only (0219) fica como está.
--
-- Reaplicável: revoke é declarativo; as policies são trocadas com alter policy (atômico, sem janela sem policy) e só se
-- existirem. Sem função nova: nada a revogar de PUBLIC/anon.

set lock_timeout = '3s';

revoke all on public.idempotency_keys from public, anon, authenticated;

do $idempotency_keys_so_o_servidor$
begin
 if exists (select 1 from pg_policy where polname = 'idempotency_tenant_select' and polrelid = 'public.idempotency_keys'::regclass) then
  alter policy idempotency_tenant_select on public.idempotency_keys using (false);
 end if;
 if exists (select 1 from pg_policy where polname = 'idempotency_tenant_insert' and polrelid = 'public.idempotency_keys'::regclass) then
  alter policy idempotency_tenant_insert on public.idempotency_keys with check (false);
 end if;
 if exists (select 1 from pg_policy where polname = 'idempotency_tenant_update' and polrelid = 'public.idempotency_keys'::regclass) then
  alter policy idempotency_tenant_update on public.idempotency_keys using (false) with check (false);
 end if;
 if exists (select 1 from pg_policy where polname = 'idempotency_tenant_delete' and polrelid = 'public.idempotency_keys'::regclass) then
  alter policy idempotency_tenant_delete on public.idempotency_keys using (false);
 end if;
end
$idempotency_keys_so_o_servidor$;

reset lock_timeout;
