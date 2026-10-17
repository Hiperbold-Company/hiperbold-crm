-- 0961, batimentos dos serviços de fundo (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Pedido do dono do produto (17/10/2026): monitoramento externo (Uptime Kuma) do worker e do scheduler. Os dois
-- rodam fora do processo web e nenhuma URL pública diz se estão vivos; o /api/v1/health só enxerga Supabase,
-- Redis e WAHA. Cada serviço passa a gravar um batimento, e duas rotas públicas só de leitura
-- (/api/v1/health/worker e /api/v1/health/scheduler) respondem 200 ou 503 conforme a idade do último batimento.
--
-- O que esta migration faz: a tabela public.sistema_batimentos, uma linha por serviço ('worker', 'scheduler'),
-- com o instante do último batimento, a versão e um detalhe livre. Não é tabela de organização: não guarda dado
-- de cliente nem segredo. RLS ligada SEM policy e nenhum privilégio para anon e authenticated: só o servidor
-- (service_role) lê e escreve. O worker grava pelo banco direto (dono da tabela, ou o papel agent_worker quando a
-- instalação o usa) e o app grava pelo service_role. Sem delete nem truncate para ninguém além do dono.
--
-- Sem função: a escrita é um upsert por chave primária, então não há o que revogar de PUBLIC/anon.
--
-- Reaplicável: create table if not exists e revoke/grant declarativos; transação única do runner fecha a janela
-- em que a tabela teria o ACL padrão do Supabase.

set lock_timeout = '3s';

create table if not exists public.sistema_batimentos (
  servico text primary key,
  ultimo_em timestamptz not null,
  versao text,
  detalhe jsonb not null default '{}'::jsonb,
  constraint sistema_batimentos_servico_valido check (servico in ('worker', 'scheduler'))
);

comment on table public.sistema_batimentos is
  '0961: o último batimento de cada serviço de fundo (worker e scheduler), lido por /api/v1/health/worker e /api/v1/health/scheduler para o monitor externo. O worker bate a cada ~30 s amarrado ao laço principal da fila (laço travado deixa de bater); o scheduler bate quando o app recebe uma chamada de cron autorizada. Sem dado de organização nem segredo. Só service_role lê e escreve.';

alter table public.sistema_batimentos enable row level security;

-- As duas origens de grant: o default ACL do Supabase (tudo a anon/authenticated/service_role) e o do dono.
revoke all on public.sistema_batimentos from anon, authenticated, service_role;
grant select, insert, update on public.sistema_batimentos to service_role;

-- O worker fala com o banco por conexão direta (SUPABASE_DB_URL). Instalação que usa o papel agent_worker
-- (docs/deploy-selfhost) o recebe aqui: a tabela é nova e o grant "on all tables" do setup não a alcança.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'grant select, insert, update on public.sistema_batimentos to agent_worker';
  end if;
end $$;

reset lock_timeout;
