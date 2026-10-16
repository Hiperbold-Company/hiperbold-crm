-- 0957, motivo do cancelamento e pedido de reembolso feitos pelo cliente (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisões do dono do produto (15/10/2026):
--   * Ao CANCELAR a assinatura, o administrador da organização diz por quê (motivo de um vocabulário fechado,
--     mais um texto livre opcional): pesquisa de cancelamento, para todo mundo. Fica em billing_cancel_feedback.
--   * Depois de cancelar, em Configurações › Meu plano, o administrador pode PEDIR o reembolso do pagamento mais
--     recente, e só se ele tiver até 7 dias (garantia / direito de arrependimento do CDC). Fora dos 7 dias não
--     há reembolso. O pedido não devolve dinheiro: avisa a Hiperbold (e-mail ao financeiro e lista no admin da
--     plataforma), que reembolsa no Asaas; o cliente é avisado por e-mail quando o estorno é concluído.
--
-- O que esta migration faz:
--   1. billing_cancel_feedback: o motivo de cada cancelamento (organização, motivo, detalhe, quem, quando).
--      RLS: o administrador da organização lê os da própria; a escrita é só de fn_billing_cancelamento_motivo_registrar.
--   2. billing_refund_requests: um pedido por pagamento ABERTO (índice único parcial em status = 'pendente').
--      Guarda a referência do pagamento (id interno, pedido e id do Asaas), o valor e a data fotografados na
--      hora do pedido, dentro_7_dias (calculado no relógio do banco), o motivo (o do cancelamento), o texto
--      livre opcional e o desfecho: pendente, concluido (o Asaas avisou o estorno, ou o admin marcou à mão) ou
--      recusado (uso manual do admin). RLS: o administrador da organização LÊ os da própria; ninguém escreve
--      pelo PostgREST.
--   3. fn_billing_reembolso_elegiveis(org): os pagamentos que podem ser reembolsados, fonte única da tela e da
--      função que cria o pedido. Elegível = pagamento do Asaas (origem asaas, CONFIRMED ou RECEIVED) sem linha
--      de estorno apontando para ele e sem pedido concluído.
--   4. fn_billing_reembolso_solicitar: cria o pedido. Recusa quando a assinatura não está cancelada, quando o
--      pagamento não é elegível (ou é de outra organização: mesma resposta), quando não é o mais recente, quando
--      passou de 7 dias, quando já há pedido aberto e depois de 5 pedidos da organização em 24 horas.
--   5. fn_billing_reembolso_concluir_por_pagamento: chamada pelo processamento do webhook PAYMENT_REFUNDED
--      confirmado; fecha como concluido o pedido aberto daquele pagamento.
--   6. fn_billing_reembolso_resolver: o admin da plataforma recusa um pedido aberto ou o marca como concluído
--      (reembolso feito fora do fluxo).
--   7. billing_emails_enviados.destino ganha 'financeiro': o e-mail do pedido vai SÓ a quem cuida do financeiro
--      (EMAIL_DO_FINANCEIRO, ou, vazio, os mesmos da cópia dos avisos), e não aos administradores da organização.
--
-- Reaplicável com o app no ar e sobre a versão anterior: create table if not exists, constraints só quando
-- faltam, create or replace, lock_timeout curto, e uma transação única fecha a janela em que as tabelas e as
-- funções novas teriam o ACL padrão do Supabase.

set lock_timeout = '3s';

-- ── 1. billing_cancel_feedback ──
create table if not exists public.billing_cancel_feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  motivo text not null,
  detalhe text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint billing_cancel_feedback_motivo_valido check (
    motivo in ('nao_usei_como_esperava', 'preco', 'faltou_recurso', 'contratei_por_engano', 'outro')
  ),
  constraint billing_cancel_feedback_detalhe_tamanho check (detalhe is null or char_length(detalhe) <= 1000)
);

comment on table public.billing_cancel_feedback is
  '0957: o motivo que o administrador da organização informou ao cancelar a assinatura (pesquisa de cancelamento). Vocabulário fechado em motivo; detalhe é texto livre opcional (até 1000 caracteres, nunca vai para auditoria nem log). RLS: o admin da organização lê os da própria organização; a escrita é só de fn_billing_cancelamento_motivo_registrar (service_role).';

create index if not exists billing_cancel_feedback_org_idx
  on public.billing_cancel_feedback (organization_id, created_at desc);
