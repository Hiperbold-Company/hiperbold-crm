-- manifest: **Planos v2: preços 25% menores e seis limites novos (D-227, fork Hiperbold).** `fn_billing_limites_validos` passa a aceitar, no plano, o conjunto antigo de 7 chaves OU o novo de 13 (nunca um meio-termo); no ajuste, qualquer subconjunto das 13. Chaves novas: `agentes_ia`, `automacoes`, `mcp_req_min` (0 = sem MCP), `acesso_api` (0/1, 0 = sem chave de API), `automacao_comentario_instagram` (0/1), `fonte_dados_req_min`; as duas de liga/desliga só aceitam 0, 1 ou null. `fn_billing_limites_efetivos` devolve as 13 (chave ausente no plano = null, sem limite: contrato na v1 segue sem os limites novos). Catálogo: versão 2 de pro, max e escale à venda e ativa; a v1 sai de venda e deixa de ser a ativa (continua servindo quem a contratou, `billing_contracts.plan_id` aponta a versão). Só cria a v2 quando ela não existe e a versão ativa é a 1: plano que o operador já versionou não é tocado.

-- ============================================================================
-- 1001 — PLANOS V2: PREÇOS NOVOS E OS LIMITES QUE FALTAVAM
--
-- Decisão do dono do produto em 05/11/2026 (item D-227 de hiperbold/DEBITO.md):
-- preços 25% menores e limites novos por plano. Esta migration cuida só do
-- CATÁLOGO (o que o plano diz). As travas que fazem cumprir os limites novos
-- são outra unidade: aqui só se valida, se grava e se lê.
--
-- ─── Por que 7 OU 13, e não "13 com as novas opcionais" ───────────────────
-- Linhas antigas (v1 e qualquer clone) têm só as 7 chaves. Aceitar meio-termo
-- deixaria um plano com `agentes_ia` e sem `automacoes`, e a pergunta "este
-- plano limita automações?" passaria a ter duas respostas (ausente e null).
-- Com dois conjuntos fechados, ausente só acontece em plano antigo, e quer
-- dizer sempre "sem limite".
--
-- ─── Por que a v1 vira active = false ─────────────────────────────────────
-- `billing_plans_code_ativo_unique` permite uma versão ativa por código, e
-- `active` quer dizer "a versão em vigor": é a que o checkout, a troca manual
-- e o contrato de avaliação escolhem (`where code = X and active`). O contrato
-- aponta a VERSÃO por id, então desativar a v1 não muda o preço nem os limites
-- de quem a contratou. Em produção hoje não há assinatura paga ativa.
--
-- Reaplicável: create or replace nas funções (mesmo ACL repetido) e o
-- catálogo guardado por "a v2 ainda não existe".
-- ============================================================================

-- ── 1. fn_billing_limites_validos: 7 ou 13 chaves ──
create or replace function public.fn_billing_limites_validos(l jsonb, parcial boolean)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_chave text;
  v_valor jsonb;
  v_numero numeric;
  v_originais integer := 0;
  v_novas integer := 0;
begin
  if l is null or jsonb_typeof(l) <> 'object' then
    return false;
  end if;

  for v_chave, v_valor in select * from jsonb_each(l)
  loop
    if v_chave in (
      'funis', 'etapas_por_funil', 'leads', 'membros',
      'conexoes', 'integracoes_webhook', 'tokens_ia_mes'
    ) then
      v_originais := v_originais + 1;
    elsif v_chave in (
      'agentes_ia', 'automacoes', 'mcp_req_min', 'acesso_api',
      'automacao_comentario_instagram', 'fonte_dados_req_min'
    ) then
      v_novas := v_novas + 1;
    else
      return false;
    end if;

    if jsonb_typeof(v_valor) = 'null' then
      -- null é o valor documentado de "sem limite": aceito.
      null;
    elsif jsonb_typeof(v_valor) = 'number' then
      -- O texto do número precisa casar com inteiro puro ('5.0'::int quebra).
      if (v_valor::text) !~ '^[0-9]+$' then
        return false;
      end if;
      v_numero := (v_valor::text)::numeric;
      if v_numero > 2147483647 then
        return false;
      end if;
      -- Liga/desliga: 0 = não incluso, 1 = incluso.
      if v_chave in ('acesso_api', 'automacao_comentario_instagram') and v_numero > 1 then
        return false;
      end if;
    else
      return false;
    end if;
  end loop;

  -- Plano (parcial = false): as 7 originais, sozinhas ou com as 6 novas.
  -- Ajuste (parcial = true): qualquer subconjunto, inclusive vazio.
  if not parcial and not (v_originais = 7 and v_novas in (0, 6)) then
    return false;
  end if;

  return true;
