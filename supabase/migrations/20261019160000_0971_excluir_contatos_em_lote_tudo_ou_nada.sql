-- 0971, excluir contatos em lote: cada bloco é tudo-ou-nada (fork Hiperbold, achado de média gravidade da revisão
-- da seleção em lote da tela Contatos, 19/10/2026).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- O defeito que isto fecha. A exclusão de contato (lixeira de uma linha) apaga, nesta ordem, as mensagens, as
-- conversas e a ficha, em três comandos separados e sem transação: `messages` e `conversations` apontam para
-- `contacts` com ON DELETE RESTRICT. Em lote, o mesmo desenho deixa contato MEIO APAGADO: se um DELETE de ficha
-- esbarra num vínculo (ou se a RLS do usuário escondeu uma conversa, que então segura a ficha), o histórico do
-- contato já saiu e a ficha continua de pé. Mensagem apagada não volta.
--
-- A correção. `fn_excluir_contatos_em_lote(org, ids)` faz as três exclusões numa ÚNICA chamada — portanto numa
-- única transação — e a recusa de qualquer uma delas desfaz as três. A função é SECURITY INVOKER: roda com o
-- papel e a RLS de quem a chama, não ganha privilégio nenhum. Piso `manager` conferido aqui dentro (o mesmo da
-- rota), porque a RPC é alcançável por `authenticated` pelo PostgREST e precisa se defender sozinha.
--
-- Regras iguais às da lixeira de uma linha (`deleteContactHandler`), e o que difere é dito:
--   * contato com compromisso na agenda (`calendar_appointments`, RESTRICT) NÃO é apagado: fica de fora, sem que
--     nada dele seja tocado;
--   * contato ANONIMIZADO (LGPD) e a LÁPIDE de fusão (`is_merged_into`) também ficam de fora — o lote só opera
--     contato vivo (a lixeira de uma linha não filtrava, mas o lote age sobre milhares de uma vez);
--   * o que a função devolve são os ids REALMENTE apagados; o chamador compara com o que pediu.
--   * se a RLS impedir o DELETE de alguma ficha selecionada, a função levanta `lote_nao_apagou_tudo` e a
--     transação volta inteira: é o tudo-ou-nada.
--
-- Teto de 100 ids por chamada: o bloco mantém as travas curtas e o tempo abaixo do `statement_timeout`.
--
-- Reaplicável: create or replace + revoke/grant idempotentes. Função nova em public nasce exposta, então revoga as
-- DUAS origens de EXECUTE (o grant direto a anon do default privileges e o grant a PUBLIC).

set lock_timeout = '3s';

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
  'Exclui até 100 contatos vivos de uma organização (mensagens, conversas e ficha) numa só transação: tudo-ou-nada. SECURITY INVOKER, piso manager. Deixa de fora contato com compromisso na agenda, anonimizado e lápide de fusão. Devolve os ids apagados.';

reset lock_timeout;