create index if not exists billing_cancel_feedback_recentes_idx
  on public.billing_cancel_feedback (created_at desc);

alter table public.billing_cancel_feedback enable row level security;

revoke all on public.billing_cancel_feedback from anon, authenticated;
grant select on public.billing_cancel_feedback to authenticated;
grant select, insert on public.billing_cancel_feedback to service_role;
revoke update, delete, truncate on public.billing_cancel_feedback from service_role;

drop policy if exists billing_cancel_feedback_admin_select on public.billing_cancel_feedback;
create policy billing_cancel_feedback_admin_select
  on public.billing_cancel_feedback
  for select
  to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );

create or replace function public.fn_billing_cancelamento_motivo_registrar(
  p_org uuid,
  p_actor uuid,
  p_motivo text,
  p_detalhe text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_detalhe text := nullif(btrim(coalesce(p_detalhe, '')), '');
  v_id uuid;
begin
  if p_org is null then
    raise exception 'billing_cancelamento_dados_invalidos' using errcode = '22023';
  end if;
  if p_motivo is null
     or p_motivo not in ('nao_usei_como_esperava', 'preco', 'faltou_recurso', 'contratei_por_engano', 'outro')
  then
    raise exception 'billing_cancelamento_motivo_invalido' using errcode = '22023';
  end if;
  if v_detalhe is not null and char_length(v_detalhe) > 1000 then
    raise exception 'billing_cancelamento_detalhe_longo' using errcode = '22023';
  end if;

  insert into public.billing_cancel_feedback (organization_id, motivo, detalhe, created_by)
  values (p_org, p_motivo, v_detalhe, p_actor)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.fn_billing_cancelamento_motivo_registrar(uuid, uuid, text, text) is
  '0957: grava o motivo do cancelamento (vocabulário fechado + texto livre opcional de até 1000 caracteres). 22023: motivo_invalido, detalhe_longo, dados_invalidos. Só service_role.';

revoke execute on function public.fn_billing_cancelamento_motivo_registrar(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_billing_cancelamento_motivo_registrar(uuid, uuid, text, text) to service_role;

-- ── 2. billing_refund_requests ──
create table if not exists public.billing_refund_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payment_id uuid not null references public.billing_payments(id) on delete cascade,
  order_id uuid references public.billing_orders(id) on delete set null,
  asaas_payment_id text not null,
  amount_cents integer not null,
  paid_at timestamptz not null,
  dentro_7_dias boolean not null,
  motivo text not null,
  detalhe text,
  status text not null default 'pendente',
  requested_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  constraint billing_refund_requests_asaas_payment_id_formato check (asaas_payment_id ~ '^pay_'),
  constraint billing_refund_requests_amount_positivo check (amount_cents > 0),
  constraint billing_refund_requests_motivo_valido check (
    motivo in ('nao_usei_como_esperava', 'preco', 'faltou_recurso', 'contratei_por_engano', 'outro')
  ),
  constraint billing_refund_requests_detalhe_tamanho check (detalhe is null or char_length(detalhe) <= 1000),
  constraint billing_refund_requests_status_valido check (status in ('pendente', 'concluido', 'recusado')),
  constraint billing_refund_requests_resolucao_coerente check (
    (status = 'pendente' and resolved_at is null) or (status <> 'pendente' and resolved_at is not null)
  )
);

comment on table public.billing_refund_requests is
  '0957: pedido de reembolso feito pelo administrador da organização depois de cancelar a assinatura, só do pagamento mais recente e só até 7 dias dele. Não devolve dinheiro: avisa a Hiperbold, que reembolsa no Asaas. Um pedido ABERTO (pendente) por pagamento (índice único parcial); concluido vem do webhook PAYMENT_REFUNDED ou do admin da plataforma; recusado é uso manual do admin. motivo é o do cancelamento. dentro_7_dias é calculado no relógio do banco na hora do pedido. RLS: o admin da organização lê os da própria organização; a escrita é só das funções fn_billing_reembolso_* (service_role).';
comment on column public.billing_refund_requests.dentro_7_dias is
  '0957: o pagamento tinha no máximo 7 dias na hora do pedido (garantia / direito de arrependimento do CDC). Fora disso o banco recusa o pedido.';
comment on column public.billing_refund_requests.detalhe is
  '0957: observação opcional do cliente no pedido (até 1000 caracteres). Nunca vai para auditoria nem para log.';

create unique index if not exists billing_refund_requests_pendente_por_pagamento_unique
  on public.billing_refund_requests (payment_id)
  where status = 'pendente';

create index if not exists billing_refund_requests_fila_idx
  on public.billing_refund_requests (status, created_at desc);

create index if not exists billing_refund_requests_org_idx
  on public.billing_refund_requests (organization_id, created_at desc);

create index if not exists billing_refund_requests_asaas_payment_idx
  on public.billing_refund_requests (asaas_payment_id);

alter table public.billing_refund_requests enable row level security;

revoke all on public.billing_refund_requests from anon, authenticated;
grant select on public.billing_refund_requests to authenticated;
grant select, insert, update on public.billing_refund_requests to service_role;
revoke delete, truncate on public.billing_refund_requests from service_role;

drop policy if exists billing_refund_requests_admin_select on public.billing_refund_requests;
create policy billing_refund_requests_admin_select
  on public.billing_refund_requests
  for select
  to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );

-- ── 3. Os pagamentos que podem ser reembolsados ──
create or replace function public.fn_billing_reembolso_elegiveis(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(x.linha order by x.paid_at desc, x.id), '[]'::jsonb)
  from (
    select p.paid_at, p.id,
           jsonb_build_object(
             'payment_id', p.id,
             'order_id', p.order_id,
             'asaas_payment_id', p.asaas_payment_id,
             'amount_cents', p.gross_cents,
             'paid_at', p.paid_at,
             'pacote', coalesce(o.tipo = 'pacote_tokens', false),
             'plano', case when coalesce(o.tipo = 'pacote_tokens', false) then null else pl.name end,
             'invoice_url', o.invoice_url,
             'ambiente', o.ambiente,
             'pendente', exists (
               select 1 from public.billing_refund_requests r
                where r.payment_id = p.id and r.status = 'pendente'
             )
           ) as linha
      from public.billing_payments p
      left join public.billing_orders o on o.id = p.order_id
      left join public.billing_contracts c on c.organization_id = p.organization_id
      left join public.billing_plans pl on pl.id = coalesce(o.plan_id, c.plan_id)
     where p.organization_id = p_org
       and p.origem = 'asaas'
       and p.asaas_payment_id is not null
       and p.status in ('CONFIRMED', 'RECEIVED')
       and not exists (
         select 1 from public.billing_payments e
          where e.organization_id = p.organization_id and e.estorna_pagamento_id = p.id
       )
       and not exists (
         select 1 from public.billing_refund_requests r
          where r.payment_id = p.id and r.status = 'concluido'
       )
  ) x;
$$;

comment on function public.fn_billing_reembolso_elegiveis(uuid) is
  '0957: os pagamentos da organização que podem ser reembolsados (jsonb array, do mais recente ao mais antigo): origem asaas com id do Asaas, status CONFIRMED ou RECEIVED, sem linha de estorno apontando para ele e sem pedido concluído. "pendente" diz que já há pedido aberto para o pagamento. Fonte única da tela e de fn_billing_reembolso_solicitar. Só service_role.';