end;
$$;

comment on function public.fn_billing_limites_validos(jsonb, boolean) is
  'Valida o objeto de tetos do plano. Chaves aceitas: as 7 originais (funis, etapas_por_funil, leads, membros, conexoes, integracoes_webhook, tokens_ia_mes) e as 6 da 1001 (agentes_ia, automacoes, mcp_req_min, acesso_api, automacao_comentario_instagram, fonte_dados_req_min). Valor null ou inteiro 0..2147483647; acesso_api e automacao_comentario_instagram só 0, 1 ou null. parcial=false exige as 7 originais ou as 13, nunca um meio-termo (plano); parcial=true aceita subconjunto, inclusive vazio (ajuste). EXCEÇÃO deliberada ao item 12: pura, não lê tabela nenhuma, e o CHECK que a chama roda no contexto de quem escreve (service_role), e por isso fica com o grant padrão de EXECUTE, sem revoke/grant explícito.';

comment on column public.billing_plans.limits is
  'Conjunto fechado: as 7 chaves originais (funis, etapas_por_funil, leads, membros, conexoes, integracoes_webhook, tokens_ia_mes) ou as 13 (mais agentes_ia, automacoes, mcp_req_min, acesso_api, automacao_comentario_instagram, fonte_dados_req_min, da 1001). Valor inteiro ou null (null = sem limite); chave nova ausente em plano antigo também é sem limite. Validado por fn_billing_limites_validos(limits, false).';

-- ── 2. fn_billing_limites_efetivos: as 13 chaves ──
--
-- Mesma precedência da 0904: o ajuste vence quando a chave está PRESENTE nele
-- (mesmo com null); senão vale o plano. Chave ausente no plano e no ajuste
-- sai como null (`->` de chave ausente é SQL null, e jsonb_build_object o
-- grava como JSON null).
create or replace function public.fn_billing_limites_efetivos(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'funis', case when aj.limits ? 'funis' then aj.limits -> 'funis' else pe.limits -> 'funis' end,
    'etapas_por_funil', case when aj.limits ? 'etapas_por_funil' then aj.limits -> 'etapas_por_funil' else pe.limits -> 'etapas_por_funil' end,
    'leads', case when aj.limits ? 'leads' then aj.limits -> 'leads' else pe.limits -> 'leads' end,
    'membros', case when aj.limits ? 'membros' then aj.limits -> 'membros' else pe.limits -> 'membros' end,
    'conexoes', case when aj.limits ? 'conexoes' then aj.limits -> 'conexoes' else pe.limits -> 'conexoes' end,
    'integracoes_webhook', case when aj.limits ? 'integracoes_webhook' then aj.limits -> 'integracoes_webhook' else pe.limits -> 'integracoes_webhook' end,
    'tokens_ia_mes', case when aj.limits ? 'tokens_ia_mes' then aj.limits -> 'tokens_ia_mes' else pe.limits -> 'tokens_ia_mes' end,
    'agentes_ia', case when aj.limits ? 'agentes_ia' then aj.limits -> 'agentes_ia' else pe.limits -> 'agentes_ia' end,
    'automacoes', case when aj.limits ? 'automacoes' then aj.limits -> 'automacoes' else pe.limits -> 'automacoes' end,
    'mcp_req_min', case when aj.limits ? 'mcp_req_min' then aj.limits -> 'mcp_req_min' else pe.limits -> 'mcp_req_min' end,
    'acesso_api', case when aj.limits ? 'acesso_api' then aj.limits -> 'acesso_api' else pe.limits -> 'acesso_api' end,
    'automacao_comentario_instagram', case when aj.limits ? 'automacao_comentario_instagram' then aj.limits -> 'automacao_comentario_instagram' else pe.limits -> 'automacao_comentario_instagram' end,
    'fonte_dados_req_min', case when aj.limits ? 'fonte_dados_req_min' then aj.limits -> 'fonte_dados_req_min' else pe.limits -> 'fonte_dados_req_min' end
  )
  from (
    select coalesce(
      (
        select bp.limits
        from public.billing_contracts bc
        join public.billing_plans bp on bp.id = bc.plan_id
        where bc.organization_id = p_org
      ),
      (
        select bp2.limits
        from public.billing_plans bp2
        where bp2.code = 'ilimitado' and bp2.active
      )
    ) as limits
  ) pe
  left join public.billing_plan_adjustments aj on aj.organization_id = p_org;
