-- 0956, o mês parcial em que o plano começa leva o teto inteiro de tokens (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisão do dono do produto (15/10/2026): uma organização que acabou de pagar o plano Max (3.000.000
-- de tokens de IA por mês) via "Consumo do mês: 0 de 1.645.161". A 0931 (D-106) concedia, na PRIMEIRA
-- concessão de plano de um período pago que começou no mês, (teto x dias restantes) / dias do mês
-- (3.000.000 x 17/31). O dono quer o contrário: no primeiro mês (parcial) a organização recebe a
-- franquia mensal CHEIA; os meses seguintes seguem como sempre (teto inteiro, uma concessão por mês).
--
-- O que esta migration faz:
--   1. Troca o CORPO de fn_billing_garantir_concessoes (create or replace, mesmo ACL, mesma assinatura):
--      tira a proporção. O resto fica igual: só concede ciclo novo a contrato em dia (D-086/D-106), uma
--      linha por ciclo (chave plano:<ciclo>), adicionais e reconcessão por estorno.
--   2. Corrige o que já foi concedido proporcional NESTE ciclo (o do mês corrente): para cada
--      organização cuja única concessão de plano é a do ciclo atual, com período pago começado neste
--      mês e valor exatamente igual à fórmula proporcional, soma a diferença como ajuste
--      (ajuste:primeiro-mes-cheio:<ciclo>, fonte plano, ciclo do mês) no livro-caixa e na carteira.
--      Idempotente (chave única; a carteira só soma quando a linha entra). O conferidor de carteira
--      já soma 'ajuste:%' do ciclo ao creditado, então carteira e livro-caixa continuam batendo.
--
-- A tela (Consumo do mês, Saldo por fonte) lê billing_token_wallets.creditado, a mesma carteira que o
-- gate da IA usa; não há segundo cálculo no TypeScript.
--
-- Reaplicável com o app no ar: sem DDL em tabela. Mesmo padrão de segurança da 0906: security definer,
-- search_path fixo, sem trava própria (quem chama já está sob billing_tokens:<org>); o backfill pega a
-- mesma trava por organização que o conferidor de carteira.

create or replace function public.fn_billing_garantir_concessoes(p_org uuid, p_ciclo date)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_teto bigint;
  v_linhas int;
  v_adicional record;
  v_status text;
  v_fim timestamptz;
  v_corte int;
  v_chave text;
  v_valor bigint;
begin
  -- Nunca concede para ciclo que já fechou (decisão 9). Comparação com o
  -- ciclo ATUAL (de now()), não com o ciclo da chamada que disparou a
  -- concessão: esta função é chamada com p_ciclo = ciclo DA CHAMADA por
  -- fn_billing_debitar_chamada, e uma chamada tardia de ciclo fechado
  -- (Tarefa 8) nunca deve criar concessão nova para um mês que já acabou.
  if p_ciclo < public.fn_billing_ciclo_de(now()) then
    return;
  end if;

  v_teto := (public.fn_billing_limites_efetivos(p_org) ->> 'tokens_ia_mes')::bigint;

  -- D-086 e D-106: só recebe o plano e os adicionais de um ciclo NOVO o contrato em dia, isto é,
  -- `ativa` ou `avaliacao` e sem o período já vencido. Cancelada (estorno total, ou fim do período
  -- depois de cancelar), atrasada, suspensa e o que passou do fim do período pago não ganham o
  -- ciclo do mês que vira: voltam a receber quando um pagamento reativa o contrato. O que já foi
  -- concedido num ciclo aberto continua valendo. Organização sem contrato segue como antes.
  select status, current_period_end
    into v_status, v_fim
    from public.billing_contracts
    where organization_id = p_org;

  if v_status is not null
     and (v_status not in ('ativa', 'avaliacao') or (v_fim is not null and v_fim <= now())) then
    return;
  end if;

  -- Ilimitado (teto nulo) não concede nada: o consumo cai direto na fonte
  -- plano sem saldo, e o extrato mostra "sem limite" (decisão 9).
  if v_teto is not null then
    -- Item 8 da revisão (23/09/2026): to_char, não ::text. O cast de date
    -- depende do DateStyle da sessão (ISO por padrão, mas não garantido);
    -- to_char('YYYY-MM-DD') é o MESMO texto que o ::text de sempre produzia
    -- (DateStyle ISO), então não duplica concessão nenhuma já gravada.
    v_chave := 'plano:' || to_char(p_ciclo, 'YYYY-MM-DD');

    -- Decisão do dono do produto (15/10/2026): o mês parcial em que o plano começa leva o TETO INTEIRO,
    -- sem proporção aos dias que restam do mês. A D-106 (0931) concedia (teto x dias restantes) /
    -- dias do mês na primeira concessão do período pago, e quem assinava no dia 15 de outubro via
    -- "0 de 1.645.161" num plano de 3.000.000. A proteção contra o dobro (assinar no dia 30 e
    -- receber outro mês cheio no dia 1) continua onde sempre esteve: só concede ciclo novo o
    -- contrato em dia (acima), e o ciclo seguinte é uma concessão nova do mês seguinte. A consulta
    -- só roda quando a chave do ciclo ainda não existe (uma vez por organização por mês), nunca no
    -- caminho quente do débito.
    if not exists (
      select 1 from public.billing_token_ledger
      where organization_id = p_org and chave = v_chave
    ) then
      v_valor := v_teto;

      insert into public.billing_token_ledger (organization_id, fonte, tokens, chave)
      values (p_org, 'plano', v_valor, v_chave)
      on conflict (organization_id, chave) do nothing;

      get diagnostics v_linhas = row_count;
      if v_linhas > 0 then
        insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
        values (p_org, 'plano', p_ciclo, v_valor, 0)
        on conflict (organization_id, fonte, ciclo) do update
          set creditado = public.billing_token_wallets.creditado + excluded.creditado,
              updated_at = now();
      end if;
    end if;

    -- D-086: um crédito novo para cada corte por estorno deste ciclo.
    v_corte := 1;
    while exists (
      select 1 from public.billing_token_ledger
      where organization_id = p_org
        and chave = 'ajuste:estorno-plano:' || to_char(p_ciclo, 'YYYY-MM-DD') || ':' || v_corte::text
    ) loop
      insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, ciclo, nota)
      values (
        p_org, 'plano', v_teto,
        'ajuste:reconcessao-plano:' || to_char(p_ciclo, 'YYYY-MM-DD') || ':' || v_corte::text, p_ciclo,
        'Plano concedido de novo: novo pagamento depois de estorno neste ciclo'
      )
      on conflict (organization_id, chave) do nothing;

      get diagnostics v_linhas = row_count;
      if v_linhas > 0 then
        insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
        values (p_org, 'plano', p_ciclo, v_teto, 0)
        on conflict (organization_id, fonte, ciclo) do update
          set creditado = public.billing_token_wallets.creditado + excluded.creditado,
              updated_at = now();
      end if;

      v_corte := v_corte + 1;
    end loop;
  end if;

  for v_adicional in
    select id, tokens_por_ciclo
    from public.billing_token_adicionais
    where organization_id = p_org and ativo
  loop
    -- Item 8 da revisão: to_char no ciclo (ver comentário acima); o id do
    -- adicional continua ::text (uuid, DateStyle não afeta).
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave)
    values (p_org, 'adicional', v_adicional.tokens_por_ciclo, 'adicional:' || v_adicional.id::text || ':' || to_char(p_ciclo, 'YYYY-MM-DD'))
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
      values (p_org, 'adicional', p_ciclo, v_adicional.tokens_por_ciclo, 0)
      on conflict (organization_id, fonte, ciclo) do update
        set creditado = public.billing_token_wallets.creditado + excluded.creditado,
            updated_at = now();
    end if;
  end loop;
