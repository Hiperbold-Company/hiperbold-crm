-- 0963, a garantia de 7 dias do reembolso conta por DIA CIVIL de São Paulo (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901). Auditoria de 17/10/2026: fn_billing_reembolso_solicitar comparava
-- `now() - paid_at <= interval '7 days'` (168 horas): quem pagou às 23h tinha o botão até as 23h do dia 8, e quem
-- pagou às 09h perdia o direito às 09h do dia 8, antes de o dia acabar. A regra do produto (direito de arrependimento
-- do CDC) é por dia: até o fim do 7º dia depois do pagamento, no calendário de São Paulo. A função é recriada com a
-- conta `(hoje em SP)::date - (paid_at em SP)::date <= 7`; grants e revokes iguais aos da 0957. Reaplicável.
-- A tela (lib/billing/reembolso/regras.ts, dentroDaGarantia) usa a mesma conta.

set lock_timeout = '3s';

create or replace function public.fn_billing_reembolso_solicitar(
  p_org uuid,
  p_actor uuid,
  p_payment uuid,
  p_detalhe text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_detalhe text := nullif(btrim(coalesce(p_detalhe, '')), '');
  v_contrato public.billing_contracts%rowtype;
  v_pagamento jsonb;
  v_ultimo jsonb;
  v_dentro boolean;
  v_motivo text;
  v_motivo_detalhe text;
  v_id uuid;
begin
  if p_org is null or p_payment is null then
    raise exception 'billing_reembolso_dados_invalidos' using errcode = '22023';
  end if;
  if v_detalhe is not null and char_length(v_detalhe) > 1000 then
    raise exception 'billing_reembolso_detalhe_longo' using errcode = '22023';
  end if;

  -- Trava a linha do contrato: dois pedidos da mesma organização passam um de cada vez pelo teto diário.
  select * into v_contrato from public.billing_contracts where organization_id = p_org for update;
  if not found or not (v_contrato.cancel_at_period_end or v_contrato.status = 'cancelada') then
    raise exception 'billing_reembolso_assinatura_nao_cancelada' using errcode = '22023';
  end if;

  if (select count(*) from public.billing_refund_requests
       where organization_id = p_org and created_at > now() - interval '24 hours') >= 5
  then
    raise exception 'billing_reembolso_limite_diario' using errcode = '22023';
  end if;

  select e into v_pagamento
    from jsonb_array_elements(public.fn_billing_reembolso_elegiveis(p_org)) e
   where e ->> 'payment_id' = p_payment::text;
  -- Pagamento inexistente, de outra organização ou já reembolsado: a mesma resposta para os três.
  if v_pagamento is null then
    raise exception 'billing_reembolso_pagamento_nao_elegivel' using errcode = 'P0002';
  end if;

  -- Só o pagamento MAIS RECENTE (a lista vem do mais novo ao mais antigo).
  v_ultimo := public.fn_billing_reembolso_elegiveis(p_org) -> 0;
  if v_ultimo ->> 'payment_id' <> p_payment::text then
    raise exception 'billing_reembolso_so_o_ultimo_pagamento' using errcode = '22023';
  end if;

  -- A garantia: até 7 dias do pagamento, no relógio do banco. Fora disso não há reembolso.
  -- 0963: o prazo conta DIAS CIVIS de São Paulo, não 168 horas: pago às 23h do dia 1, o cliente tem até o fim do
  -- dia 8 (o direito de arrependimento do CDC fala em dias). Mesma conta de dentroDaGarantia (regras.ts).
  v_dentro := (now() at time zone 'America/Sao_Paulo')::date
              - ((v_pagamento ->> 'paid_at')::timestamptz at time zone 'America/Sao_Paulo')::date <= 7;
  if not v_dentro then
    raise exception 'billing_reembolso_fora_do_prazo' using errcode = '22023';
  end if;

  if (v_pagamento ->> 'pendente')::boolean then
    raise exception 'billing_reembolso_ja_solicitado' using errcode = '22023';
  end if;

  -- O motivo é o do cancelamento mais recente; cancelamento sem motivo registrado (feito antes desta
  -- migration, ou pelo Asaas) vale "outro".
  select f.motivo, f.detalhe into v_motivo, v_motivo_detalhe
    from public.billing_cancel_feedback f
   where f.organization_id = p_org
   order by f.created_at desc
   limit 1;
  v_motivo := coalesce(v_motivo, 'outro');

  begin
    insert into public.billing_refund_requests (
      organization_id, payment_id, order_id, asaas_payment_id, amount_cents, paid_at,
      dentro_7_dias, motivo, detalhe, requested_by
    ) values (
      p_org, p_payment, nullif(v_pagamento ->> 'order_id', '')::uuid, v_pagamento ->> 'asaas_payment_id',
      (v_pagamento ->> 'amount_cents')::integer, (v_pagamento ->> 'paid_at')::timestamptz,
      v_dentro, v_motivo, v_detalhe, p_actor
    ) returning id into v_id;
  exception when unique_violation then
    raise exception 'billing_reembolso_ja_solicitado' using errcode = '22023';
  end;

  return jsonb_build_object(
    'id', v_id,
    'payment_id', p_payment,
    'asaas_payment_id', v_pagamento ->> 'asaas_payment_id',
    'amount_cents', (v_pagamento ->> 'amount_cents')::integer,
    'paid_at', v_pagamento ->> 'paid_at',
    'dentro_7_dias', v_dentro,
    'motivo', v_motivo,
    'motivo_detalhe', v_motivo_detalhe,
    'plano', v_pagamento -> 'plano',
    'pacote', (v_pagamento ->> 'pacote')::boolean,
    'invoice_url', v_pagamento -> 'invoice_url',
    'ambiente', v_pagamento -> 'ambiente'
  );
end;
$$;

comment on function public.fn_billing_reembolso_solicitar(uuid, uuid, uuid, text) is
  '0957/0963: cria o pedido de reembolso (status pendente) do pagamento MAIS RECENTE da organização, desde que elegível e com até 7 DIAS CIVIS (America/Sao_Paulo) desde o pagamento. O motivo é o do cancelamento mais recente (billing_cancel_feedback; sem ele, outro); p_detalhe é a observação opcional do cliente. Recusas 22023: billing_reembolso_assinatura_nao_cancelada (contrato sem cancel_at_period_end e fora de cancelada), billing_reembolso_fora_do_prazo (mais de 7 dias), billing_reembolso_so_o_ultimo_pagamento, billing_reembolso_limite_diario (5 pedidos em 24 horas), billing_reembolso_ja_solicitado (já há pedido aberto), detalhe_longo, dados_invalidos. P0002 billing_reembolso_pagamento_nao_elegivel: pagamento que não existe, é de outra organização ou já foi reembolsado. dentro_7_dias sai do relógio do banco. Só service_role.';

revoke execute on function public.fn_billing_reembolso_solicitar(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_billing_reembolso_solicitar(uuid, uuid, uuid, text) to service_role;

reset lock_timeout;