$$;

revoke execute on function public.fn_billing_limites_efetivos(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_limites_efetivos(uuid) to service_role;

-- ── 3. O catálogo: versão 2 de pro, max e escale ──
do $d1001$
declare
  v record;
  v_nome text;
  v_carencia integer;
begin
  perform set_config('lock_timeout', '3s', true);

  for v in
    select * from (values
      ('pro', 'Pro', 14900, 79900, 139900, jsonb_build_object(
        'funis', 5, 'etapas_por_funil', 10, 'leads', 5000, 'membros', 3,
        'conexoes', 3, 'integracoes_webhook', 3, 'tokens_ia_mes', 3000000,
        'agentes_ia', 1, 'automacoes', 10, 'mcp_req_min', 0, 'acesso_api', 0,
        'automacao_comentario_instagram', 0, 'fonte_dados_req_min', 60
      )),
      ('max', 'Max', 29900, 159900, 284900, jsonb_build_object(
        'funis', 10, 'etapas_por_funil', 15, 'leads', 50000, 'membros', 15,
        'conexoes', 10, 'integracoes_webhook', 10, 'tokens_ia_mes', 3000000,
        'agentes_ia', 3, 'automacoes', 20, 'mcp_req_min', 30, 'acesso_api', 1,
        'automacao_comentario_instagram', 1, 'fonte_dados_req_min', 60
      )),
      ('escale', 'Scale', 44900, 239900, 429900, jsonb_build_object(
        'funis', 25, 'etapas_por_funil', 20, 'leads', 100000, 'membros', 30,
        'conexoes', 20, 'integracoes_webhook', 20, 'tokens_ia_mes', 3000000,
        'agentes_ia', 10, 'automacoes', 30, 'mcp_req_min', 60, 'acesso_api', 1,
        'automacao_comentario_instagram', 1, 'fonte_dados_req_min', 120
      ))
    ) as t(code, nome, mensal, semestral, anual, limites)
  loop
    -- Já semeada (ou criada pelo operador): nada a fazer, nem reaplicando.
    if exists (select 1 from public.billing_plans where code = v.code and version = 2) then
      continue;
    end if;

    -- Outra versão já em vigor que não a 1: decisão do operador do clone.
    if exists (select 1 from public.billing_plans where code = v.code and active and version <> 1) then
      raise notice 'billing_planos_v2: % já tem versão ativa diferente da 1, catálogo não tocado', v.code;
      continue;
    end if;

    -- O nome e a carência que a tela já mostra vêm da v1 (o escale já se
    -- chama "Scale" desde a 0951).
    v_nome := null;
    v_carencia := null;
    select name, grace_days into v_nome, v_carencia
      from public.billing_plans
     where code = v.code and version = 1;

    update public.billing_plans
       set active = false, for_sale = false
     where code = v.code and version = 1;

    insert into public.billing_plans
      (code, version, active, name, for_sale, price_monthly_cents, price_semiannual_cents,
       price_yearly_cents, grace_days, limits)
    values
      (v.code, 2, true, coalesce(v_nome, v.nome), true, v.mensal, v.semestral,
       v.anual, coalesce(v_carencia, 7), v.limites)
    on conflict (code, version) do nothing;
  end loop;
end
$d1001$;
