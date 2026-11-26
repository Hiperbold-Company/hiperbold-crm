-- manifest: **Régua de cobrança do pedido de assinatura não pago (fork Hiperbold, 26/11/2026).** `billing_orders.vence_em` (date) gravada na criação pelo gatilho `trg_billing_orders_vence_em`; `fn_billing_pedidos_de_assinatura_em_aberto` calcula o prazo de cada pedido em aberto (suspensão do contrato ou vencimento + carência do plano) e o marco da régua; o `PAYMENT_OVERDUE` de pedido de assinatura deixa de pedir a remoção da fatura (`fn_billing_asaas_aplicar_fim_da_assinatura`), e o passo 3 da conciliação só remove no prazo (`fn_billing_pedidos_vencidos_para_remocao`), e já quando o pedido foi superado por cancelamento ou por pagamento de outro caminho; o pedido vencido pago no prazo da régua não leva `pago_fora_do_prazo` (`fn_billing_asaas_aplicar_pagamento`); `fn_billing_regua_de_cobranca_pendentes` e `fn_billing_pedido_gravar_vencimento` servem a régua. Espelho no apêndice do `supabase/baseline.sql`.
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
               and e.para = 'suspensa') as c_suspensa_em,
           -- O contrato ganhou cancelamento DEPOIS do pedido (cancelar no fim do período ou cancelada).
           (coalesce(bc.cancel_at_period_end, false) or bc.status = 'cancelada')
             and exists (
               select 1 from public.billing_contract_eventos e
                where e.contract_id = bc.id
                  and e.criado_em > o.created_at
                  and ((e.tipo = 'cancelar_no_fim' and e.para = 'true') or (e.tipo = 'estado' and e.para = 'cancelada'))
             ) as c_cancelou_depois,
           -- Entrou dinheiro por OUTRO caminho depois do pedido (renovação, parcela, pagamento manual).
           exists (
             select 1 from public.billing_payments bp
              where bp.organization_id = o.organization_id
                and bp.paid_at > o.created_at
                and bp.status in ('CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH')
                and bp.estorna_pagamento_id is null
                -- Só o que concedeu período: pacote de tokens e parcela seguinte de parcelado pago têm período nulo.
                and bp.billing_period_end is not null
                and bp.order_id is distinct from o.id
                -- Pagamento já estornado (linha de estorno apontando para ele) não conta.
                and not exists (select 1 from public.billing_payments r where r.estorna_pagamento_id = bp.id)
           ) as c_pagou_depois
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
           -- Pedido SUPERADO (cancelamento ou pagamento por outro caminho depois dele): sai já, sem marco.
           coalesce(c.c_cancelou_depois, false) or c.c_pagou_depois as superado,
           case when coalesce(c.c_cancelou_depois, false) or c.c_pagou_depois then 'superado'
                when c.suspensa_depois or c.a_caminho then 'suspensao' else 'remocao' end as v_limite,
           case when coalesce(c.c_cancelou_depois, false) or c.c_pagou_depois then c.hoje
                when c.suspensa_depois or c.a_caminho then c.v_suspende_em
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
         -- Superado: já, em qualquer dos dois status (a fatura em aberto cobraria em dobro ou depois do cancelamento).
         (p.superado
           or (p.b_status = 'vencido'
               and case when p.v_limite = 'suspensao' then p.suspensa_depois else p.hoje >= p.v_limite_em end)),
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
         and not p.superado
       order by x.marco_em desc, x.ordem desc
       limit 1
    ) m on true;
$$;

comment on function public.fn_billing_pedidos_de_assinatura_em_aberto(timestamptz, uuid, uuid) is
  '1026: os pedidos de assinatura aguardando_pagamento ou vencido, com cobrança no Asaas, e os prazos de cada um, em datas de America/Sao_Paulo. limite = suspensao quando o contrato chega a suspensa se o pedido não for pago (em curso, suspensão até vencimento + carência) ou foi suspenso depois do pedido; limite_em é o dia da suspensão (current_period_end + grace_days do plano do contrato). limite = remocao no resto (sem contrato ou período, contrato já suspenso ou cancelado na criação, troca abandonada, Pix adiantado); limite_em = vence_em + grace_days do plano do pedido (no mínimo 1). limite = superado quando, depois do pedido, o contrato ganhou cancelamento (evento cancelar_no_fim para true ou estado para cancelada, com o contrato ainda assim) ou entrou pagamento por outro caminho (billing_payments pago, com período concedido, sem estorno, de outro pedido): limite_em = hoje, sem marco, pode_remover já em qualquer status. pode_remover: superado, ou pedido vencido e (suspensao: contrato suspenso depois do pedido; remocao: hoje >= limite_em). marco: o marco da régua que vale hoje, só o mais recente (antes = vence_em - 2, no_dia, depois = vence_em + 2, ultimo_dia = limite_em - 1), nunca no dia da criação nem do limite em diante. Única régua de prazos do passo 3 da conciliação e da régua de cobrança.';

