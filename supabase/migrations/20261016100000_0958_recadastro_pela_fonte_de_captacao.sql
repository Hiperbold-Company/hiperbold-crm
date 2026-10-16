-- 0958, quem já tem lead aberto no funil da fonte e se cadastra de novo não ganha outro lead (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisão do dono do produto (16/10/2026): a fonte de captação (webhook/formulário) criava um lead novo a
-- cada envio, mesmo para quem já tinha um aberto no funil dela. Agora, se o contato já tem lead ABERTO
-- (status = 'open') no funil padrão da fonte, o CRM não cria outro: registra o recadastro na linha do tempo
-- do lead que existe (atividade lead_reregistered), mantém a etapa e grava no histórico de captação o
-- desfecho 'recadastro'. Se os leads dele naquele funil estão todos ganhos ou perdidos, ou ele só tem lead
-- em outro funil, o lead novo nasce como sempre.
--
-- O que esta migration faz:
--   1. webhook_lead_captures_outcome_check passa a aceitar 'recadastro' (vocabulário que a tela "Leads
--      recebidos" pinta e filtra; o espelho no TypeScript é DESFECHOS_DA_CAPTACAO, vigiado por
--      tests/invariants/vocabulario-banco-x-typescript.test.ts).
--   2. fn_update_last_activity_at (create or replace, mesmo ACL) soma lead_reregistered à lista positiva do
--      relógio do silêncio: a pessoa levantou a mão de novo, o negócio deixa de contar como parado.
--
-- Reaplicável com o app no ar: a constraint só é trocada quando ainda não conhece 'recadastro', a função é
-- create or replace. Nenhuma função nova (a que existe já tem o ACL certo): nada a ver com a VARREDURA anon.

-- 1. O desfecho "recadastro" no histórico de captação.
do $outcome_recadastro$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'webhook_lead_captures_outcome_check'
       and conrelid = 'public.webhook_lead_captures'::regclass
       and pg_get_constraintdef(oid) like '%recadastro%'
  ) then
    alter table public.webhook_lead_captures drop constraint if exists webhook_lead_captures_outcome_check;
    alter table public.webhook_lead_captures
      add constraint webhook_lead_captures_outcome_check
      check (outcome in ('criado', 'duplicado', 'recusado', 'recadastro'));
  end if;
end
$outcome_recadastro$;

comment on column public.webhook_lead_captures.outcome is
  'criado = virou lead novo; duplicado = mesmo external_id já capturado antes (retry da ferramenta); recusado = não entrou (reject_reason diz por quê); recadastro = a pessoa já tinha lead ABERTO no funil da fonte, então nenhum lead foi criado e o recadastro foi registrado na timeline dele (lead_id aponta para ele).';

-- 2. Quem se cadastra de novo quebra o silêncio do negócio.
create or replace function public.fn_update_last_activity_at()
  returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
begin
  -- LISTA POSITIVA: só isto conta como "alguém tocou este negócio". Tipo que
  -- não está aqui NÃO quebra o silêncio — inclusive tipo que ainda não existe.
  -- Ver o cabeçalho da 0079 antes de acrescentar linha nesta lista.
  if new.type not in (
    'ai_turn',              -- a IA falou com o cliente
    'note',                 -- alguém registrou trabalho no negócio
    'lead_edited',          -- humano mexeu nos dados
    'stage_changed',        -- humano moveu o negócio
    'next_action_approved', -- humano decidiu agir
    -- (0235) Uma ligação ATENDIDA é interação, e das mais fortes: alguém falou
    -- com o cliente. Sem esta linha o Radar de Risco seguia marcando como frio
    -- quem tinha acabado de passar vinte minutos ao telefone, e a IA propunha
    -- "retomar contato" com quem nunca ficou sem contato.
    --
    -- `voice_call_missed` NÃO entra, e a ausência é a regra e não esquecimento:
    -- telefone que tocou sem resposta é constatação de silêncio, não quebra
    -- dele. É exatamente a assimetria que a 0079 existe para preservar.
    'voice_call',
    -- (0958) A PESSOA se cadastrou de novo por uma fonte de captação: o cliente
    -- levantou a mão agora. É interação do lado dele, a mais forte que existe, e
    -- o negócio que ficou parado esperando não pode seguir marcado como frio.
    'lead_reregistered'
  ) then
    return new;
  end if;

  update public.crm_leads
     set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
   where id = new.lead_id;

  if new.contact_id is not null then
    update public.contacts
       set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
     where id = new.contact_id;
  end if;
  return new;
end$function$;
