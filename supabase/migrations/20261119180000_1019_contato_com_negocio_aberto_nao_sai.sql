-- 1019, contato com negócio em aberto não sai (fork Hiperbold, regra do dono do produto em 19/11/2026).
--
-- A regra. Negócio em aberto sem contato é negócio sem lead: a exclusão da ficha deixava o negócio
-- no funil, órfão, porque `crm_leads.contact_id` é `ON DELETE SET NULL`. A partir daqui um contato
-- com `crm_leads.status = 'open'` (mesmo `contact_id`, mesma organização) NÃO pode ser apagado.
-- Ganho e perdido seguem como antes: ficam, sem contato.
--
-- Por que no banco. A regra já existia no TypeScript (lixeira de uma linha, pré-checagem do diálogo
-- e exclusão em lote), mas `fn_apagar_contato_com_historico`, `fn_excluir_contatos_em_lote` e o
-- `DELETE /rest/v1/contacts` direto não conferiam `crm_leads`: quem chamasse a RPC ou a REST
-- passava por cima. E a contagem pelo cliente do usuário era cega para o `agent`, porque a RLS de
-- `crm_leads` (`fn_can_view_lead`) esconde o negócio de outro dono.
--
--  1. `fn_contato_com_negocio_aberto_nao_sai()`: função de gatilho, `security definer` (enxerga o
--     negócio que a RLS de quem apaga esconde), `search_path = public, pg_temp`, EXECUTE revogado
--     de public, anon e authenticated (o gatilho dispara sem EXECUTE de quem apaga). Recusa com
--     errcode próprio `HB409` e mensagem `contato_com_negocio_aberto`; o handler da rota mapeia
--     esse código para 409 (`ERRCODE_CONTATO_COM_NEGOCIO_ABERTO` em `lib/contacts/vinculos-restrict.ts`).
--  2. `trg_contato_com_negocio_aberto_nao_sai`: BEFORE DELETE em `public.contacts`, por linha.
--  3. A exclusão da ORGANIZAÇÃO inteira continua funcionando. `contacts.organization_id` é
--     `ON DELETE CASCADE`, e a cascata dispara o gatilho com o negócio ainda de pé (a ordem entre
--     as cascatas de `contacts` e `crm_leads` não é garantida). O gatilho libera quando a
--     organização da linha já não existe: a ação de FK roda depois do DELETE de `organizations`,
--     no mesmo comando, e enxerga a linha já apagada. Organização sumida leva os negócios pela mesma
--     cascata (`crm_leads.organization_id` também é CASCADE), então não sobra negócio órfão.
--     Não usamos `pg_trigger_depth() > 1`: ele liberaria QUALQUER exclusão de contato feita de
--     dentro de outro gatilho (hoje ou no futuro), não só a da organização; a pergunta "a
--     organização ainda existe?" é a própria condição que torna a exclusão segura.
--  4. `fn_excluir_contatos_em_lote` (corpo da 0971) ganha o `not exists` de negócio em aberto no
--     alvo: o contato barrado fica de fora (o chamador o classifica como bloqueado), como já
--     acontecia com a agenda. Sem isso o gatilho abortaria o bloco inteiro. Mesmo contrato:
--     SECURITY INVOKER, `search_path = ''`, piso `manager`, tudo-ou-nada, mesmos revoke e grant.
--
-- Idempotente: create or replace function, drop trigger if exists + create trigger, revoke/grant.
-- Gate: tests/invariants/contato-com-negocio-aberto-nao-sai.test.ts.

set lock_timeout = '3s';

create or replace function public.fn_contato_com_negocio_aberto_nao_sai()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A organização inteira está saindo (cascata de organizations): os negócios dela saem na mesma
  -- cascata, então não há negócio órfão a proteger.
  if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return old;
  end if;

  if exists (
    select 1
      from public.crm_leads l
     where l.organization_id = old.organization_id
       and l.contact_id = old.id
       and l.status = 'open'
  ) then
    raise exception using
      errcode = 'HB409',
      message = 'contato_com_negocio_aberto',
      detail  = 'O contato tem negócio em aberto no Pipeline. Ganhe, perca ou passe o negócio para outro contato antes de excluir.';
  end if;

  return old;
end;
$$;

revoke execute on function public.fn_contato_com_negocio_aberto_nao_sai() from public, anon, authenticated;

comment on function public.fn_contato_com_negocio_aberto_nao_sai() is
  'Migration 1019 (fork Hiperbold): gatilho BEFORE DELETE de contacts. Recusa (errcode HB409, contato_com_negocio_aberto) a exclusão de contato com crm_leads status=open na mesma organização. Libera quando a organização já não existe (cascata da exclusão da organização).';

drop trigger if exists trg_contato_com_negocio_aberto_nao_sai on public.contacts;
create trigger trg_contato_com_negocio_aberto_nao_sai
  before delete on public.contacts
  for each row execute function public.fn_contato_com_negocio_aberto_nao_sai();

create or replace function public.fn_excluir_contatos_em_lote(
  p_organization_id uuid,
  p_contact_ids uuid[]
)
returns uuid[]
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_alvo uuid[];
  v_apagados uuid[];
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'manager') then
    raise exception using errcode = '42501', message = 'insufficient_role';
  end if;

  if p_organization_id is null or p_contact_ids is null or cardinality(p_contact_ids) = 0 then
    return '{}'::uuid[];
  end if;
  if cardinality(p_contact_ids) > 100 then
    raise exception using errcode = '22023', message = 'lote_grande_demais';
  end if;

  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_alvo
    from public.contacts c
   where c.organization_id = p_organization_id
     and c.id = any (p_contact_ids)
     and c.is_merged_into is null
     and c.is_anonymized = false
     and not exists (
       select 1 from public.calendar_appointments a
        where a.contact_id = c.id and a.organization_id = p_organization_id
     )
     -- 1019: negócio em aberto barra a ficha (o gatilho recusaria e abortaria o bloco inteiro).
     and not exists (
       select 1 from public.crm_leads l
        where l.contact_id = c.id and l.organization_id = p_organization_id and l.status = 'open'
     );
  if cardinality(v_alvo) = 0 then
    return '{}'::uuid[];
  end if;

  delete from public.messages
   where organization_id = p_organization_id and contact_id = any (v_alvo);
  delete from public.conversations
   where organization_id = p_organization_id and contact_id = any (v_alvo);

  with d as (
    delete from public.contacts
     where organization_id = p_organization_id and id = any (v_alvo)
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_apagados from d;

  -- Tudo-ou-nada: ficha que a RLS não deixou apagar não pode ter perdido o histórico.
  if cardinality(v_apagados) <> cardinality(v_alvo) then
    raise exception using errcode = 'P0001', message = 'lote_nao_apagou_tudo';
  end if;

  return v_apagados;
end;
$$;

revoke execute on function public.fn_excluir_contatos_em_lote(uuid, uuid[]) from public, anon;
grant execute on function public.fn_excluir_contatos_em_lote(uuid, uuid[]) to authenticated;

comment on function public.fn_excluir_contatos_em_lote(uuid, uuid[]) is
  'Exclui até 100 contatos vivos de uma organização (mensagens, conversas e ficha) numa só transação: tudo-ou-nada. SECURITY INVOKER, piso manager. Deixa de fora contato com compromisso na agenda, com negócio em aberto (1019), anonimizado e lápide de fusão. Devolve os ids apagados.';

reset lock_timeout;

notify pgrst, 'reload schema';