revoke execute on function public.fn_billing_pedidos_de_assinatura_em_aberto(timestamptz, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_pedidos_de_assinatura_em_aberto(timestamptz, uuid, uuid) to service_role;

-- 3. O que o passo 3 da conciliação remove hoje.
drop function if exists public.fn_billing_pedidos_vencidos_para_remocao(timestamptz, integer);
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
  asaas_installment_id text,
  superado boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.r_id, r.r_org, r.r_tipo, r.r_pay, r.r_sub, r.r_inst, r.r_sup
    from (
      -- Pacote de tokens: remoção no vencimento, como antes.
      select o.id as r_id, o.organization_id as r_org, o.tipo as r_tipo,
             o.asaas_payment_id as r_pay, o.asaas_subscription_id as r_sub, o.asaas_installment_id as r_inst,
             false as r_sup
        from public.billing_orders o
       where o.status = 'vencido'
         and o.tipo <> 'assinatura'
         and (o.asaas_payment_id is not null or o.asaas_subscription_id is not null or o.asaas_installment_id is not null)
      union all
      -- Assinatura: só no prazo da régua.
      select a.pedido_id, a.organization_id, 'assinatura'::text,
             a.asaas_payment_id, a.asaas_subscription_id, a.asaas_installment_id,
             (a.limite = 'superado')
        from public.fn_billing_pedidos_de_assinatura_em_aberto(p_agora) a
       where a.pode_remover
    ) r
   limit greatest(coalesce(p_limite, 200), 1);
$$;

comment on function public.fn_billing_pedidos_vencidos_para_remocao(timestamptz, integer) is
  '1026: a lista do passo 3 da conciliação (lib/billing/asaas/conciliar.ts). Pacote de tokens vencido sai como antes; pedido de assinatura só quando fn_billing_pedidos_de_assinatura_em_aberto diz pode_remover (vencido no prazo, ou superado, este também aguardando_pagamento).';

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

-- 7. fn_billing_asaas_aplicar_pagamento REDEFINIDA a partir da última definição (0947): o pedido de assinatura
--    vencido pago dentro do prazo da régua não leva mais pago_fora_do_prazo. Resto do corpo idêntico.
create or replace function public.fn_billing_asaas_aplicar_pagamento(p_confirmacao jsonb, p_ambiente text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id text := nullif(p_confirmacao->>'id', '');
  v_status text := p_confirmacao->>'status';
  v_subscription text := nullif(p_confirmacao->>'subscription', '');
  v_external_reference text := nullif(p_confirmacao->>'externalReference', '');
  v_customer text := nullif(p_confirmacao->>'customer', '');
  v_due_date date;
  v_valor_cents bigint;
  v_pago_em timestamptz;
  v_chave uuid;
  v_ja record;
  v_rota record;
  v_org uuid;
  v_contract record;
  v_pedido record;
  v_plano record;
  v_customer_local text;
  v_esperado_cents bigint;
  v_alarmes text[] := array[]::text[];
  v_payment_row_id uuid;
  v_periodo_inicio timestamptz;
  v_periodo_fim timestamptz;
  v_inicio_do_dia timestamptz;
  v_intervalo interval;
  v_estado_anterior text;
  v_fim_anterior timestamptz;
  v_plan_id_anterior uuid;
  v_cancel_anterior boolean;
  v_novo_fim timestamptz;
  v_novo_status text;
  v_sandbox_concede boolean;
  v_org_sandbox uuid;
  v_installment text := nullif(p_confirmacao->>'installment', '');
  v_total_parcelamento_cents bigint;
  v_comparado_cents bigint;
begin
  if p_ambiente not in ('sandbox', 'producao') then
    raise exception 'billing_ambiente_invalido' using errcode = '22023';
  end if;

  if v_payment_id is null then
    raise exception 'billing_payment_id_obrigatorio' using errcode = '22023';
  end if;

  if coalesce(v_status, '') not in ('CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH') then
    raise exception 'billing_status_nao_confirma_pagamento' using errcode = '22023';
  end if;

  -- Correção (revisão F5, item 11): sandbox nunca concede numa instalação
  -- que não ligou billing_settings.asaas_sandbox_concede (nasce false): a
  -- homologação no sandbox de uma instalação de TESTE liga essa chave; uma
  -- instalação de PRODUÇÃO real nunca concede acesso por um "pagamento" de
  -- sandbox. Sai ANTES de qualquer idempotência, roteamento ou trava: nunca
  -- toca em contrato nem em tokens.
  if p_ambiente = 'sandbox' then
    select coalesce(asaas_sandbox_concede, false) into v_sandbox_concede
      from public.billing_settings where id = 1;
    if not coalesce(v_sandbox_concede, false) then
      select r.organization_id into v_org_sandbox
        from public.fn_billing_asaas_rotear_pagamento(p_ambiente, v_subscription, v_external_reference, v_payment_id) r
       where r.categoria in ('pedido', 'renovacao');
      return jsonb_build_object(
        'resultado', 'ignorado', 'organization_id', v_org_sandbox, 'payment_id', null, 'order_id', null,
        'alarmes', to_jsonb(array['sandbox_nao_concede']), 'erro_codigo', 'sandbox_nao_concede'
      );
    end if;
  end if;

  v_due_date := nullif(p_confirmacao->>'dueDate', '')::date;
  v_valor_cents := round(coalesce(
    (p_confirmacao->>'originalValue')::numeric,
    (p_confirmacao->>'value')::numeric
  ) * 100);
  v_pago_em := coalesce(
    (nullif(p_confirmacao->>'paymentDate', ''))::date::timestamp at time zone 'America/Sao_Paulo',
    (nullif(p_confirmacao->>'confirmedDate', ''))::date::timestamp at time zone 'America/Sao_Paulo',
    now()
  );
  v_chave := md5('HC:asaas:pay:' || v_payment_id)::uuid;

  -- (1) idempotência global, ANTES de qualquer trava (decisão 4/8/B1).
  select id, organization_id, order_id into v_ja
    from public.billing_payments
    where asaas_payment_id = v_payment_id;
  if found then
    return jsonb_build_object(
      'resultado', 'ja_aplicado', 'organization_id', v_ja.organization_id,
      'payment_id', v_ja.id, 'order_id', v_ja.order_id, 'alarmes', '[]'::jsonb
    );
  end if;

  -- (2) roteamento sem trava, só para decidir qual organização travar.
  select * into v_rota
    from public.fn_billing_asaas_rotear_pagamento(p_ambiente, v_subscription, v_external_reference, v_payment_id);

  if v_rota.categoria in ('outro_app', 'sem_vinculo') then
    return jsonb_build_object(
      'resultado', v_rota.categoria, 'organization_id', null,
      'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb
    );
  end if;

  v_org := v_rota.organization_id;

  -- (3) travas na ordem fixa da decisão 12.
  perform pg_advisory_xact_lock(hashtextextended('billing:' || v_org::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || v_org::text, 0));

  select * into v_contract
    from public.billing_contracts
    where organization_id = v_org
    for update;

  if not found then
    return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', null, 'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb);
  end if;

  -- (4) idempotência de novo, sob a trava.
  select id, organization_id, order_id into v_ja
    from public.billing_payments
    where asaas_payment_id = v_payment_id;
  if found then
    return jsonb_build_object(
      'resultado', 'ja_aplicado', 'organization_id', v_ja.organization_id,
      'payment_id', v_ja.id, 'order_id', v_ja.order_id, 'alarmes', '[]'::jsonb
    );
  end if;

  -- (5) roteamento REFEITO sob a trava (decisão 12/B5).
  select * into v_rota
    from public.fn_billing_asaas_rotear_pagamento(p_ambiente, v_subscription, v_external_reference, v_payment_id);

  if v_rota.categoria in ('outro_app', 'sem_vinculo') or v_rota.organization_id is distinct from v_org then
    return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb);
  end if;

  -- (6) cliente confirmado tem que ser o vinculado a ESTA organização e a
  -- ESTE ambiente (decisão 6, última frase).
  if v_customer is not null then
    select asaas_customer_id into v_customer_local
      from public.billing_customers
      where organization_id = v_org and ambiente = p_ambiente;
    if v_customer_local is distinct from v_customer then
      return jsonb_build_object('resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb);
    end if;
  end if;

  if v_rota.categoria = 'pedido' then
    select * into v_pedido
      from public.billing_orders
      where id = v_rota.pedido_id
      for update;

    if not found or (v_pedido.status = 'pago' and v_pedido.parcelas <= 1) then
      return jsonb_build_object('resultado', 'sem_vinculo', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb);
    end if;

    -- 0945 (D-177): parcela SEGUINTE de um parcelamento cujo pedido já está pago. O período foi
    -- concedido uma vez, pela primeira parcela confirmada; esta só entra em billing_payments, ligada
    -- ao pedido, com período nulo (como o pacote de tokens), e não mexe em contrato nem em tokens.
    -- Idempotente pelo asaas_payment_id (índice único) e confere que a cobrança é do MESMO parcelamento.
    if v_pedido.status = 'pago' then
      if v_installment is distinct from v_pedido.asaas_installment_id then
        return jsonb_build_object(
          'resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
          'alarmes', to_jsonb(array['parcela_de_outro_parcelamento'])
        );
      end if;

      begin
        insert into public.billing_payments (
          organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at,
          billing_period_start, billing_period_end, chave, nota, criado_por, origem, order_id
        ) values (
          v_org, v_contract.id, v_payment_id, v_valor_cents, v_status, v_pago_em,
          null, null, v_chave, 'Asaas: parcela do parcelamento', null, 'asaas', v_pedido.id
        )
        returning id into v_payment_row_id;
      exception when unique_violation then
        return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id, 'alarmes', '[]'::jsonb);
      end;

      -- 0947 (B4): o dinheiro da parcela entrou, mas o parcelamento já não existe no Asaas (removido
      -- por alguém). A parcela é registrada e o admin recebe o alarme.
      return jsonb_build_object(
        'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_payment_row_id,
        'order_id', v_pedido.id,
        'alarmes', case
          when coalesce(p_confirmacao->>'parcelamento_removido', '') = 'true'
            then to_jsonb(array['parcelamento_removido_com_pagamento'])
          else '[]'::jsonb
        end
      );
    end if;

    -- 0947 (B4): parcela confirmada de um parcelamento que foi REMOVIDO no Asaas, com o pedido ainda
    -- aberto. Não há total para conferir e não se concede período sobre cobrança que o Asaas apagou:
    -- nada é gravado e o evento fecha divergente com o alarme parcelamento_removido_com_pagamento,
    -- para o admin decidir (o pagamento pode ter entrado).
    if v_pedido.parcelas > 1 and coalesce(p_confirmacao->>'parcelamento_removido', '') = 'true' then
      return jsonb_build_object(
        'resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
        'alarmes', to_jsonb(array['parcelamento_removido_com_pagamento'])
      );
    end if;

    -- (7) valor (decisão 7/M5) e prazo (decisão 4/A1). Pedido PARCELADO (0945, D-177): o valor da
    -- parcela nunca se compara com o preço do plano. Compara-se o TOTAL do parcelamento (GET
    -- /installments/{id}, que o processador manda em parcelamento_total) com o amount_cents do
    -- pedido, e confere que é o parcelamento do pedido e que tem o número de parcelas do pedido.
    v_esperado_cents := v_pedido.amount_cents;
    v_comparado_cents := v_valor_cents;
    if v_pedido.parcelas > 1 then
      v_total_parcelamento_cents := round((nullif(p_confirmacao->>'parcelamento_total', ''))::numeric * 100);
      if v_installment is null or v_total_parcelamento_cents is null then
        return jsonb_build_object(
          'resultado', 'aguardando', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
          'alarmes', '[]'::jsonb, 'erro_codigo', 'billing_parcelamento_sem_total'
        );
      end if;
      if (v_pedido.asaas_installment_id is not null and v_pedido.asaas_installment_id is distinct from v_installment)
        or coalesce((nullif(p_confirmacao->>'parcelamento_parcelas', ''))::integer, 0) <> v_pedido.parcelas
      then
        return jsonb_build_object(
          'resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
          'alarmes', to_jsonb(array['parcelamento_diferente_do_pedido'])
        );
      end if;
      v_comparado_cents := v_total_parcelamento_cents;
    end if;
    if v_comparado_cents < v_esperado_cents then
      return jsonb_build_object('resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id, 'alarmes', '[]'::jsonb);
    end if;
    -- 0947 (M2): o período só é concedido com TODAS as parcelas confirmadas. O processador lista as
    -- parcelas do parcelamento (GET /installments/{id}/payments) e declara quantas estão CONFIRMED,
    -- RECEIVED ou RECEIVED_IN_CASH em parcelamento_confirmadas; o banco confere que são tantas quantas
    -- as parcelas do pedido. Antes disso o evento fica aguardando (nova tentativa com backoff, e a
    -- confirmação das outras parcelas também chega por evento). A contagem ausente conta como zero.
    if v_pedido.parcelas > 1
      and coalesce((nullif(p_confirmacao->>'parcelamento_confirmadas', ''))::integer, 0) < v_pedido.parcelas
    then
      return jsonb_build_object(
        'resultado', 'aguardando', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
        'alarmes', '[]'::jsonb, 'erro_codigo', 'billing_parcelamento_parcelas_pendentes'
      );
    end if;
    if v_comparado_cents > v_esperado_cents then
      v_alarmes := v_alarmes || 'divergente_valor'::text;
    end if;
    -- 1026: pedido de assinatura vencido pago DENTRO do prazo da régua de cobrança (a fatura ainda valia) não é
    -- pago fora do prazo; depois do prazo, ou superado, continua sendo.
    if v_pedido.status not in ('criado', 'aguardando_pagamento', 'inconclusivo', 'processando')
      and not (
        v_pedido.tipo = 'assinatura'
        and v_pedido.status = 'vencido'
        and exists (
          select 1
            from public.fn_billing_pedidos_de_assinatura_em_aberto(v_pago_em, v_pedido.organization_id, v_pedido.id) a
           where not a.pode_remover
        )
      )
    then
      v_alarmes := v_alarmes || 'pago_fora_do_prazo'::text;
    end if;

    if v_pedido.tipo = 'pacote_tokens' then
      -- (8) pacote de tokens: insere PRIMEIRO (decisão 8/B1), período nulo
      -- (decisão 8, CHECK da 0909 já permite; confere o tipo do pedido aqui
      -- porque o CHECK da tabela não consegue), só credita se inseriu.
      begin
        insert into public.billing_payments (
          organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at,
          billing_period_start, billing_period_end, chave, nota, criado_por, origem, order_id
        ) values (
          v_org, v_contract.id, v_payment_id, v_valor_cents, v_status, v_pago_em,
          null, null, v_chave, 'Asaas: pacote de tokens', null, 'asaas', v_pedido.id
        )
        returning id into v_payment_row_id;
      exception when unique_violation then
        return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id, 'alarmes', '[]'::jsonb);
      end;

      perform public.fn_billing_creditar_tokens(v_org, v_pedido.tokens, v_pedido.id, v_pedido.amount_cents, 'Asaas', null);

      update public.billing_orders set status = 'pago', pago_em = now() where id = v_pedido.id;

      return jsonb_build_object(
        'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_payment_row_id,
        'order_id', v_pedido.id, 'alarmes', to_jsonb(v_alarmes)
      );
    end if;

    -- tipo = assinatura: primeiro pagamento de cartão, OU cada ciclo do Pix
    -- semestral ou anual (decisão 2: Pix não tem assinatura Asaas, cada renovação é um
    -- pedido novo, roteado aqui como categoria=pedido, não renovacao).
    --
    -- Correção (revisão F5, item 4): contrato já com OUTRA assinatura Asaas
    -- viva (sem o marcador de encerramento) e DIFERENTE da desta cobrança
    -- nunca concede: seria duplicar a cobrança do cliente. fn_billing_criar_
    -- pedido (Tarefa 3) já bloqueia isso na CRIAÇÃO do pedido; esta é a
    -- defesa em profundidade na APLICAÇÃO (evento atrasado, corrida, ou uma
    -- duplicação criada por outro caminho).
    if v_contract.asaas_subscription_id is not null
      and v_contract.asaas_assinatura_encerrada_em is null
      and v_contract.asaas_subscription_id is distinct from v_subscription
    then
      return jsonb_build_object(
        'resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
        'alarmes', to_jsonb(array['assinatura_duplicada'])
      );
    end if;

    -- 0942: defesa em profundidade da recusa de troca de plano de fn_billing_criar_pedido. Se um
    -- pagamento de pedido de OUTRO plano chegar com período pago vigente (pedido criado antes de
    -- existir o período, evento atrasado, corrida), o plano não troca na hora: o contrato fica
    -- como está, nada é gravado e o admin recebe o alarme troca_de_plano_com_periodo_vigente.
    if v_contract.status = 'ativa'
      and v_contract.plan_id is distinct from v_pedido.plan_id
      and v_contract.current_period_end is not null
      and v_contract.current_period_end > now()
      and exists (
        select 1 from public.billing_payments p
         where p.organization_id = v_org
           and p.status in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
           and p.billing_period_end > now()
           and not exists (
             select 1 from public.billing_payments r
              where r.estorna_pagamento_id = p.id and r.status = 'REFUNDED'
           )
      )
    then
      return jsonb_build_object(
        'resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id,
        'alarmes', to_jsonb(array['troca_de_plano_com_periodo_vigente'])
      );
    end if;

    if (v_pedido.metodo = 'PIX' or v_pedido.parcelas > 1) and v_pedido.ciclo in ('semiannual', 'yearly') then
      -- 0945 (D-177): o parcelamento do cartão (cobrança avulsa, sem assinatura) conta o período
      -- como o Pix: a primeira parcela confirmada concede os 6 ou 12 meses, uma vez só.
      -- Decisão 5, regra especial do Pix semestral e anual. Sem período pago a frente, o período
      -- começa no dia do pagamento e vai até o mesmo dia do ciclo seguinte MAIS UM DIA (limite
      -- exclusivo, a mesma conta do cartão: o último dia pago inclui o dia do vencimento). Com
      -- período pago a frente, o novo empilha: começa em current_period_end (que já é esse
      -- limite) e dura exatamente seis meses ou um ano, SEM o dia extra (0942: cada compra
      -- empilhada ganhava um dia de graça). Correção (revisão F5, item 13): paymentDate nulo usa
      -- o INÍCIO DO DIA em SP, nunca now() (que traria hora exata e quebraria a normalização de
      -- período sempre à meia-noite).
      v_inicio_do_dia := coalesce(
        (nullif(p_confirmacao->>'paymentDate', ''))::date,
        (now() at time zone 'America/Sao_Paulo')::date
      )::timestamp at time zone 'America/Sao_Paulo';
      v_intervalo := case v_pedido.ciclo when 'semiannual' then interval '6 months' else interval '1 year' end;
      if v_contract.current_period_end is not null and v_contract.current_period_end > v_inicio_do_dia then
        v_periodo_inicio := v_contract.current_period_end;
        v_periodo_fim := v_periodo_inicio + v_intervalo;
      else
        v_periodo_inicio := v_inicio_do_dia;
        v_periodo_fim := v_periodo_inicio + v_intervalo + interval '1 day';
      end if;
    else
      select periodo_inicio, periodo_fim into v_periodo_inicio, v_periodo_fim
        from public.fn_billing_asaas_periodo_do_ciclo(v_due_date, v_pedido.ciclo);
    end if;

    begin
      insert into public.billing_payments (
        organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at,
        billing_period_start, billing_period_end, chave, nota, criado_por, origem, order_id
      ) values (
        v_org, v_contract.id, v_payment_id, v_valor_cents, v_status, v_pago_em,
        v_periodo_inicio, v_periodo_fim, v_chave,
        case when v_pedido.parcelas > 1 then 'Asaas: assinatura parcelada' else 'Asaas: assinatura' end,
        null, 'asaas', v_pedido.id
      )
      returning id into v_payment_row_id;
    exception when unique_violation then
      return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', null, 'order_id', v_pedido.id, 'alarmes', '[]'::jsonb);
    end;

    -- Decisão 8: só estende/troca de plano se o insert acima deu certo
    -- (chegamos até aqui, então deu). current_period_end = greatest(atual,
    -- fim), evento velho nunca encurta (decisão 5/B9). Correção (revisão F5,
    -- item 5): só volta a ativa quando o NOVO FIM é posterior a now(); o
    -- reprocesso de um evento velho, cujo período já passou, nunca ativa um
    -- contrato que devia continuar do jeito que estava.
    v_estado_anterior := v_contract.status;
    v_fim_anterior := v_contract.current_period_end;
    v_plan_id_anterior := v_contract.plan_id;
    v_novo_fim := greatest(v_contract.current_period_end, v_periodo_fim);
    v_novo_status := case when v_novo_fim > now() then 'ativa' else v_contract.status end;

    -- Correção (revisão F5, item 10): asaas_ambiente gravado JUNTO com
    -- asaas_subscription_id, no primeiro pagamento; fn_billing_asaas_rotear_
    -- pagamento (acima) só casa uma renovação do MESMO ambiente do evento.
    update public.billing_contracts
      set plan_id = v_pedido.plan_id,
          cycle = v_pedido.ciclo,
          gateway = 'asaas',
          -- 0942: cobrança avulsa (Pix) depois de encerrar a assinatura do cartão não leva o id da
          -- assinatura encerrada para o contrato: id e marcador saem juntos. Contrato sem
          -- assinatura continua sem (o ramo de assinatura viva diferente já saiu acima).
          asaas_subscription_id = case
            when v_subscription is not null then v_subscription
            when v_contract.asaas_assinatura_encerrada_em is not null then null
            else v_contract.asaas_subscription_id
          end,
          asaas_ambiente = p_ambiente,
          asaas_assinatura_encerrada_em = case
            when v_subscription is not null or v_contract.asaas_assinatura_encerrada_em is not null then null
            else v_contract.asaas_assinatura_encerrada_em
          end,
          cancel_at_period_end = false,
          -- 0942: o início do período do contrato nunca vai para o futuro (o Pix empilhado começa
          -- em current_period_end; o início do contrato continua o do período em andamento).
          current_period_start = case
            when v_periodo_inicio <= now() then v_periodo_inicio
            else least(coalesce(v_contract.current_period_start, now()), now())
          end,
          current_period_end = v_novo_fim,
          status = v_novo_status
      where id = v_contract.id;

    if v_estado_anterior <> v_novo_status then
      insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
      values (v_org, v_contract.id, 'estado', v_estado_anterior, v_novo_status, 'pay_primeiro_pagamento', null);
    end if;
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'periodo', v_fim_anterior::text, v_novo_fim::text, 'pay_primeiro_pagamento', null);
    if v_plan_id_anterior is distinct from v_pedido.plan_id then
      insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
      values (v_org, v_contract.id, 'plano', v_plan_id_anterior::text, v_pedido.plan_id::text, 'pay_primeiro_pagamento', null);
    end if;

    -- D-086 (0916): conta reativada por pagamento depois de um corte por estorno
    -- recupera a carência de uma conta normal.
    if v_estado_anterior = 'cancelada' and v_novo_status = 'ativa' then
      perform public.fn_billing_asaas_devolver_carencia(v_org, v_contract.id);
    end if;

    -- 0945: o pedido parcelado guarda o id do parcelamento que concedeu (quando o registro da cobrança
    -- ainda não o tinha gravado).
    update public.billing_orders
       set status = 'pago', pago_em = now(),
           asaas_installment_id = case when parcelas > 1 then coalesce(asaas_installment_id, v_installment) else asaas_installment_id end
     where id = v_pedido.id;

    return jsonb_build_object(
      'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_payment_row_id,
      'order_id', v_pedido.id, 'alarmes', to_jsonb(v_alarmes)
    );
  end if;

  -- categoria = renovacao: contrato já com assinatura Asaas de cartão ativa,
  -- sem pedido nenhum envolvido.
  select * into v_plano from public.billing_plans where id = v_contract.plan_id;
  if not found then
    raise exception 'billing_plano_do_contrato_nao_encontrado' using errcode = 'P0002';
  end if;

  v_esperado_cents := case v_contract.cycle
    when 'yearly' then v_plano.price_yearly_cents
    when 'semiannual' then v_plano.price_semiannual_cents
    else v_plano.price_monthly_cents
  end;
  -- 0942: renovação com valor ABAIXO do preço do ciclo do contrato não estende o período
  -- (divergente, como o pedido de valor menor): o cliente pagou menos do que o ciclo custa e o
  -- admin decide. Valor acima segue concedendo com o alarme divergente_valor.
  if v_esperado_cents is not null and v_valor_cents < v_esperado_cents then
    return jsonb_build_object(
      'resultado', 'divergente', 'organization_id', v_org, 'payment_id', null, 'order_id', null,
      'alarmes', to_jsonb(array['renovacao_valor_abaixo_do_ciclo'])
    );
  end if;
  if v_esperado_cents is not null and v_valor_cents > v_esperado_cents then
    v_alarmes := v_alarmes || 'divergente_valor'::text;
  end if;

  select periodo_inicio, periodo_fim into v_periodo_inicio, v_periodo_fim
    from public.fn_billing_asaas_periodo_do_ciclo(v_due_date, coalesce(v_contract.cycle, 'monthly'));

  begin
    insert into public.billing_payments (
      organization_id, contract_id, asaas_payment_id, gross_cents, status, paid_at,
      billing_period_start, billing_period_end, chave, nota, criado_por, origem, order_id
    ) values (
      v_org, v_contract.id, v_payment_id, v_valor_cents, v_status, v_pago_em,
      v_periodo_inicio, v_periodo_fim, v_chave, 'Asaas: renovacao', null, 'asaas', null
    )
    returning id into v_payment_row_id;
  exception when unique_violation then
    return jsonb_build_object('resultado', 'ja_aplicado', 'organization_id', v_org, 'payment_id', null, 'order_id', null, 'alarmes', '[]'::jsonb);
  end;

  -- Correção (revisão F5, item 5): mesmo cuidado da branch acima, só volta a
  -- ativa quando o novo fim é posterior a now().
  v_estado_anterior := v_contract.status;
  v_fim_anterior := v_contract.current_period_end;
  v_cancel_anterior := v_contract.cancel_at_period_end;
  v_novo_fim := greatest(v_contract.current_period_end, v_periodo_fim);
  v_novo_status := case when v_novo_fim > now() then 'ativa' else v_contract.status end;

  update public.billing_contracts
    set current_period_start = greatest(v_contract.current_period_start, least(v_periodo_inicio, now())),
        current_period_end = v_novo_fim,
        status = v_novo_status,
        cancel_at_period_end = case when coalesce(p_confirmacao->>'assinatura_status', '') = 'ACTIVE' then false else cancel_at_period_end end
    where id = v_contract.id;

  if v_estado_anterior <> v_novo_status then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'estado', v_estado_anterior, v_novo_status, 'pay_renovacao', null);
  end if;
  insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
  values (v_org, v_contract.id, 'periodo', v_fim_anterior::text, v_novo_fim::text, 'pay_renovacao', null);
  if v_cancel_anterior and coalesce(p_confirmacao->>'assinatura_status', '') = 'ACTIVE' then
    insert into public.billing_contract_eventos (organization_id, contract_id, tipo, de, para, motivo, actor)
    values (v_org, v_contract.id, 'cancelar_no_fim', 'true', 'false', 'pay_renovacao', null);
  end if;

  -- D-086 (0916): mesma devolução da carência do primeiro pagamento.
  if v_estado_anterior = 'cancelada' and v_novo_status = 'ativa' then
    perform public.fn_billing_asaas_devolver_carencia(v_org, v_contract.id);
  end if;

  return jsonb_build_object(
    'resultado', 'aplicado', 'organization_id', v_org, 'payment_id', v_payment_row_id,
    'order_id', null, 'alarmes', to_jsonb(v_alarmes)
  );
