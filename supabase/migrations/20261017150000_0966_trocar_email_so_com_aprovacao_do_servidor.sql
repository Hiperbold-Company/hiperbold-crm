-- 0966, trocar o e-mail de uma conta só com aprovação do servidor (D-204, fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Contexto: ligar `mailer_autoconfirm = true` no Supabase faz o cadastro entrar sem confirmar o e-mail. O CRM tem
-- verificação própria (`app_metadata.email_verificado_em`, ver lib/auth/verificacao-email.ts), e uma conta só é dona do
-- endereço que a verificação do CRM (ou o Google) provou. Se o endereço de uma conta pudesse ser trocado pelo próprio
-- usuário, quem tem uma sessão (roubada, ou aberta por quem cadastrou o e-mail alheio) viraria dono de outro endereço
-- sem que o CRM soubesse: a verificação carimbada vale para o endereço ANTIGO.
--
-- Medido em 17/10/2026 no código do supabase/auth v2.196.0 (a versão que o produto fixa), `internal/api/user.go`:
-- `PUT /auth/v1/user {email}` de usuário permanente NÃO troca na hora com autoconfirm ligado (só o usuário anônimo troca
-- com confirmação automática); o GoTrue manda um link ao endereço novo (e ao antigo, com `double_confirm_changes`). Ou
-- seja, o buraco "troca sem prova" não existe nessa versão. Esta migration é a CAMADA DE BAIXO: o produto não oferece
-- troca de e-mail ao usuário (updateProfile só grava `user_metadata`), então a troca deixa de depender da versão e da
-- configuração do GoTrue (`double_confirm_changes` desligado, versão antiga, outro caminho que o auth venha a ganhar).
--
-- O que faz:
--   1. `public.email_trocas_aprovadas`: a aprovação de UMA troca (usuário, novo endereço). Vale 1 hora e se usa uma vez.
--      RLS ligada sem policy e nenhum privilégio para anon/authenticated: só o servidor.
--   2. `public.fn_aprovar_troca_de_email(uuid, text)`: a única porta que cria a aprovação. Só service_role executa.
--   3. `public.fn_auth_recusa_troca_de_email()` + gatilho BEFORE UPDATE OF email em `auth.users`: recusa mudar o endereço
--      de uma conta que já tem um, salvo com aprovação válida (que é consumida). Não bloqueia: cadastro (INSERT), convite,
--      bootstrap-owner, conta sem endereço ganhando o primeiro, mudança só de maiúsculas e a anonimização por exclusão
--      suave (`deleted_at`).
--
-- 4. (mesma migration, D-204 fecha o cadastro por qualquer caminho) `public.fn_auth_abre_verificacao_do_cadastro()` + gatilho
--    BEFORE INSERT em `auth.users`: todo cadastro por e-mail e senha nasce com o PEDIDO de verificação do CRM em aberto em
--    `raw_app_meta_data`, no formato de `lib/auth/verificacao-email.ts`, seja pela ação de cadastro do CRM, seja pelo
--    `POST /auth/v1/signup` direto com a anon key (que a ação não vê). Sem isso, com a confirmação automática do provedor
--    ligada, a conta criada direto no GoTrue contava como verificada (falha aberta) e o pré-sequestro por Google ou
--    recuperação de senha não a reconhecia. O pedido nasce com um hash que ninguém conhece (não existe link): a faixa do CRM
--    oferece "Reenviar", que abre um pedido de verdade. Fica de fora, por já trazerem prova ou não serem e-mail e senha:
--    cadastro pelo Google (provider diferente de email), conta criada por admin API com `app_metadata.email_verificado_em`
--    (dono da instalação, parceiro, scripts) e conta que já traz um pedido. Só INSERT: contas existentes não mudam. Só
--    vale com a compra pelo cliente ligada (`billing_settings.compra_pelo_cliente`), a mesma condição em que a ação de
--    cadastro grava o pedido: instalação sem ela não ganha faixa de e-mail nenhuma.
--
-- Reaplicável: `if not exists`, `create or replace` (inclusive o gatilho) e revoke/grant declarativos. A criação do
-- gatilho em `auth.users` não derruba a instalação se o papel que aplica não for dono da tabela (vira aviso; a
-- próxima atualização tenta de novo).

set lock_timeout = '3s';

create table if not exists public.email_trocas_aprovadas (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  novo_email  text not null,
  aprovado_em timestamptz not null default now(),
  usado_em    timestamptz,
  constraint email_trocas_aprovadas_email_minusculo check (novo_email <> '' and novo_email = lower(novo_email))
);

comment on table public.email_trocas_aprovadas is
  '0966 (D-204): aprovação do servidor para UMA troca de e-mail (usuário, novo endereço em minúsculas). Vale 1 hora e é de uso único (usado_em). Consumida pelo gatilho de auth.users. Só service_role (via fn_aprovar_troca_de_email) escreve; anon e authenticated não têm privilégio.';

create index if not exists email_trocas_aprovadas_pendentes_idx
  on public.email_trocas_aprovadas (user_id, novo_email)
  where usado_em is null;

alter table public.email_trocas_aprovadas enable row level security;

-- As duas origens de grant: o default ACL do Supabase (tudo a anon/authenticated/service_role) e o do dono.
revoke all on public.email_trocas_aprovadas from anon, authenticated, service_role;
grant select on public.email_trocas_aprovadas to service_role;

create or replace function public.fn_aprovar_troca_de_email(p_user uuid, p_novo_email text)
returns uuid
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_email text := lower(btrim(coalesce(p_novo_email, '')));
  v_id    uuid;
begin
  if p_user is null or position('@' in v_email) < 2 or length(v_email) > 254 then
    raise exception 'troca_de_email_invalida' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'usuario_nao_encontrado' using errcode = 'P0002';
  end if;

  -- Higiene: aprovação velha (usada ou não) não serve a mais nada. E uma aprovação nova substitui a anterior
  -- ainda não usada do mesmo usuário (uma troca em andamento por conta).
  delete from public.email_trocas_aprovadas where aprovado_em < now() - interval '7 days';
  delete from public.email_trocas_aprovadas where user_id = p_user and usado_em is null;

  insert into public.email_trocas_aprovadas (user_id, novo_email)
  values (p_user, v_email)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.fn_aprovar_troca_de_email(uuid, text) is
  '0966 (D-204): registra a aprovação do servidor para trocar o e-mail do usuário para p_novo_email (1 hora, uso único). Só service_role executa; quem chama é responsável por ter provado a posse do endereço novo (link enviado a ele).';

revoke execute on function public.fn_aprovar_troca_de_email(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_aprovar_troca_de_email(uuid, text) to service_role;

create or replace function public.fn_auth_recusa_troca_de_email()
returns trigger
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_aprovacao uuid;
begin
  -- Sem mudança real de endereço (o GoTrue reescreve a linha inteira em muitos caminhos): nada a decidir.
  if new.email is not distinct from old.email then
    return new;
  end if;
  -- Conta sem endereço ganhando o primeiro (usuário anônimo ou de telefone): não é troca.
  if coalesce(old.email, '') = '' then
    return new;
  end if;
  -- Só maiúsculas e minúsculas: o mesmo endereço.
  if lower(new.email) = lower(old.email) then
    return new;
  end if;
  -- Exclusão suave do GoTrue: ofusca o endereço e carimba `deleted_at` na mesma gravação. `to_jsonb(new)` e não
  -- `new.deleted_at` para o corpo não depender de a coluna existir (o banco de teste usa um stub de auth.users).
  if to_jsonb(new) ->> 'deleted_at' is not null then
    return new;
  end if;

  select a.id into v_aprovacao
    from public.email_trocas_aprovadas a
   where a.user_id = old.id
     and a.novo_email = lower(coalesce(new.email, ''))
     and a.usado_em is null
     and a.aprovado_em > now() - interval '1 hour'
   order by a.aprovado_em desc
   limit 1
   for update;

  if v_aprovacao is not null then
    update public.email_trocas_aprovadas set usado_em = now() where id = v_aprovacao;
    return new;
  end if;

  raise exception 'A troca de e-mail da conta exige a aprovação do servidor (D-204).'
    using errcode = '42501', hint = 'public.fn_aprovar_troca_de_email(user_id, novo_email)';
end;
$$;

comment on function public.fn_auth_recusa_troca_de_email() is
  '0966 (D-204): gatilho de auth.users. Recusa trocar o e-mail de uma conta que já tem um, salvo com aprovação válida em email_trocas_aprovadas (1 hora, uso único, consumida aqui). Não é chamável como RPC (retorna trigger).';

revoke execute on function public.fn_auth_recusa_troca_de_email() from public, anon, authenticated;

do $gancho_0966$
begin
  create or replace trigger trg_auth_users_recusa_troca_de_email
    before update of email on auth.users
    for each row
    when (old.email is distinct from new.email)
    execute function public.fn_auth_recusa_troca_de_email();
exception
  when insufficient_privilege or lock_not_available then
    raise warning '0966: o gatilho de troca de e-mail em auth.users NÃO foi criado (%). Reaplique como dono da tabela.', sqlerrm;
end
$gancho_0966$;

create or replace function public.fn_auth_abre_verificacao_do_cadastro()
returns trigger
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_app    jsonb;
  v_ligada boolean;
  v_agora  timestamptz := now();
  v_hash   text;
begin
  -- `to_jsonb(new)` e não `new.raw_app_meta_data`: o corpo não depende de a coluna existir (o banco de teste usa um stub).
  v_app := coalesce(to_jsonb(new) -> 'raw_app_meta_data', '{}'::jsonb);
  if jsonb_typeof(v_app) is distinct from 'object' then
    v_app := '{}'::jsonb;
  end if;

  -- Só cadastro por e-mail e senha. Google (e qualquer outro provedor) já traz a prova do endereço.
  if v_app ->> 'provider' is distinct from 'email' then
    return new;
  end if;
  -- Quem cria a conta por admin API e já sabe do endereço (dono da instalação, parceiro, convite aceito, scripts)
  -- grava o carimbo no `app_metadata`; e uma conta que já traz um pedido não ganha outro.
  if v_app ? 'email_verificado_em' or v_app ? 'email_verificacao' then
    return new;
  end if;
  if coalesce(new.email, '') = '' then
    return new;
  end if;

  -- Mesma condição da ação de cadastro do CRM (`compraPeloClienteDisponivel`): sem a compra pelo cliente não há
  -- verificação própria. Erro de leitura NÃO desliga a regra: o lado seguro é abrir o pedido.
  begin
    select coalesce(b.compra_pelo_cliente, false) into v_ligada from public.billing_settings b where b.id = 1;
    v_ligada := coalesce(v_ligada, false);
  exception when others then
    v_ligada := true;
  end;
  if not v_ligada then
    return new;
  end if;

  v_hash := encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex');
  v_app := v_app || jsonb_build_object(
    'email_verificacao',
    jsonb_build_object(
      'hash', v_hash,
      'expira_em', to_char((v_agora + interval '7 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'enviado_em', to_char(v_agora at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  );
  new := jsonb_populate_record(new, jsonb_build_object('raw_app_meta_data', v_app));
  return new;
end;
$$;

comment on function public.fn_auth_abre_verificacao_do_cadastro() is
  '0966 (D-204): gatilho BEFORE INSERT de auth.users. Cadastro por e-mail e senha (provider email, sem carimbo nem pedido) com a compra pelo cliente ligada nasce com o pedido de verificação do CRM em aberto em raw_app_meta_data (hash sem token: o link sai pelo Reenviar). Não é chamável como RPC (retorna trigger).';

revoke execute on function public.fn_auth_abre_verificacao_do_cadastro() from public, anon, authenticated;

do $gancho_0966_cadastro$
begin
  create or replace trigger trg_auth_users_abre_verificacao_do_cadastro
    before insert on auth.users
    for each row
    execute function public.fn_auth_abre_verificacao_do_cadastro();
exception
  when insufficient_privilege or lock_not_available then
    raise warning '0966: o gatilho de verificação do cadastro em auth.users NÃO foi criado (%). Reaplique como dono da tabela.', sqlerrm;
end
$gancho_0966_cadastro$;

reset lock_timeout;
