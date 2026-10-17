-- 0967, carimbo de horário na captação assinada (D-215) e CPF do contato só do servidor (D-216) (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Dois achados de gravidade baixa da auditoria de 17/10/2026.
--
-- D-215. O HMAC da captação pública (`webhooks/in/[token]`) cobria só o corpo: um envio assinado capturado podia ser
-- reenviado para sempre. O envio passa a poder levar `X-HiperCRM-Timestamp` (assinatura sobre `v1:ts.corpo`, janela de 300
-- s). `webhook_sources.exige_carimbo` é a catraca: a rota a liga no primeiro envio válido COM carimbo, e dali em diante
-- a fonte recusa envio sem carimbo. Default `false`, então o n8n que hoje assina sem carimbo não quebra no deploy.
--
-- D-216. `contacts.cpf_hash` e `contacts.cpf_encrypted` eram legíveis e graváveis por `authenticated` (e `anon`) pelo
-- PostgREST, porque o GRANT era de tabela inteira (`GRANT ALL`, e o default ACL do Supabase concede o mesmo a toda
-- tabela). Privilégio de coluna não se revoga sobre grant de tabela, então o grant de tabela de SELECT/INSERT/UPDATE
-- sai e entra um grant POR COLUNA em todas as colunas, menos nas duas. O servidor (`service_role`) não muda.
-- DELETE, REFERENCES e TRIGGER seguem de tabela. A RLS não muda.
--
-- ⚠️ COLUNA NOVA EM `contacts` NASCE SEM GRANT PARA `authenticated`/`anon`: o grant de coluna não é herdado. Toda
-- migration que acrescentar coluna a `contacts` precisa concedê-la (SELECT, INSERT, UPDATE) no mesmo arquivo; o
-- invariante `tests/invariants/contacts-cpf-so-do-servidor.test.ts` reprova a coluna esquecida, em vez de a tela
-- quebrar em silêncio com "permission denied for table contacts".
--
-- Uma função de gatilho (invoker), com revoke de public/anon/authenticated, trava a catraca no banco. Reaplicável: a coluna é `if not exists`; o revoke e o grant por
-- coluna dão o mesmo resultado a cada aplicação. As colunas são lidas do catálogo na hora de aplicar, para valer
-- também para as que migrations posteriores a 0001 acrescentaram.

set lock_timeout = '3s';

alter table public.webhook_sources
  add column if not exists exige_carimbo boolean not null default false;

comment on column public.webhook_sources.exige_carimbo is
  'Ligada sozinha no primeiro envio válido com X-HiperCRM-Timestamp (D-215). Ligada, a fonte recusa envio assinado sem carimbo (anti-reenvio). Nunca volta a false por código.';

-- A catraca vale no BANCO, não só no código: um manager tem UPDATE em `webhook_sources` pela REST, e sem esta trava
-- bastaria `exige_carimbo = false` para reabrir o formato sem carimbo (e o reenvio). Só o `service_role` (o servidor)
-- pode tirar a exigência; quem liga é a rota, e ligar qualquer um pode. Para desligar de propósito, o dono do banco
-- usa `alter table public.webhook_sources disable trigger trg_webhook_sources_catraca_do_carimbo`.
create or replace function public.fn_webhook_sources_catraca_do_carimbo()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.exige_carimbo is true and new.exige_carimbo is not true and current_user <> 'service_role' then
    raise exception 'exige_carimbo não pode ser desligado: a fonte já recebeu um envio assinado com carimbo'
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- Função nova em public nasce exposta: as duas origens de EXECUTE (grant direto a anon do default ACL e o grant a
-- PUBLIC). Gatilho não precisa de EXECUTE do papel que dispara a escrita.
revoke execute on function public.fn_webhook_sources_catraca_do_carimbo() from public, anon, authenticated;

drop trigger if exists trg_webhook_sources_catraca_do_carimbo on public.webhook_sources;
create trigger trg_webhook_sources_catraca_do_carimbo
  before update of exige_carimbo on public.webhook_sources
  for each row execute function public.fn_webhook_sources_catraca_do_carimbo();

-- Sai o grant de tabela, entra o de coluna. O `revoke` em tabela também remove qualquer grant de coluna que já
-- existisse, então a ordem importa: revoga primeiro, concede depois.
revoke select, insert, update on table public.contacts from anon, authenticated;

do $$
declare
  v_colunas text;
begin
  select string_agg(format('%I', a.attname), ', ' order by a.attnum)
    into v_colunas
    from pg_attribute a
   where a.attrelid = 'public.contacts'::regclass
     and a.attnum > 0
     and not a.attisdropped
     and a.attname not in ('cpf_hash', 'cpf_encrypted');

  execute format('grant select (%s) on table public.contacts to anon, authenticated', v_colunas);
  execute format('grant insert (%s) on table public.contacts to anon, authenticated', v_colunas);
  execute format('grant update (%s) on table public.contacts to anon, authenticated', v_colunas);
end
$$;

comment on column public.contacts.cpf_hash is
  'HMAC do CPF (busca exata). Sem SELECT/INSERT/UPDATE para anon e authenticated (0967, D-216): só o servidor lê e grava.';
comment on column public.contacts.cpf_encrypted is
  'CPF cifrado. Sem SELECT/INSERT/UPDATE para anon e authenticated (0967, D-216): só o servidor lê e grava.';

reset lock_timeout;
