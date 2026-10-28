-- ============================================================================
-- 0977 — CAPTAÇÃO REPETIDA NÃO DUPLICA NEGÓCIO: dois envios do mesmo formulário
-- em segundos viram UM negócio, também na corrida.
--
-- Medido em produção (27/10/2026, organização CBEXS): o formulário do site
-- (WordPress/Fluent Forms -> n8n -> POST /api/v1/webhooks/in/[token]) foi
-- enviado duas vezes pela mesma pessoa em 1 segundo (clique duplo). Cada envio
-- trouxe um external_id diferente (`wp-46-9294`, `wp-46-9295`), então o índice
-- `uniq_crm_leads_org_source_external` não pegou. O contato foi reconhecido,
-- e mesmo assim nasceram DOIS negócios abertos no mesmo funil.
--
-- Por que o recadastro (16/10/2026, lib/webhooks/recadastro.ts) não bastou: a
-- rota PERGUNTA se o contato já tem negócio aberto no funil e só depois cria.
-- Com dois envios simultâneos, os dois perguntam antes de qualquer um criar,
-- os dois ouvem "não" e os dois criam. Pergunta e criação são duas chamadas da
-- REST; não há transação que as junte.
--
-- A correção mora no INSERT, que é a única operação das duas que é atômica: um
-- gatilho BEFORE INSERT em crm_leads que, só para o negócio que a captação
-- pública cria, toma `pg_advisory_xact_lock` por (organização, contato, funil)
-- e recusa a linha quando já existe negócio ABERTO do mesmo contato no mesmo
-- funil criado há no máximo 10 minutos. O lock vale até o fim da transação do
-- INSERT: o segundo envio espera o primeiro gravar e, em READ COMMITTED, a
-- consulta seguinte do gatilho já enxerga a linha do primeiro.
--
-- A recusa sai com sqlstate PT409 e mensagem `captacao_repetida_na_janela`. A
-- rota reconhece a mensagem, procura o negócio vencedor e responde como no
-- reenvio do mesmo external_id (200 com o lead que existe; histórico de
-- captação com desfecho `duplicado`). Nada de `lead.created` nasce para o
-- segundo envio, então nenhuma automação de primeiro toque dispara duas vezes.
--
-- A janela de 10 minutos é a mesma constante de lib/webhooks/captacao-repetida.ts
-- (JANELA_DA_CAPTACAO_REPETIDA_MS), cobrada por teste.
--
-- Quem o gatilho alcança (e só isso):
--   - source = 'webhook' E source_metadata com `webhook_source_id` (é o que a rota
--     de captação grava), SEM `clonado_de` (o clone de um negócio que veio da
--     captação herda os dois primeiros e não é captação);
--   - com contato e nascendo aberto;
--   - contato não anonimizado (mesma régua do recadastro).
-- Tela, API, MCP, importação, automação e clone não passam por aqui.
--
-- Reaplicável: create or replace + drop trigger if exists. Função nova em
-- public: EXECUTE revogado de PUBLIC, anon e authenticated (regra 9).
-- ============================================================================

create or replace function public.fn_crm_leads_captacao_repetida()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existente uuid;
begin
  if new.source is distinct from 'webhook'
     or new.contact_id is null
     or new.status is distinct from 'open'
     or not coalesce(new.source_metadata ? 'webhook_source_id', false)
     or coalesce(new.source_metadata ? 'clonado_de', false) then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      new.organization_id::text || ':' || new.contact_id::text || ':' || new.pipeline_id::text,
      977
    )
  );

  if exists (
    select 1 from public.contacts c
     where c.id = new.contact_id
       and c.organization_id = new.organization_id
       and c.is_anonymized = true
  ) then
    return new;
  end if;

  select l.id into v_existente
    from public.crm_leads l
   where l.organization_id = new.organization_id
     and l.contact_id = new.contact_id
     and l.pipeline_id = new.pipeline_id
     and l.status = 'open'
     and l.created_at >= clock_timestamp() - interval '10 minutes'
   order by l.created_at, l.id
   limit 1;

  if v_existente is not null then
    raise exception using
      errcode = 'PT409',
      message = 'captacao_repetida_na_janela',
      detail = v_existente::text;
  end if;

  return new;
end;
$$;

comment on function public.fn_crm_leads_captacao_repetida() is
  '0977: gatilho BEFORE INSERT de crm_leads. Só para o negócio da captação pública (source webhook, source_metadata com webhook_source_id e sem clonado_de, com contato, aberto): advisory lock por (organização, contato, funil) e recusa PT409 captacao_repetida_na_janela quando já há negócio aberto do mesmo contato no mesmo funil criado há até 10 minutos. Fecha a corrida do clique duplo que o recadastro (consulta antes do insert) não fecha. Sem HTTP.';

revoke execute on function public.fn_crm_leads_captacao_repetida() from public, anon, authenticated;
grant execute on function public.fn_crm_leads_captacao_repetida() to service_role;

drop trigger if exists trg_crm_leads_captacao_repetida on public.crm_leads;
create trigger trg_crm_leads_captacao_repetida
  before insert on public.crm_leads
  for each row
  execute function public.fn_crm_leads_captacao_repetida();

comment on trigger trg_crm_leads_captacao_repetida on public.crm_leads is
  '0977: na ordem alfabética dos BEFORE roda depois de trg_crm_lead_close_on_stage (vê o status final) e de trg_crm_leads_billing_bloqueio. Recusa o segundo negócio do mesmo envio repetido; ver fn_crm_leads_captacao_repetida.';
