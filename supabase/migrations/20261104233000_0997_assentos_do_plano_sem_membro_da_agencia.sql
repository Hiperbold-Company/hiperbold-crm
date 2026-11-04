-- 0997 (fork Hiperbold) — assentos do plano: o membro da agência não ocupa vaga.
-- Espelhada no apêndice do supabase/baseline.sql. Motivo completo no comentário abaixo.
-- O merge do upstream de 04/11/2026 trouxe a trava de assentos da 0583
-- (`fn_trava_assentos_do_plano`), que conta todo vínculo ativo e não provisório. A 0974 do
-- fork diz que o membro da agência não ocupa vaga, e tirou ele da conta das funções de
-- cobrança que existiam no fork; a trava do upstream não estava entre elas. Resultado medido:
-- o criador de `fn_create_tenant_with_owner` (que desde a 0974 nasce `membro_da_agencia`, não
-- provisório) tomava a única vaga do plano, e o admin real da cliente era recusado com PT402.
-- Soma das duas regras: a trava do upstream continua igual e passa a pular o membro da agência,
-- na linha nova e na contagem; o vínculo que DEIXA de ser da agência sem ser revogado passa a
-- ser conferido como quem passa a ocupar vaga, por isso a coluna entra na lista do gatilho.
-- Idempotente: create or replace da função e do gatilho; lock_timeout de sessão (D-084).
create or replace function public.fn_trava_assentos_do_plano()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limite integer;
  v_em_uso integer;
begin
  if new.revoked_at is not null or new.provisional_until_handover or new.membro_da_agencia then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.revoked_at is null
       and not old.provisional_until_handover
       and not old.membro_da_agencia
       and new.organization_id is not distinct from old.organization_id then
      return new;
    end if;
  end if;

  v_limite := public.fn_limite_do_plano(new.organization_id, 'assentos');
  if v_limite is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text, 2282));

  select count(*) into v_em_uso
    from public.user_organizations uo
   where uo.organization_id = new.organization_id
     and uo.revoked_at is null
     and not uo.provisional_until_handover
     and not uo.membro_da_agencia
     and uo.user_id <> new.user_id;

  if v_em_uso >= v_limite then
    raise exception 'limite_do_plano:assentos:%', v_limite
      using errcode = 'PT402',
            detail = jsonb_build_object('recurso', 'assentos', 'limite', v_limite, 'em_uso', v_em_uso)::text;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_trava_assentos_do_plano() from public, anon, authenticated;

set lock_timeout = '5s';

create or replace trigger trg_trava_assentos_do_plano
  before insert or update of revoked_at, provisional_until_handover, organization_id, membro_da_agencia
  on public.user_organizations
  for each row execute function public.fn_trava_assentos_do_plano();

reset lock_timeout;
