-- 1016, desligar e religar um módulo de tabela sem perder dados (fork Hiperbold, pedido do dono 17/11/2026).
--
-- Até aqui um módulo de tabela (ADR-0002: hoje `honorarios` e `financeiro`/Comandas) só tinha a porta
-- de entrada, `fn_modulo_instalar`. O dono pediu o botão "Desligar" (e "Ligar de novo") em
-- `/admin/modulos`. A doutrina de extensões manda que tirar seja LÓGICO e preserve dados: desligar
-- não apaga tabela nem linha, só troca o estado.
--
-- O que muda:
--  1. `modulos_instalados.estado` ganha o valor `desligado`. O app só liga o módulo com
--     `estado = 'ativo'` (`lib/instalacao/modulos.ts`), então desligado = telas, rotas, navegação e
--     tools MCP somem, e as tabelas ficam onde estão.
--  2. `extension_operations.kind` ganha `module_disable` e `module_enable`: o recibo mora no mesmo
--     livro do `module_install`, com a mesma chave idempotente.
--  3. `fn_modulo_definir_estado(p_actor, p_operation, p_modulo, p_ligar, p_estado_visto)`, só de
--     `service_role`: confere o ator como admin de plataforma (a mesma régua do instalar), pega a
--     mesma trava, é idempotente pelo recibo e exige o estado que a tela viu (concorrência otimista:
--     outra sessão que mudou o módulo no meio faz este pedido falhar com
--     `extension_module_state_changed`, sem efeito). Desligar só sai de `ativo`; religar só sai de
--     `desligado`. NÃO chama a provisionadora nem apaga nada: as tabelas nunca saíram.
--  4. `fn_reaplicar_modulos_instalados()` deixa de religar um módulo desligado a cada atualização:
--     continua rodando a provisionadora dele (as tabelas acompanham a versão, para religar sem
--     susto), mas o estado `desligado` fica. Falha de provisionadora marca `suspenso` só o módulo que
--     não está desligado: gravar `suspenso` por cima de `desligado` faria a atualização seguinte, já
--     consertada, religá-lo sozinho. A decisão de quem administra só se desfaz pelo "Ligar de novo".
--  5. `fn_modulo_instalar` sobre linha que já existe NÃO mexe em `estado` (antes religava um
--     desligado ou suspenso por `on conflict do update set estado = 'ativo'`).
--  6. `fn_modulo_exigir_ativo(p_modulo)`, `stable security definer`, de nenhum papel do PostgREST:
--     lança `modulo_inativo` (errcode PT423) quando o módulo está registrado e não está `ativo`.
--  7. As RPCs que MUDAM dados de módulo e estão expostas a `authenticated` (fn_finalizar_comanda,
--     fn_estornar_comanda, fn_honorarios_parcela_pagar) começam por essa checagem: desligar deixa de
--     valer só no app. As policies de leitura ficam como estão. Os corpos são os do baseline, com o
--     search_path terminando em pg_temp (1008).
--
-- Idempotente: as duas CHECKs são trocadas por drop + add com a lista completa (nenhuma linha existente
-- viola a lista nova, que só cresce); funções por `create or replace`.

-- ── 1. o estado `desligado` ──────────────────────────────────────────────────
alter table public.modulos_instalados drop constraint if exists modulos_instalados_estado_check;
alter table public.modulos_instalados add constraint modulos_instalados_estado_check
  check (estado in ('ativo', 'suspenso', 'desligado'));

-- ── 2. os tipos de recibo ────────────────────────────────────────────────────
alter table public.extension_operations drop constraint if exists extension_operations_kind_check;
alter table public.extension_operations add constraint extension_operations_kind_check
  check (kind in ('catalog_admission','install','update','revert','removal','configure','module_install',
                  'module_disable','module_enable'));