end;
$$;

comment on function public.fn_billing_asaas_aplicar_pagamento(jsonb, text) is
  '1026: pedido de assinatura vencido pago dentro do prazo da régua de cobrança (fn_billing_pedidos_de_assinatura_em_aberto sem pode_remover) não leva o alarme pago_fora_do_prazo. 0909, PARTE 7 (itens 4, 5, 10, 11, 13), redefinida na 0916 (D-086), na 0941 (D-176), na 0942 (auditoria do lote 15), na 0945 (parcelamento, D-177) e na 0947 (D-177, auditoria da parte 1). PARCELAMENTO (pedido com parcelas > 1, cobrança avulsa do cartão sem assinatura): cada parcela confirmada leva o externalReference do pedido e o id do parcelamento em p_confirmacao.installment. A PRIMEIRA parcela confirmada concede o período, uma vez por parcelamento, mas SÓ quando todas as parcelas do pedido estão confirmadas (0947: parcelamento_confirmadas, declarado pelo processador depois de listar as parcelas no Asaas, tem de ser pelo menos parcelas do pedido; senão aguardando, billing_parcelamento_parcelas_pendentes), com a conta do Pix (6 ou 12 meses a partir do dia do pagamento mais um dia, ou empilhando a partir de current_period_end sem o dia extra), e fecha o pedido. A conferência de valor NÃO compara o valor da parcela com o preço: compara parcelamento_total (GET /installments/{id}, em reais) com billing_orders.amount_cents, e recusa (divergente) parcelamento de outro id ou com número de parcelas diferente do pedido; sem installment ou sem parcelamento_total devolve aguardando (billing_parcelamento_sem_total) para o processador tentar de novo. As parcelas SEGUINTES (pedido já pago) entram em billing_payments ligadas ao pedido, com período nulo e a nota Asaas: parcela do parcelamento, sem mexer em contrato nem em tokens; idempotentes pelo asaas_payment_id, e parcela de outro parcelamento é divergente (parcela_de_outro_parcelamento). Parcelamento removido no Asaas com parcela confirmada (parcelamento_removido, 0947): pedido aberto não concede e fecha divergente, pedido já pago registra a parcela, os dois com o alarme parcelamento_removido_com_pagamento. Pix semestral soma 6 meses e Pix anual 1 ano; o Pix que começa no dia do pagamento leva um dia a mais (limite exclusivo, como o cartão) e o Pix EMPILHADO sobre período pago a frente começa em current_period_end e dura exatamente 6 meses ou 1 ano, sem o dia extra. O início do período do contrato nunca é gravado no futuro. Pedido de OUTRO plano com período pago vigente não troca o plan_id (divergente, alarme troca_de_plano_com_periodo_vigente, nada gravado). A renovação confere o valor contra o preço do ciclo do contrato (mensal, semestral ou anual): abaixo do preço não estende o período (divergente, alarme renovacao_valor_abaixo_do_ciclo), acima concede com divergente_valor. Cobrança avulsa depois de encerrar a assinatura do cartão limpa o id e o marcador da assinatura encerrada. Devolução da carência quando o pagamento reativa um contrato cancelado (fn_billing_asaas_devolver_carencia). Sandbox só concede com billing_settings.asaas_sandbox_concede ligada, checado antes de tudo; contrato com outra assinatura Asaas viva e diferente não concede (alarme assinatura_duplicada); status ativa só quando o novo current_period_end é posterior a now(); asaas_ambiente gravado com asaas_subscription_id no primeiro pagamento; Pix com paymentDate nulo usa o início do dia em America/Sao_Paulo.';

revoke execute on function public.fn_billing_asaas_aplicar_pagamento(jsonb, text) from public, anon, authenticated, service_role;
