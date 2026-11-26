-- manifest: **Régua de cobrança do pedido de assinatura não pago (fork Hiperbold, 26/11/2026).** `billing_orders.vence_em` (date) gravada na criação pelo gatilho `trg_billing_orders_vence_em`; `fn_billing_pedidos_de_assinatura_em_aberto` calcula o prazo de cada pedido em aberto (suspensão do contrato ou vencimento + carência do plano) e o marco da régua; o `PAYMENT_OVERDUE` de pedido de assinatura deixa de pedir a remoção da fatura (`fn_billing_asaas_aplicar_fim_da_assinatura`), e o passo 3 da conciliação só remove no prazo (`fn_billing_pedidos_vencidos_para_remocao`); `fn_billing_regua_de_cobranca_pendentes` e `fn_billing_pedido_gravar_vencimento` servem a régua. Espelho no apêndice do `supabase/baseline.sql`.
--
-- Caso real: pedido de assinatura no cartão feito em 10/11, vencimento 13/11. No PAYMENT_OVERDUE (16/11) a
-- fatura foi apagada no Asaas e saiu um só e-mail; a conta foi suspensa em 20/11 sem link para pagar.
--
-- Decisão do dono do produto: a fatura não é apagada no vencimento. Ela fica no Asaas até o fim do prazo e
-- a régua (cron avisar-fatura-em-aberto) avisa 2 dias antes, no dia, 2 dias depois e 1 dia antes do limite,
-- sempre com o link. O limite é a suspensão do contrato, quando o pedido é o que o mantém (a fatura sai no dia
-- seguinte ao da suspensão); sem suspensão a caminho (sem contrato, conta já suspensa ou cancelada, troca
-- abandonada, Pix adiantado), é o vencimento mais a carência do plano do pedido. Pacote de tokens não muda.
--
-- Idempotente: add column if not exists, create or replace, drop trigger if exists, revoke/grant
-- reaplicáveis. Sem dado a corrigir: pedido antigo fica com vence_em nula, e quem lê usa um substituto que só
-- erra para mais tarde até a régua gravar a data lida no Asaas.

-- 1. A data de vencimento do pedido, gravada na criação.
alter table public.billing_orders add column if not exists vence_em date;

comment on column public.billing_orders.vence_em is
  '1026: a data (America/Sao_Paulo) em que a primeira cobrança do pedido vence no Asaas. Gravada na criação pelo gatilho trg_billing_orders_vence_em (a mesma regra de lib/billing/asaas/compra.ts: assinatura no cartão à vista vence no fim do período pago ainda vigente ou hoje; parcelado vence hoje; Pix e o resto vencem amanhã). A régua de cobrança corrige com o dueDate lido no Asaas (fn_billing_pedido_gravar_vencimento). Nula nos pedidos anteriores à 1026: quem lê usa um substituto que só erra para mais tarde (fn_billing_pedidos_de_assinatura_em_aberto).';

create or replace function public.fn_billing_orders_vence_em_na_criacao()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_fim timestamptz;
begin
  if new.vence_em is not null then
    return new;
  end if;
  if new.tipo = 'assinatura' and new.metodo = 'CREDIT_CARD' and coalesce(new.parcelas, 1) <= 1 then
    -- Decisão 26 (fn_billing_criar_pedido): com período pago ainda vigente a assinatura nasce no fim dele.
    select bc.current_period_end into v_fim
      from public.billing_contracts bc
     where bc.organization_id = new.organization_id;
    if v_fim is not null and v_fim > now() then
      new.vence_em := (v_fim at time zone 'America/Sao_Paulo')::date;
    else
      new.vence_em := v_hoje;
    end if;
  elsif coalesce(new.parcelas, 1) > 1 then
    new.vence_em := v_hoje;
  else
    new.vence_em := v_hoje + 1;
  end if;
  return new;
end;
$$;

comment on function public.fn_billing_orders_vence_em_na_criacao() is
  '1026: gatilho BEFORE INSERT de billing_orders que grava vence_em quando quem insere não a mandou. Espelha as datas de lib/billing/asaas/compra.ts (criarAssinaturaEDevolver, criarCobrancaParceladaEDevolver, criarCobrancaAvulsaEDevolver). Não faz HTTP.';

revoke execute on function public.fn_billing_orders_vence_em_na_criacao() from public, anon, authenticated;