-- ── 3. a porta de desligar e religar ─────────────────────────────────────────
create or replace function public.fn_modulo_definir_estado(
  p_actor uuid, p_operation uuid, p_modulo text, p_ligar boolean, p_estado_visto text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind text := case when p_ligar then 'module_enable' else 'module_disable' end;
  v_request jsonb;
  v_op public.extension_operations;
  v_atual text;
begin
  perform public.fn_extensions_assert_actor(p_actor);
  if p_operation is null or p_ligar is null or p_modulo is null
     or p_modulo !~ '^[a-z][a-z0-9_]{1,40}$'
     or p_estado_visto is null or p_estado_visto not in ('ativo', 'suspenso', 'desligado') then
    raise exception using errcode = 'P0001', message = 'extension_invalid_input';
  end if;
  v_request := jsonb_build_object('kind', v_kind, 'actor', p_actor, 'modulo', p_modulo,
                                  'estado_visto', p_estado_visto);

  -- A mesma trava do instalar e das extensões; o ator é conferido de novo depois da espera.
  perform pg_advisory_xact_lock(255, 1);
  perform public.fn_extensions_assert_actor(p_actor);

  select * into v_op from public.extension_operations where id = p_operation;
  if found then
    if v_op.request_fingerprint <> public.fn_extensions_fingerprint(v_request) then
      raise exception using errcode = 'P0001', message = 'extension_idempotency_conflict';
    end if;
    return to_jsonb(v_op) || jsonb_build_object('applied_now', false);
  end if;

  if public.fn_extensions_core_update_in_progress() then
    raise exception using errcode = 'P0001', message = 'extension_core_update_in_progress';
  end if;

  select estado into v_atual from public.modulos_instalados where modulo = p_modulo for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'extension_module_not_installed';
  end if;

  -- Concorrência otimista: a troca vale só sobre o estado que a tela mostrou. E cada direção tem um
  -- único ponto de partida: desligar sai de `ativo`, religar sai de `desligado`. Um `suspenso` não se
  -- religa por aqui (precisa da atualização que o conserta), nem se desliga.
  if v_atual <> p_estado_visto
     or (p_ligar and v_atual <> 'desligado')
     or (not p_ligar and v_atual <> 'ativo') then
    raise exception using errcode = 'P0001', message = 'extension_module_state_changed';
  end if;

  -- Só o estado muda. Nenhuma tabela do módulo é tocada, nem a provisionadora roda.
  update public.modulos_instalados
     set estado = case when p_ligar then 'ativo' else 'desligado' end
   where modulo = p_modulo;

  insert into public.extension_operations
      (id, kind, status, actor_id, name, request_fingerprint, request, result)
    values
      (p_operation, v_kind, 'completed', p_actor, p_modulo,
       public.fn_extensions_fingerprint(v_request), v_request,
       jsonb_build_object('modulo', p_modulo, 'de', v_atual,
                          'para', case when p_ligar then 'ativo' else 'desligado' end))
    returning * into v_op;

  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

revoke execute on function public.fn_modulo_definir_estado(uuid, uuid, text, boolean, text) from public, anon;
revoke execute on function public.fn_modulo_definir_estado(uuid, uuid, text, boolean, text) from authenticated;
grant execute on function public.fn_modulo_definir_estado(uuid, uuid, text, boolean, text) to service_role;

-- ── 4. a reaplicação respeita o desligado ────────────────────────────────────
create or replace function public.fn_reaplicar_modulos_instalados()
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  r record;
begin
  for r in select modulo from public.modulos_instalados order by modulo loop
    begin
      if to_regprocedure(format('public.fn_%s_provisionar()', r.modulo)) is null then
        raise exception 'a provisionadora de % não existe nesta versão', r.modulo;
      end if;
      execute format('select public.%I()', 'fn_' || r.modulo || '_provisionar');
      -- 1016: um módulo DESLIGADO por quem administra continua desligado depois da atualização. A
      -- provisionadora roda mesmo assim, para as tabelas acompanharem a versão e religar ser só
      -- trocar o estado. Este corpo é editado AQUI, e não redefinido no fim do apêndice, porque o
      -- rodapé do baseline chama a função ANTES do fim: uma redefinição posterior chegaria tarde e
      -- o update.sh religaria o módulo desligado.
      update public.modulos_instalados
        set estado = case when estado = 'desligado' then 'desligado' else 'ativo' end,
            motivo_suspensao = null, reaplicado_em = now()
        where modulo = r.modulo;
    exception
      -- Disputa de trava com o app no ar NÃO é defeito do módulo: relançar desfaz esta
      -- passada inteira (nenhum módulo é marcado), e o texto do Postgres — "deadlock
      -- detected", "could not obtain lock" — é o que o kit reconhece como disputa e o faz
      -- aplicar de novo. Suspender aqui tiraria do ar um módulo que só precisava esperar.
      when deadlock_detected or serialization_failure or lock_not_available then
        raise;
      -- 1016: a falha NUNCA sobrescreve `desligado`. Gravar `suspenso` por cima apagaria a decisão
      -- do administrador, e a atualização seguinte, já consertada, levaria `suspenso` a `ativo`: o
      -- módulo religaria sozinho. O motivo fica anotado para quem religar saber.
      when others then
        update public.modulos_instalados
          set estado = case when estado = 'desligado' then 'desligado' else 'suspenso' end,
              motivo_suspensao = sqlerrm
          where modulo = r.modulo;
    end;
  end loop;
  perform pg_notify('pgrst', 'reload schema');
end $$;

revoke execute on function public.fn_reaplicar_modulos_instalados() from public, anon, authenticated, service_role;


-- ── 5. instalar de novo não religa ───────────────────────────────────────────
create or replace function public.fn_modulo_instalar(p_actor uuid, p_operation uuid, p_modulo text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request jsonb := jsonb_build_object('kind', 'module_install', 'actor', p_actor, 'modulo', p_modulo);
  v_op public.extension_operations;
begin
  perform public.fn_extensions_assert_actor(p_actor);
  if p_operation is null or p_modulo is null or p_modulo !~ '^[a-z][a-z0-9_]{1,40}$' then
    raise exception using errcode = 'P0001', message = 'extension_invalid_input';
  end if;

  -- A mesma trava das extensões: serializa com instalar/atualizar pacote E com a atualização do
  -- núcleo. O ator é conferido de novo depois dela, porque a autoridade pode ter mudado na espera.
  perform pg_advisory_xact_lock(255, 1);
  perform public.fn_extensions_assert_actor(p_actor);

  select * into v_op from public.extension_operations where id = p_operation;
  if found then
    if v_op.request_fingerprint <> public.fn_extensions_fingerprint(v_request) then
      raise exception using errcode = 'P0001', message = 'extension_idempotency_conflict';
    end if;
    return to_jsonb(v_op) || jsonb_build_object('applied_now', false);
  end if;

  -- A lista de módulos instaláveis é o conjunto de provisionadoras que EXISTEM. Não há segunda
  -- lista para divergir: um módulo oficial entra pela tripla migration + baseline + MANIFEST
  -- trazendo `fn_<modulo>_provisionar()`, e o invariante da onda 1 prova a forma dela.
  if to_regprocedure(format('public.fn_%s_provisionar()', p_modulo)) is null then
    raise exception using errcode = 'P0001', message = 'extension_module_unknown';
  end if;

  if public.fn_extensions_core_update_in_progress() then
    raise exception using errcode = 'P0001', message = 'extension_core_update_in_progress';
  end if;

  -- O nome só chega aqui depois de passar pelo slug e pela existência da função; `%I` o cita.
  execute format('select public.%I()', 'fn_' || p_modulo || '_provisionar');

  -- 1016: quando a linha já existe, instalar de novo NÃO mexe em `estado`. Um módulo desligado
  -- por quem administra só religa pela fn_modulo_definir_estado (botão "Ligar de novo"), e um
  -- suspenso só sai de lá pela atualização que o conserta.
  insert into public.modulos_instalados (modulo, estado, instalado_por, reaplicado_em)
    values (p_modulo, 'ativo', p_actor, now())
    on conflict (modulo) do update
      set reaplicado_em = now();

  insert into public.extension_operations
      (id, kind, status, actor_id, name, request_fingerprint, request, result)
    values
      (p_operation, 'module_install', 'completed', p_actor, p_modulo,
       public.fn_extensions_fingerprint(v_request), v_request, jsonb_build_object('modulo', p_modulo))
    returning * into v_op;

  -- Tabela criada em tempo de execução é INVISÍVEL para a API até o PostgREST recarregar o
  -- schema. Sem isto, "instalar e usar, sem espera" (condição 3 do dono) seria falso: o módulo
  -- estaria instalado e o app receberia 404 ao consultá-lo. A notificação sai no commit.
  perform pg_notify('pgrst', 'reload schema');

  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

revoke execute on function public.fn_modulo_instalar(uuid, uuid, text) from public, anon;
revoke execute on function public.fn_modulo_instalar(uuid, uuid, text) from authenticated;
grant execute on function public.fn_modulo_instalar(uuid, uuid, text) to service_role;

-- ── 6. a ação do módulo exige o módulo ativo ─────────────────────────────────
-- Desligar não pode valer só no app: as RPCs que MUDAM dados de módulo e estão expostas a
-- `authenticated` (fn_finalizar_comanda, fn_estornar_comanda, fn_honorarios_parcela_pagar) começam
-- por esta checagem. Sem linha no registro (módulo provisionado direto, como na bateria de
-- invariantes) não há decisão de quem administra a respeitar, e a função segue como antes; a falta
-- da tabela continua recusada pela própria RPC. Leitura não passa por aqui: as policies ficam.
create or replace function public.fn_modulo_exigir_ativo(p_modulo text)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_estado text;
begin
  select estado into v_estado from public.modulos_instalados where modulo = p_modulo;
  if found and v_estado <> 'ativo' then
    raise exception using errcode = 'PT423', message = 'modulo_inativo',
      detail = format('modulo=%s estado=%s', p_modulo, v_estado),
      hint = 'O módulo está desligado ou suspenso nesta instalação.';
  end if;
end $$;

-- Só as RPCs definer a chamam, e elas rodam como o dono: nenhum papel do PostgREST precisa dela.
revoke execute on function public.fn_modulo_exigir_ativo(text) from public, anon, authenticated, service_role;

-- ── 7. as RPCs que mudam dados de módulo começam pela checagem da seção 6 ───────
create or replace function public.fn_finalizar_comanda(
  p_org uuid,
  p_sale uuid,
  p_payment_method uuid,
  p_loyalty_points integer default 0
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  -- ⚠️ `record` e NÃO `public.sales%rowtype`, por D7 da ADR-0002: a tabela é do
  -- módulo e não existe onde ele não está instalado, e `%rowtype` é resolvido na
  -- CRIAÇÃO da função (medido em Postgres 15: `relation does not exist`).
  -- `record` não é um afrouxo: os campos são lidos por nome, e a função só roda
  -- onde a comanda existe — o guard logo abaixo recusa o resto.
  v_sale       record;
  v_conta      uuid;
  v_plano      uuid;
  v_total      bigint;
  v_item       record;
  v_entry      uuid;
begin
  -- 1016: módulo desligado (ou suspenso) não aceita ação, mesmo chamada direto pela REST.
  perform public.fn_modulo_exigir_ativo('financeiro');
  if auth.uid() is null or not public.fn_role_at_least(p_org, 'agent') then
    raise exception 'comanda_forbidden' using errcode = '42501';
  end if;
  if to_regclass('public.sales') is null then
    raise exception 'modulo_nao_instalado' using errcode = 'P0001',
      hint = 'O módulo financeiro não está instalado nesta instalação.';
  end if;

  -- FOR UPDATE: duas finalizações simultâneas da mesma comanda geravam
  -- lançamento em dobro. O lock é o que torna esta função idempotente de fato,
  -- e não só na intenção.
  select * into v_sale from public.sales
   where id = p_sale and organization_id = p_org
   for update;

  if not found then
    raise exception 'comanda_nao_encontrada' using errcode = 'P0002';
  end if;
  if v_sale.status = 'finalized' then
    -- Não é erro: quem chamou duas vezes recebe o mesmo desfecho.
    return jsonb_build_object('sale_id', v_sale.id, 'ja_finalizada', true);
  end if;
  if v_sale.status = 'cancelled' then
    raise exception 'comanda_cancelada' using errcode = '22023';
  end if;

  select account_id into v_conta from public.payment_methods
   where id = p_payment_method and organization_id = p_org and is_active;
  if not found then
    raise exception 'forma_de_pagamento_invalida' using errcode = '22023';
  end if;
  if v_conta is null then
    -- A forma existe e não diz para onde o dinheiro vai. Recusar aqui é melhor
    -- que escolher uma conta por conta própria.
    raise exception 'forma_sem_conta'
      using errcode = '22023',
            hint = 'Esta forma de pagamento ainda não tem conta de destino. Defina em Configurações → Financeiro.';
  end if;

  select coalesce(sum(total_cents), 0) into v_total
    from public.sale_items where sale_id = p_sale;
  v_total := greatest(v_total - coalesce(v_sale.discount_cents, 0), 0);

  -- (1) a venda
  update public.sales
     set status = 'finalized',
         finalized_at = now(),
         payment_method_id = p_payment_method,
         total_cents = v_total
   where id = p_sale;

  -- (2) a comissão por item, com o percentual CONGELADO na inclusão
  for v_item in
    select * from public.sale_items where sale_id = p_sale and attendant_user_id is not null
  loop
    insert into public.commissions
      (organization_id, sale_item_id, attendant_user_id, percent, amount_cents)
    values (
      p_org, v_item.id, v_item.attendant_user_id, v_item.commission_percent,
      -- Sobre o item, NUNCA sobre o desconto da comanda: um desconto de caixa
      -- não pode reduzir o que quem atendeu combinou.
      floor(v_item.total_cents * v_item.commission_percent / 100.0)
    )
    on conflict (sale_item_id) do nothing;
  end loop;

  -- (3) a entrada na conta que a FORMA DE PAGAMENTO determina
  select id into v_plano from public.account_plans
   where organization_id = p_org and direction = 'in' and is_active
   order by created_at limit 1;

  insert into public.financial_entries
    (organization_id, account_id, account_plan_id, sale_id, direction, amount_cents,
     currency, description, status, paid_at, origin, created_by_user_id)
  values (
    p_org, v_conta, v_plano, p_sale, 'in', greatest(v_total, 1),
    v_sale.currency, format('Comanda #%s', v_sale.number), 'paid', now(), 'sale', auth.uid()
  )
  returning id into v_entry;

  -- (4) o ponto de fidelidade, idempotente pela chave da comanda
  if p_loyalty_points > 0 and v_sale.contact_id is not null then
    insert into public.loyalty_ledger
      (organization_id, contact_id, points, reason, sale_id, idempotency_key, created_by_user_id)
    values (
      p_org, v_sale.contact_id, p_loyalty_points, 'Comanda finalizada', p_sale,
      format('sale:%s', p_sale), auth.uid()
    )
    on conflict do nothing;
  end if;

  -- (5) o agendamento conclui — e SÓ se ainda estiver de pé.
  if v_sale.appointment_id is not null then
    update public.calendar_appointments
       set status = 'completed', outcome_recorded_at = now()
     where id = v_sale.appointment_id
       and organization_id = p_org
       -- A guarda que o sistema de origem não tinha em todos os caminhos:
       -- cancelado e faltou são desfechos DECIDIDOS, e faturar não os desfaz.
       and status not in ('cancelled', 'no_show');
  end if;

  return jsonb_build_object(
    'sale_id', v_sale.id,
    'number', v_sale.number,
    'total_cents', v_total,
    'entry_id', v_entry
  );
end $$;

revoke execute on function public.fn_finalizar_comanda(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.fn_finalizar_comanda(uuid, uuid, uuid, integer) to authenticated;

create or replace function public.fn_estornar_comanda(p_org uuid, p_sale uuid, p_motivo text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  -- ⚠️ `record` e NÃO `%rowtype`, por D7 da ADR-0002 (medido: `%rowtype` contra
  -- tabela do módulo ausente faz a CRIAÇÃO da função falhar).
  v_sale   record;
  v_orig   record;
  v_novo   uuid;
begin
  -- 1016: módulo desligado (ou suspenso) não aceita ação, mesmo chamada direto pela REST.
  perform public.fn_modulo_exigir_ativo('financeiro');
  if auth.uid() is null or not public.fn_role_at_least(p_org, 'manager') then
    raise exception 'estorno_forbidden' using errcode = '42501';
  end if;
  if to_regclass('public.sales') is null then
    raise exception 'modulo_nao_instalado' using errcode = 'P0001',
      hint = 'O módulo financeiro não está instalado nesta instalação.';
  end if;

  select * into v_sale from public.sales
   where id = p_sale and organization_id = p_org for update;
  if not found then raise exception 'comanda_nao_encontrada' using errcode = 'P0002'; end if;
  if v_sale.status <> 'finalized' then
    raise exception 'comanda_nao_finalizada' using errcode = '22023';
  end if;
  if v_sale.reversed_at is not null then
    return jsonb_build_object('sale_id', v_sale.id, 'ja_estornada', true);
  end if;

  update public.sales set reversed_at = now(), reverse_reason = p_motivo where id = p_sale;

  -- O contra-lançamento de cada entrada da comanda. A original NÃO é tocada:
  -- ela está paga e é imutável (o trigger acima recusaria).
  for v_orig in
    select * from public.financial_entries
     where sale_id = p_sale and organization_id = p_org and origin = 'sale'
  loop
    insert into public.financial_entries
      (organization_id, account_id, account_plan_id, sale_id, direction, amount_cents,
       currency, description, status, paid_at, origin, reverses_entry_id, created_by_user_id)
    values (
      p_org, v_orig.account_id, v_orig.account_plan_id, p_sale,
      case when v_orig.direction = 'in' then 'out' else 'in' end,
      v_orig.amount_cents, v_orig.currency,
      format('Estorno da comanda #%s', v_sale.number), 'paid', now(), 'reversal',
      v_orig.id, auth.uid()
    )
    returning id into v_novo;
  end loop;

  -- A comissão vira 'reversed' — não some, porque ela existiu e alguém pode já
  -- ter sido pago por ela.
  update public.commissions c
     set status = 'reversed', reversed_at = now()
    from public.sale_items i
   where c.sale_item_id = i.id and i.sale_id = p_sale and c.status <> 'reversed';

  -- E o ponto de fidelidade volta como movimento NEGATIVO, nunca apagando o
  -- ganho: o livro-razão conta as duas coisas.
  insert into public.loyalty_ledger
    (organization_id, contact_id, points, reason, sale_id, idempotency_key, created_by_user_id)
  select p_org, v_sale.contact_id, -l.points, 'Estorno da comanda', p_sale,
         format('reversal:%s', p_sale), auth.uid()
    from public.loyalty_ledger l
   where l.sale_id = p_sale and l.organization_id = p_org and l.points > 0
     and v_sale.contact_id is not null
  on conflict do nothing;

  return jsonb_build_object('sale_id', v_sale.id, 'estornada', true);
end $$;

revoke execute on function public.fn_estornar_comanda(uuid, uuid, text) from public, anon;
grant execute on function public.fn_estornar_comanda(uuid, uuid, text) to authenticated;

create or replace function public.fn_honorarios_parcela_pagar(
  p_org uuid,
  p_parcela uuid,
  p_account_id uuid,
  p_account_plan_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parcela record;
  v_entry uuid;
begin
  -- 1016: módulo desligado (ou suspenso) não aceita ação, mesmo chamada direto pela REST.
  perform public.fn_modulo_exigir_ativo('honorarios');
  if auth.uid() is null or not public.fn_role_at_least(p_org, 'manager') then
    raise exception 'honorarios_forbidden' using errcode = '42501';
  end if;

  select * into v_parcela from public.honorarios_parcelas
   where id = p_parcela and organization_id = p_org
   for update;

  if not found then
    raise exception 'parcela_nao_encontrada' using errcode = 'P0002';
  end if;
  if v_parcela.status = 'pago' then
    raise exception 'parcela_ja_paga' using errcode = '22023';
  end if;

  -- A conta e o plano vêm do corpo da requisição, e a função é definer: sem esta
  -- conferência a FK aceitaria a conta de OUTRA organização e o dinheiro desta
  -- entraria no extrato de lá. fn_finalizar_comanda resolve a conta pela forma de
  -- pagamento filtrada por p_org; aqui a conta chega direto, então o filtro é este.
  if not exists (
    select 1 from public.financial_accounts
     where id = p_account_id and organization_id = p_org and is_active
  ) then
    raise exception 'conta_invalida' using errcode = '22023';
  end if;
  if p_account_plan_id is not null and not exists (
    select 1 from public.account_plans
     where id = p_account_plan_id and organization_id = p_org and is_active
  ) then
    raise exception 'conta_invalida' using errcode = '22023';
  end if;

  -- A entrada do caixa nasce na MOEDA DA PARCELA (#3379): `financial_entries`
  -- tem `default 'BRL'`, então sem esta coluna o dinheiro de uma parcela em
  -- dólar entrava no extrato em real — o valor certo no bloco errado do
  -- relatório.
  insert into public.financial_entries
    (organization_id, account_id, account_plan_id, direction, amount_cents, currency,
     description, status, paid_at, origin, created_by_user_id)
  values (
    p_org, p_account_id, p_account_plan_id, 'in', v_parcela.valor_cents, v_parcela.currency,
    format('Parcela %s de honorários', v_parcela.numero), 'paid', now(), 'manual', auth.uid()
  )
  returning id into v_entry;

  update public.honorarios_parcelas
     set status = 'pago', financial_entry_id = v_entry
   where id = p_parcela;

  return jsonb_build_object(
    'id', v_parcela.id,
    'contrato_id', v_parcela.contrato_id,
    'numero', v_parcela.numero,
    'valor_cents', v_parcela.valor_cents,
    'status', 'pago',
    'financial_entry_id', v_entry
  );
end;
$$;

revoke execute on function public.fn_honorarios_parcela_pagar(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.fn_honorarios_parcela_pagar(uuid, uuid, uuid, uuid) to authenticated;

comment on table public.modulos_instalados is
  'Módulos opcionais instalados NA INSTÂNCIA (ADR-0002, D3). Sem organization_id: o corte é por instalação. Escrito só por fn_modulo_instalar, fn_modulo_definir_estado (1016: desligar/religar, sem apagar dados) e fn_reaplicar_modulos_instalados.';