end;
$$;

comment on function public.fn_billing_garantir_concessoes(uuid, date) is
  '0906, decisão 9, redefinida na 0916 (D-086), na 0931 (D-106) e na 0956: concessão preguiçosa e idempotente da fonte plano (teto efetivo do momento) e de cada adicional ativo, para o ciclo informado. Só concede ciclo novo a contrato em dia (ativa ou avaliacao, período não vencido). Desde a 0956 a primeira concessão, no mês parcial em que o plano começa, leva o teto INTEIRO (sem proporção aos dias restantes). NÃO trava sozinha: quem chama (fn_billing_debitar_chamada ou a RPC de saldo) já precisa estar sob pg_try_advisory_xact_lock(''billing_tokens:<org>''). insert ... on conflict do nothing no livro-caixa; billing_token_wallets.creditado só soma quando a linha do livro-caixa entra.';

revoke execute on function public.fn_billing_garantir_concessoes(uuid, date) from public, anon, authenticated;
grant execute on function public.fn_billing_garantir_concessoes(uuid, date) to service_role;

-- Corrige a concessão proporcional já gravada no ciclo corrente (ver o cabeçalho, item 2).
do $corrige$
declare
  v_ciclo date := public.fn_billing_ciclo_de(now());
  v_chave text := 'plano:' || to_char(public.fn_billing_ciclo_de(now()), 'YYYY-MM-DD');
  v_dias_do_mes int := ((public.fn_billing_ciclo_de(now()) + interval '1 month')::date - public.fn_billing_ciclo_de(now()));
  v_org record;
  v_teto bigint;
  v_dias_restantes int;
  v_diferenca bigint;
  v_linhas int;
begin
  for v_org in
    select c.organization_id, c.current_period_start, l.tokens
    from public.billing_contracts c
    join public.billing_token_ledger l
      on l.organization_id = c.organization_id and l.fonte = 'plano' and l.chave = v_chave
    where c.status in ('ativa', 'avaliacao')
      and c.current_period_start is not null
      and public.fn_billing_ciclo_de(c.current_period_start) = v_ciclo
      and not exists (
        select 1 from public.billing_token_ledger o
        where o.organization_id = c.organization_id and o.fonte = 'plano'
          and o.chave like 'plano:%' and o.chave <> v_chave
      )
  loop
    perform pg_advisory_xact_lock(hashtextextended('billing_tokens:' || v_org.organization_id::text, 0));

    v_teto := (public.fn_billing_limites_efetivos(v_org.organization_id) ->> 'tokens_ia_mes')::bigint;
    continue when v_teto is null;

    v_dias_restantes := (v_ciclo + interval '1 month')::date
      - (v_org.current_period_start at time zone 'America/Sao_Paulo')::date;
    continue when v_org.tokens is distinct from (v_teto * v_dias_restantes) / v_dias_do_mes;

    v_diferenca := v_teto - v_org.tokens;
    continue when v_diferenca <= 0;

    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, ciclo, nota)
    values (
      v_org.organization_id, 'plano', v_diferenca,
      'ajuste:primeiro-mes-cheio:' || to_char(v_ciclo, 'YYYY-MM-DD'), v_ciclo,
      'Primeiro mês com a franquia cheia: a concessão proporcional foi completada até o teto do plano'
    )
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      update public.billing_token_wallets
        set creditado = creditado + v_diferenca, updated_at = now()
        where organization_id = v_org.organization_id and fonte = 'plano' and ciclo = v_ciclo;
    end if;
  end loop;
end;
$corrige$;