drop trigger if exists trg_billing_orders_vence_em on public.billing_orders;
create trigger trg_billing_orders_vence_em
  before insert on public.billing_orders
  for each row execute function public.fn_billing_orders_vence_em_na_criacao();

-- 2. Os prazos de cada pedido de assinatura em aberto: a data-limite, se a fatura já pode sair do Asaas e o
--    marco da régua que vale hoje.
create or replace function public.fn_billing_pedidos_de_assinatura_em_aberto(
  p_agora timestamptz default now(),
  p_org uuid default null,
  p_pedido uuid default null
)
returns table (
  pedido_id uuid,
  organization_id uuid,
  ambiente text,
  status text,
  metodo text,
  parcelas integer,
  plan_id uuid,
  asaas_payment_id text,
  asaas_subscription_id text,
  asaas_installment_id text,
  invoice_url text,
  vence_em date,
  vence_em_gravado boolean,
  limite text,
  limite_em date,
  pode_remover boolean,
  marco text,
  marco_em date
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with base as (
    select o.id as b_id,
           o.organization_id as b_org,
           o.ambiente as b_ambiente,
           o.status as b_status,
           o.metodo as b_metodo,
           o.parcelas as b_parcelas,
           o.plan_id as b_plan,
           o.asaas_payment_id as b_pay,
           o.asaas_subscription_id as b_sub,
           o.asaas_installment_id as b_inst,
           o.invoice_url as b_url,
           o.created_at as b_criado,
           o.vence_em as b_vence,
           (p_agora at time zone 'America/Sao_Paulo')::date as hoje,
           (o.created_at at time zone 'America/Sao_Paulo')::date as criado_dia,
           pp.grace_days as p_grace,
           bc.status as c_status,
           bc.current_period_end as c_fim,
           coalesce(bc.cancel_at_period_end, false) as c_cancel,
           coalesce(cp.grace_days, 0) as c_grace,
           (select max(e.criado_em)
              from public.billing_contract_eventos e
             where e.contract_id = bc.id
               and e.para = 'suspensa') as c_suspensa_em
      from public.billing_orders o
      join public.billing_plans pp on pp.id = o.plan_id
      left join public.billing_contracts bc on bc.organization_id = o.organization_id
      left join public.billing_plans cp on cp.id = bc.plan_id
     where o.tipo = 'assinatura'
       and o.status in ('aguardando_pagamento', 'vencido')
       and (o.asaas_payment_id is not null or o.asaas_subscription_id is not null or o.asaas_installment_id is not null)
       and (p_org is null or o.organization_id = p_org)
       and (p_pedido is null or o.id = p_pedido)
  ), venc as (
    select b.*,
           -- Pedido anterior à 1026 (sem vence_em): o substituto só erra para MAIS TARDE (o vencimento real é
           -- hoje ou amanhã da criação, ou o fim do período vigente na criação).
           coalesce(
             b.b_vence,
             greatest(b.criado_dia + 1, coalesce((b.c_fim at time zone 'America/Sao_Paulo')::date, b.criado_dia + 1))
           ) as v_venc,
           -- O dia em que fn_billing_conferir_vencimento suspende: current_period_end + grace_days do plano do contrato.
           case when b.c_fim is null then null
                else ((b.c_fim + make_interval(days => b.c_grace)) at time zone 'America/Sao_Paulo')::date
           end as v_suspende_em
      from base b
  ), classe as (
    select v.*,
           -- O contrato foi suspenso DEPOIS de o pedido nascer (quem já estava suspenso e pediu para reativar não conta).
           coalesce(
             v.c_status = 'suspensa'
               and coalesce(v.c_suspensa_em, v.c_fim + make_interval(days => v.c_grace)) > v.b_criado,
             false
           ) as suspensa_depois,
           -- O contrato vai chegar a suspensa se este pedido não for pago: está em curso e a suspensão cai até o
           -- vencimento do pedido mais a carência.
           coalesce(
             v.c_status in ('avaliacao', 'ativa', 'atrasada')
               and v.c_fim is not null
               and not v.c_cancel
               and v.v_suspende_em <= v.v_venc + greatest(v.p_grace, v.c_grace, 1),
             false
           ) as a_caminho
      from venc v
  ), prazo as (
    select c.*,
           case when c.suspensa_depois or c.a_caminho then 'suspensao' else 'remocao' end as v_limite,
           case when c.suspensa_depois or c.a_caminho then c.v_suspende_em
                else c.v_venc + greatest(c.p_grace, 1)
           end as v_limite_em
      from classe c
  )
  select p.b_id,
         p.b_org,
         p.b_ambiente,
         p.b_status,
         p.b_metodo,
         p.b_parcelas,
         p.b_plan,
         p.b_pay,
         p.b_sub,
         p.b_inst,
         p.b_url,
         p.v_venc,
         p.b_vence is not null,
         p.v_limite,
         p.v_limite_em,
         -- Só o pedido já vencido no Asaas. Suspensão: só depois de o contrato estar suspensa (a conciliação das
         -- 04:30 UTC alcança no dia seguinte ao do conferidor das 05:40). Remoção: no dia da data-limite.
         (p.b_status = 'vencido'
           and case when p.v_limite = 'suspensao' then p.suspensa_depois else p.hoje >= p.v_limite_em end),
         m.marco,
         m.marco_em
    from prazo p
    left join lateral (
      select x.marco, x.marco_em
        from (values
               ('antes', p.v_venc - 2, 1),
               ('no_dia', p.v_venc, 2),
               ('depois', p.v_venc + 2, 3),
               ('ultimo_dia', p.v_limite_em - 1, 4)
             ) as x(marco, marco_em, ordem)
       where x.marco_em <= p.hoje
         and x.marco_em > p.criado_dia
         and p.hoje < p.v_limite_em
         and not p.suspensa_depois
       order by x.marco_em desc, x.ordem desc
       limit 1
    ) m on true;
$$;

comment on function public.fn_billing_pedidos_de_assinatura_em_aberto(timestamptz, uuid, uuid) is
  '1026: os pedidos de assinatura aguardando_pagamento ou vencido, com cobrança no Asaas, e os prazos de cada um, em datas de America/Sao_Paulo. limite = suspensao quando o contrato chega a suspensa se o pedido não for pago (em curso, suspensão até vencimento + carência) ou foi suspenso depois do pedido; limite_em é o dia da suspensão (current_period_end + grace_days do plano do contrato). limite = remocao no resto (sem contrato ou período, contrato já suspenso ou cancelado na criação, troca abandonada, Pix adiantado); limite_em = vence_em + grace_days do plano do pedido (no mínimo 1). pode_remover: pedido vencido e (suspensao: contrato suspenso depois do pedido; remocao: hoje >= limite_em). marco: o marco da régua que vale hoje, só o mais recente (antes = vence_em - 2, no_dia, depois = vence_em + 2, ultimo_dia = limite_em - 1), nunca no dia da criação nem do limite em diante. Única régua de prazos do passo 3 da conciliação e da régua de cobrança.';

revoke execute on function public.fn_billing_pedidos_de_assinatura_em_aberto(timestamptz, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_pedidos_de_assinatura_em_aberto(timestamptz, uuid, uuid) to service_role;

-- 3. O que o passo 3 da conciliação remove hoje.
create or replace function public.fn_billing_pedidos_vencidos_para_remocao(
  p_agora timestamptz default now(),
  p_limite integer default 200
)
returns table (
  pedido_id uuid,
  organization_id uuid,
  tipo text,
  asaas_payment_id text,
  asaas_subscription_id text,
  asaas_installment_id text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.r_id, r.r_org, r.r_tipo, r.r_pay, r.r_sub, r.r_inst
    from (
      -- Pacote de tokens: remoção no vencimento, como antes.
      select o.id as r_id, o.organization_id as r_org, o.tipo as r_tipo,
             o.asaas_payment_id as r_pay, o.asaas_subscription_id as r_sub, o.asaas_installment_id as r_inst
        from public.billing_orders o
       where o.status = 'vencido'
         and o.tipo <> 'assinatura'
         and (o.asaas_payment_id is not null or o.asaas_subscription_id is not null or o.asaas_installment_id is not null)
      union all
      -- Assinatura: só no prazo da régua.
      select a.pedido_id, a.organization_id, 'assinatura'::text,
             a.asaas_payment_id, a.asaas_subscription_id, a.asaas_installment_id
        from public.fn_billing_pedidos_de_assinatura_em_aberto(p_agora) a
       where a.pode_remover
    ) r
   limit greatest(coalesce(p_limite, 200), 1);
$$;

comment on function public.fn_billing_pedidos_vencidos_para_remocao(timestamptz, integer) is
  '1026: a lista do passo 3 da conciliação (lib/billing/asaas/conciliar.ts). Pacote de tokens vencido sai como antes; pedido de assinatura vencido só quando fn_billing_pedidos_de_assinatura_em_aberto diz pode_remover.';

revoke execute on function public.fn_billing_pedidos_vencidos_para_remocao(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.fn_billing_pedidos_vencidos_para_remocao(timestamptz, integer) to service_role;

-- 4. O que a régua de cobrança examina hoje.
create or replace function public.fn_billing_regua_de_cobranca_pendentes(
  p_agora timestamptz default now(),
  p_limite integer default 500
)
returns table (
  pedido_id uuid,
  organization_id uuid,
  ambiente text,
  status text,
  plan_id uuid,
  asaas_payment_id text,
  asaas_subscription_id text,
  asaas_installment_id text,
  invoice_url text,
  vence_em date,
  vence_em_gravado boolean,
  limite text,
  limite_em date,
  marco text,
  marco_em date
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.pedido_id, a.organization_id, a.ambiente, a.status, a.plan_id,
         a.asaas_payment_id, a.asaas_subscription_id, a.asaas_installment_id, a.invoice_url,
         a.vence_em, a.vence_em_gravado, a.limite, a.limite_em, a.marco, a.marco_em
    from public.fn_billing_pedidos_de_assinatura_em_aberto(p_agora) a
    join public.organizations org on org.id = a.organization_id and org.status = 'active'
   where (
           a.marco is not null
           and not exists (
             select 1 from public.billing_emails_enviados q
              where q.organization_id = a.organization_id
                and q.email_id = 'COB-05'
                and q.chave = 'pedido:' || a.pedido_id::text || ':' || a.marco
           )
         )
      -- Pedido anterior à 1026: entra para o vencimento ser lido no Asaas e gravado.
      or (not a.vence_em_gravado and a.limite_em > (p_agora at time zone 'America/Sao_Paulo')::date)
   order by a.marco_em nulls last, a.pedido_id
   limit greatest(coalesce(p_limite, 500), 1);
$$;

comment on function public.fn_billing_regua_de_cobranca_pendentes(timestamptz, integer) is
  '1026: os pedidos de assinatura que a régua de cobrança (lib/email/conta-e-cobranca/regua-de-cobranca.ts) examina hoje: marco vigente ainda não enfileirado (COB-05, chave pedido:<id>:<marco>) ou vencimento ainda não gravado. Só organização ativa.';

revoke execute on function public.fn_billing_regua_de_cobranca_pendentes(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.fn_billing_regua_de_cobranca_pendentes(timestamptz, integer) to service_role;

-- 5. A data lida no Asaas vence a gravada.
create or replace function public.fn_billing_pedido_gravar_vencimento(
  p_org uuid,
  p_pedido uuid,
  p_vence_em date
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if p_vence_em is null then
    raise exception 'billing_vencimento_obrigatorio' using errcode = '22023';
  end if;
  update public.billing_orders
     set vence_em = p_vence_em
   where id = p_pedido
     and organization_id = p_org
     and tipo = 'assinatura'
     and status in ('aguardando_pagamento', 'vencido')
     and vence_em is distinct from p_vence_em;
  return found;
end;
$$;

comment on function public.fn_billing_pedido_gravar_vencimento(uuid, uuid, date) is
  '1026: grava em billing_orders.vence_em o dueDate lido no Asaas pela régua de cobrança. Só pedido de assinatura aguardando_pagamento ou vencido, da organização dada. Devolve true quando mudou.';

revoke execute on function public.fn_billing_pedido_gravar_vencimento(uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.fn_billing_pedido_gravar_vencimento(uuid, uuid, date) to service_role;

-- 6. fn_billing_asaas_aplicar_fim_da_assinatura REDEFINIDA: o PAYMENT_OVERDUE de pedido de assinatura não pede
--    mais a remoção da fatura. Resto do corpo idêntico à última definição (0909, PARTE 8, itens 2 e 6).
create or replace function public.fn_billing_asaas_aplicar_fim_da_assinatura(p_evento_tipo text, p_confirmacao jsonb, p_ambiente text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id text;
  v_subscription_id text;
  v_status text;
  v_removida boolean;
  v_rota record;
  v_org uuid;
  v_org_pre uuid;
  v_pedido record;
  v_contract record;
  v_cancel_anterior boolean;
begin
  if p_ambiente not in ('sandbox', 'producao') then
    raise exception 'billing_ambiente_invalido' using errcode = '22023';
  end if;

  if p_evento_tipo in ('PAYMENT_OVERDUE', 'PAYMENT_DELETED') then
    v_payment_id := nullif(p_confirmacao->>'id', '');
    if v_payment_id is null then
      raise exception 'billing_payment_id_obrigatorio' using errcode = '22023';
    end if;

    if p_evento_tipo = 'PAYMENT_OVERDUE' then
      if coalesce(p_confirmacao->>'status', '') in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH') then
        return jsonb_build_object('resultado', 'ignorado', 'organization_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', 'pagamento_ja_recebido');
      end if;
      if coalesce(p_confirmacao->>'status', '') <> 'OVERDUE' then
        return jsonb_build_object('resultado', 'aguardando', 'organization_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', null);
      end if;
    else
      v_removida := coalesce((p_confirmacao->>'removida')::boolean, false);
      if not v_removida then
        return jsonb_build_object('resultado', 'ignorado', 'organization_id', null, 'order_id', null, 'alarme', null, 'erro_codigo', 'pagamento_restaurado');
      end if;
    end if;

    select * into v_rota from public.fn_billing_asaas_rotear_pagamento(
      p_ambiente, nullif(p_confirmacao->>'subscription', ''), nullif(p_confirmacao->>'externalReference', ''), v_payment_id
    );

    if v_rota.categoria = 'renovacao' then
      return jsonb_build_object('resultado', 'ignorado', 'organization_id', v_rota.organization_id, 'order_id', null, 'alarme', null, 'erro_codigo', 'cobranca_de_renovacao');
    end if;

    if v_rota.categoria <> 'pedido' then
      return jsonb_build_object('resultado', v_rota.categoria, 'organization_id', v_rota.organization_id, 'order_id', null, 'alarme', null, 'erro_codigo', null);
    end if;

    select * into v_pedido from public.billing_orders where id = v_rota.pedido_id for update;
    if not found or v_pedido.status = 'pago' then
      return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_rota.organization_id, 'order_id', null, 'alarme', null, 'erro_codigo', null);
    end if;

    if p_evento_tipo = 'PAYMENT_OVERDUE' then
      if v_pedido.status = 'vencido' then
        return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_pedido.organization_id, 'order_id', v_pedido.id, 'alarme', null, 'erro_codigo', null);
      end if;
      update public.billing_orders set status = 'vencido' where id = v_pedido.id;
      -- 1026 (régua de cobrança do pedido): o pedido de ASSINATURA que venceu
      -- NÃO tem a fatura removida no vencimento. Ela segue no Asaas para o
      -- cliente pagar pela régua (lib/email/conta-e-cobranca/regua-de-cobranca.ts),
      -- e quem remove é o passo 3 da conciliação, no prazo de
      -- fn_billing_pedidos_de_assinatura_em_aberto (na suspensão do contrato,
      -- ou em vencimento + carência do plano do pedido). Sem alarme aqui.
      -- Pacote de tokens (não tem plano, carência nem régua) continua com a
      -- remoção imediata: remover_cobranca_pendente.
      return jsonb_build_object(
        'resultado', 'aplicado', 'organization_id', v_pedido.organization_id, 'order_id', v_pedido.id,
        'alarme', case
          when v_pedido.tipo = 'assinatura' then null
          when v_pedido.asaas_subscription_id is not null then 'remover_assinatura_pendente'
          else 'remover_cobranca_pendente'
        end,
        'erro_codigo', null
      );
    else
      if v_pedido.status = 'cancelado' then
        return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_pedido.organization_id, 'order_id', v_pedido.id, 'alarme', null, 'erro_codigo', null);
      end if;
      update public.billing_orders set status = 'cancelado' where id = v_pedido.id;
      return jsonb_build_object('resultado', 'aplicado', 'organization_id', v_pedido.organization_id, 'order_id', v_pedido.id, 'alarme', null, 'erro_codigo', null);
    end if;
  end if;

  if p_evento_tipo not in ('SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_UPDATED') then
    raise exception 'billing_evento_tipo_invalido' using errcode = '22023';
  end if;

  v_subscription_id := nullif(p_confirmacao->>'id', '');
  if v_subscription_id is null then
    raise exception 'billing_subscription_id_obrigatorio' using errcode = '22023';
  end if;

  -- Correção (revisão F5, PARTE 8, item 6): confere também asaas_ambiente =
  -- p_ambiente (mesma defesa do item 10 da PARTE 7).
  select organization_id into v_org_pre from public.billing_contracts where asaas_subscription_id = v_subscription_id and asaas_ambiente = p_ambiente;
  if v_org_pre is null then
    return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', null, 'order_id', null, 'alarme', null);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_org_pre::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || v_org_pre::text, 0));

  select * into v_contract from public.billing_contracts where organization_id = v_org_pre for update;
  if not found or v_contract.asaas_subscription_id is distinct from v_subscription_id or v_contract.asaas_ambiente is distinct from p_ambiente then
    return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org_pre, 'order_id', null, 'alarme', null);
  end if;

  v_org := v_contract.organization_id;
  v_status := nullif(p_confirmacao->>'status', '');

  if p_evento_tipo = 'SUBSCRIPTION_UPDATED' then
    if coalesce(v_status, '') <> 'ACTIVE' then
      return jsonb_build_object('resultado', 'ignorado', 'organization_id', v_org, 'order_id', null, 'alarme', null);
    end if;
    if not coalesce(v_contract.cancel_at_period_end, false) then
      return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'order_id', null, 'alarme', null);
    end if;
    update public.billing_contracts set cancel_at_period_end = false where id = v_contract.id;
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'cancelar_no_fim', 'true', 'false', 'sub_updated_active', null);
    return jsonb_build_object('resultado', 'aplicado', 'organization_id', v_org, 'order_id', null, 'alarme', null);
  end if;

  v_removida := coalesce((p_confirmacao->>'removida')::boolean, false);

  if p_evento_tipo = 'SUBSCRIPTION_DELETED' and not v_removida then
    return jsonb_build_object('resultado', 'aguardando', 'organization_id', v_org, 'order_id', null, 'alarme', null);
  end if;

  if p_evento_tipo = 'SUBSCRIPTION_INACTIVATED' and not v_removida and coalesce(v_status, '') <> 'INACTIVE' then
    if coalesce(v_status, '') = 'ACTIVE' then
      return jsonb_build_object('resultado', 'ignorado', 'organization_id', v_org, 'order_id', null, 'alarme', null, 'erro_codigo', 'assinatura_reativada');
    end if;
    return jsonb_build_object('resultado', 'aguardando', 'organization_id', v_org, 'order_id', null, 'alarme', null, 'erro_codigo', null);
  end if;

  v_cancel_anterior := coalesce(v_contract.cancel_at_period_end, false);

  update public.billing_contracts
     set cancel_at_period_end = true,
         asaas_assinatura_encerrada_em = case
           when p_evento_tipo = 'SUBSCRIPTION_DELETED' or v_removida then coalesce(v_contract.asaas_assinatura_encerrada_em, now())
           else v_contract.asaas_assinatura_encerrada_em
         end
   where id = v_contract.id;

  if not v_cancel_anterior then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'cancelar_no_fim', v_cancel_anterior::text, 'true',
      case when p_evento_tipo = 'SUBSCRIPTION_DELETED' then 'sub_deletada' else 'sub_inativada' end, null);
  end if;

  update public.billing_orders
     set status = 'cancelado'
   where organization_id = v_org
     and asaas_subscription_id = v_subscription_id
     and status in ('criado', 'aguardando_pagamento', 'inconclusivo', 'processando');

  return jsonb_build_object('resultado', 'aplicado', 'organization_id', v_org, 'order_id', null, 'alarme', null);
end;
$$;

comment on function public.fn_billing_asaas_aplicar_fim_da_assinatura(text, jsonb, text) is
  '1026: redefine a versão da 0909, PARTE 8. PAYMENT_OVERDUE de pedido de ASSINATURA marca o pedido vencido SEM alarme de remoção: a fatura segue no Asaas para a régua de cobrança, e quem a remove é o passo 3 da conciliação no prazo de fn_billing_pedidos_de_assinatura_em_aberto. Pacote de tokens segue com remover_cobranca_pendente. Resto idêntico à PARTE 8 (itens 2 e 6). Interna: nenhum grant, nem a service_role.';

revoke execute on function public.fn_billing_asaas_aplicar_fim_da_assinatura(text, jsonb, text) from public, anon, authenticated, service_role;
