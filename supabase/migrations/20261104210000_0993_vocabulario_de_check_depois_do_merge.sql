-- 0993 (fork Hiperbold): o vocabulário de dois CHECKs depois do merge do upstream de 04/11/2026.
--
-- Mesma forma da 0911: duas branches represadas se encontram e a migration do upstream, com
-- timestamp depois da do fork, reconstrói o CHECK a partir da lista que ENXERGAVA.
--
--   1. webhook_events_log_provider_check: a 0601 do upstream (cobrança do revendedor) somou
--      'stripe' e 'asaas' a partir de uma lista sem 'uazapi' (da 0900/0911 do fork). Na cadeia,
--      a 0601 vem depois da 0911 e apaga 'uazapi'.
--   2. webhook_lead_captures_outcome_check: a 0683 do upstream somou 'atualizado' a partir de uma
--      lista sem 'recadastro' (da 0958 do fork). Na cadeia, a 0683 vem depois da 0958 e apaga
--      'recadastro', que a rota de captação grava.
--
-- Aqui fica a UNIÃO dos dois lados. Migration aplicada não se edita, então o conserto é este
-- forward-fix. No baseline.sql não há bloco novo: cada CHECK já vive num bloco único com a lista
-- final (o da 0151 para o provider; o da 0683 para o outcome, que passa a levar 'recadastro').
-- Alargamento puro: nenhuma linha que passava pelo CHECK antigo é recusada pelo novo.
-- Idempotente; sem BEGIN/COMMIT.

-- 1. Provedores do arquivo de webhooks.
alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;
alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'uazapi', 'datafy',
    'stripe', 'asaas'
  ));

-- 2. Desfechos da captação.
alter table public.webhook_lead_captures
  drop constraint if exists webhook_lead_captures_outcome_check;
alter table public.webhook_lead_captures
  add constraint webhook_lead_captures_outcome_check
  check (outcome in ('criado', 'duplicado', 'recusado', 'atualizado', 'recadastro'));

comment on column public.webhook_lead_captures.outcome is
  'criado = virou lead novo; duplicado = envio repetido, nada mudou no card; atualizado = o card da mesma fonte recebeu o dado novo (issue #2316, só com a opção da fonte ligada); recusado = não entrou (reject_reason diz por quê); recadastro = a pessoa já tinha lead ABERTO no funil da fonte, então nenhum lead foi criado e o recadastro foi registrado na timeline dele (lead_id aponta para ele).';