revoke execute on function public.fn_billing_reembolso_elegiveis(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_reembolso_elegiveis(uuid) to service_role;

-- ── 4. Criar o pedido ──
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
  v_dentro := now() - (v_pagamento ->> 'paid_at')::timestamptz <= interval '7 days';
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
  '0957: cria o pedido de reembolso (status pendente) do pagamento MAIS RECENTE da organização, desde que elegível e com até 7 dias. O motivo é o do cancelamento mais recente (billing_cancel_feedback; sem ele, outro); p_detalhe é a observação opcional do cliente. Recusas 22023: billing_reembolso_assinatura_nao_cancelada (contrato sem cancel_at_period_end e fora de cancelada), billing_reembolso_fora_do_prazo (mais de 7 dias), billing_reembolso_so_o_ultimo_pagamento, billing_reembolso_limite_diario (5 pedidos em 24 horas), billing_reembolso_ja_solicitado (já há pedido aberto), detalhe_longo, dados_invalidos. P0002 billing_reembolso_pagamento_nao_elegivel: pagamento que não existe, é de outra organização ou já foi reembolsado. dentro_7_dias sai do relógio do banco. Só service_role.';

revoke execute on function public.fn_billing_reembolso_solicitar(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_billing_reembolso_solicitar(uuid, uuid, uuid, text) to service_role;

-- ── 5. O Asaas confirmou o estorno ──
create or replace function public.fn_billing_reembolso_concluir_por_pagamento(
  p_org uuid,
  p_asaas_payment_id text
)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_linhas integer;
begin
  update public.billing_refund_requests
     set status = 'concluido', resolved_at = now()
   where organization_id = p_org
     and asaas_payment_id = p_asaas_payment_id
     and status = 'pendente';
  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_billing_reembolso_concluir_por_pagamento(uuid, text) is
  '0957: fecha como concluido o pedido ABERTO do pagamento (organização + id do Asaas) quando o processamento do webhook confirma o estorno total. Devolve quantos pedidos fechou (0 = não havia pedido aberto). Idempotente. Só service_role.';

revoke execute on function public.fn_billing_reembolso_concluir_por_pagamento(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_billing_reembolso_concluir_por_pagamento(uuid, text) to service_role;

-- ── 6. O admin da plataforma resolve ──
create or replace function public.fn_billing_reembolso_resolver(
  p_request uuid,
  p_status text,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_pedido public.billing_refund_requests%rowtype;
begin
  if p_status is null or p_status not in ('concluido', 'recusado') then
    raise exception 'billing_reembolso_status_invalido' using errcode = '22023';
  end if;

  select * into v_pedido from public.billing_refund_requests where id = p_request for update;
  if not found then
    raise exception 'billing_reembolso_nao_encontrado' using errcode = 'P0002';
  end if;
  if v_pedido.status <> 'pendente' then
    raise exception 'billing_reembolso_ja_resolvido' using errcode = '22023';
  end if;

  update public.billing_refund_requests
     set status = p_status, resolved_at = now(), resolved_by = p_actor
   where id = p_request;

  return jsonb_build_object(
    'id', v_pedido.id,
    'organization_id', v_pedido.organization_id,
    'asaas_payment_id', v_pedido.asaas_payment_id,
    'amount_cents', v_pedido.amount_cents,
    'status_anterior', v_pedido.status,
    'status_novo', p_status
  );
end;
$$;

comment on function public.fn_billing_reembolso_resolver(uuid, text, uuid) is
  '0957: o admin da plataforma recusa (recusado) um pedido aberto ou o marca como concluído (reembolso feito fora do fluxo). Só pedido pendente: o já resolvido é 22023 billing_reembolso_ja_resolvido; inexistente é P0002 billing_reembolso_nao_encontrado. Só service_role.';

revoke execute on function public.fn_billing_reembolso_resolver(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_reembolso_resolver(uuid, text, uuid) to service_role;

-- ── 7. O e-mail do financeiro: destino 'financeiro' ──
do $destino_financeiro$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'billing_emails_enviados_destino_valido'
       and conrelid = 'public.billing_emails_enviados'::regclass
       and pg_get_constraintdef(oid) like '%financeiro%'
  ) then
    alter table public.billing_emails_enviados drop constraint if exists billing_emails_enviados_destino_valido;
    alter table public.billing_emails_enviados
      add constraint billing_emails_enviados_destino_valido
      check (destino in ('admins', 'criador', 'financeiro'));
  end if;
end
$destino_financeiro$;

comment on column public.billing_emails_enviados.destino is
  '0957: admins (administradores da organização), criador (quem criou o fato) ou financeiro (SÓ quem cuida do financeiro da instalação: EMAIL_DO_FINANCEIRO ou, vazio, os mesmos de EMAIL_DE_COPIA_DOS_AVISOS e os administradores da plataforma; em português, com a marca da instalação).';

do $agent_worker_reembolso$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke select, insert, update, delete, truncate on public.billing_refund_requests, public.billing_cancel_feedback from agent_worker';
    execute 'revoke execute on function public.fn_billing_reembolso_elegiveis(uuid), public.fn_billing_reembolso_solicitar(uuid, uuid, uuid, text), public.fn_billing_reembolso_concluir_por_pagamento(uuid, text), public.fn_billing_reembolso_resolver(uuid, text, uuid), public.fn_billing_cancelamento_motivo_registrar(uuid, uuid, text, text) from agent_worker';
  end if;
end
$agent_worker_reembolso$;


reset lock_timeout;
