-- manifest: **Campo do contato mesclado no banco (fork Hiperbold, 25/11/2026).** `public.fn_contato_anotar_campos(p_org, p_contato, p_campos)` (security definer, só service_role) faz `custom_fields = custom_fields || p_campos` numa instrução só, para o agente de IA (`crm_set_custom_field`) gravar a resposta do cliente sem apagar a edição humana feita ao mesmo tempo. Espelho no apêndice do `supabase/baseline.sql`; sem tabela nem coluna nova.
--
-- O mesmo conserto da `fn_lead_anotar_campos`, para o CONTATO: o agente de IA
-- (`crm_set_custom_field`) grava só as chaves que o cliente respondeu, e o PATCH
-- do contato SUBSTITUÍA o mapa inteiro que ele tinha lido — uma edição humana
-- feita entre a leitura e a gravação sumia em silêncio. Aqui a conta
-- `custom_fields || p_campos` acontece DENTRO de uma única instrução `update`,
-- que em READ COMMITTED é refeita sobre a linha vigente quando há escrita
-- concorrente (o argumento medido está no cabeçalho da `fn_lead_anotar_campos`).
--
-- Não decide papel nem organização: isso é de quem chama
-- (`patchContactHandler`, modo `mesclarCamposPersonalizados`), que resolve a
-- organização de fonte confiável. Sem linha (contato inexistente ou de outra
-- organização) nada é gravado e o resultado é nulo. `||` é raso de propósito.
--
-- Idempotente: `create or replace` e revoke/grant reaplicáveis. Sem constraint
-- nem dado a corrigir.
create or replace function public.fn_contato_anotar_campos(
  p_org uuid, p_contato uuid, p_campos jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  resultado jsonb;
begin
  if p_campos is null or jsonb_typeof(p_campos) <> 'object' then
    raise exception 'campos_precisa_ser_objeto' using errcode = '22023';
  end if;

  update public.contacts
     set custom_fields = coalesce(custom_fields, '{}'::jsonb) || p_campos,
         updated_at = now()
   where organization_id = p_org and id = p_contato
   returning custom_fields into resultado;

  return resultado;
end $fn$;

-- Função nova em `public` nasce exposta pelas DUAS origens de EXECUTE (o
-- default ACL do baseline e o grant a PUBLIC): revoga das duas, e de
-- `authenticated` — ela ESCREVE e não confere organização do chamador.
revoke all on function public.fn_contato_anotar_campos(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_contato_anotar_campos(uuid, uuid, jsonb) to service_role;

comment on function public.fn_contato_anotar_campos(uuid, uuid, jsonb) is
  'Mescla campos personalizados no contato DENTRO do banco, numa única instrução atômica. '
  'Existe porque o merge no aplicativo perdia escrita concorrente em silêncio. '
  'Não decide papel nem organização — isso é de quem chama.';

notify pgrst, 'reload schema';
