-- 1009, os alarmes de gatilho de plano ganham prazo (D-074, fork Hiperbold).
--
-- O defeito. `billing_trigger_alarmes` (0910) guarda a falha que um gatilho de plano engoliu, e nada a
-- apagava: o `service_role` não tem DELETE nela (só select e insert, de propósito, para o rastro não ser
-- reescrito), e nenhuma poda a alcançava. Numa disputa de linha que se repete, a tabela só cresce.
--
-- A correção. `fn_podar_alarmes_de_gatilho(p_retencao_dias, p_limite)`, security definer, no molde das
-- podas da 0587 e da 9021: apaga em lote o alarme com `criado_em` mais velho que o prazo e devolve a
-- contagem. O piso de 90 dias mora no CORPO (`greatest(..., 90)`): quem chama com 1 dia não apaga alarme
-- recente. Os nomes dos parâmetros são os das irmãs, porque o cron `data-retention` chama todas pelo mesmo
-- laço e o PostgREST resolve a função pelo nome do argumento. Sem seletor de linha (nem organização, nem
-- gatilho): a função só alcança a ponta mais velha que o piso. O `service_role` continua sem DELETE na
-- tabela; esta função é a única porta, e só por idade.
--
-- O índice em `criado_em`. O que já existe é `(organization_id, criado_em desc)`, que não serve ao corte
-- global por idade com `order by criado_em limit`. A tabela é pequena e de escrita rara (uma linha por
-- falha engolida), então o índice novo custa quase nada e evita varrer a tabela inteira quando ela crescer.
--
-- Padrão e piso também em `lib/retencao/politica.ts` (RETENCAO_ALARMES_DE_GATILHO_DIAS_*), knob
-- `BILLING_TRIGGER_ALARM_RETENTION_DAYS`. O par SQL x TypeScript é medido em
-- `tests/unit/retencao-dos-alarmes-de-gatilho.test.ts`; o piso, num Postgres, em
-- `tests/invariants/alarmes-de-gatilho-tem-prazo.test.ts`.

create index if not exists billing_trigger_alarmes_criado_em_idx
  on public.billing_trigger_alarmes (criado_em);

create or replace function public.fn_podar_alarmes_de_gatilho(
  p_retencao_dias int default null,
  p_limite int default 1000
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- 90 = padrão e piso (RETENCAO_ALARMES_DE_GATILHO_DIAS_PADRAO e _PISO). Repetido aqui de propósito: a
  -- função vale para quem chama sem passar pelo TypeScript.
  v_dias int := greatest(coalesce(p_retencao_dias, 90), 90);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_corte timestamptz := now() - make_interval(days => v_dias);
  v_apagadas int;
begin
  -- O corte fica no `where` antes do `limit` (a lição da 0167).
  with vencidos as (
    select a.id from public.billing_trigger_alarmes a
     where a.criado_em < v_corte
     order by a.criado_em limit v_limite
  )
  delete from public.billing_trigger_alarmes a using vencidos v where a.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
revoke execute on function public.fn_podar_alarmes_de_gatilho(int,int) from public, anon, authenticated;
grant  execute on function public.fn_podar_alarmes_de_gatilho(int,int) to service_role;

comment on function public.fn_podar_alarmes_de_gatilho(int,int) is
  '1009, D-074: poda de billing_trigger_alarmes por idade (criado_em), em lote, piso de 90 dias no corpo. Única porta de apagamento da tabela; só service_role executa.';
