-- 0955, cupons de desconto na compra do plano (fork Hiperbold).
--
-- Faixa 09xx reservada ao fork (ver 0901).
--
-- Decisão do dono do produto (14/10/2026): cupom de desconto na compra de PLANO (nunca no pacote de tokens).
--   * Desconto em PORCENTAGEM (1 a 99) ou em VALOR fixo em centavos. O total com desconto nunca fica abaixo
--     de R$ 5,00 (500 centavos, o mínimo do Asaas): o desconto é cortado para respeitar o piso.
--   * Vale SÓ na PRIMEIRA cobrança. A renovação da assinatura cobra o preço cheio do ciclo (a assinatura do
--     Asaas é criada no preço cheio; só a primeira cobrança é rebaixada pelo servidor). Por isso
--     fn_billing_asaas_aplicar_pagamento NÃO muda: a primeira cobrança compara com billing_orders.amount_cents
--     (que já é o total com desconto) e a renovação segue exigindo o preço do ciclo do plano.
--   * O mesmo PAGADOR (CPF/CNPJ) também usa o cupom uma vez só, em qualquer organização. O documento nunca é
--     gravado (decisão 16 da fase F5): o servidor manda uma IMPRESSÃO dele (HMAC-SHA256 com chave do servidor,
--     64 hexadecimais) em billing_orders.pagador_impressao, só em pedido com cupom.
--   * O cliente digita um CÓDIGO (sem diferença de maiúsculas e minúsculas; letras, números, hífen e
--     sublinhado; 3 a 40 caracteres).
--   * Restrições opcionais por cupom: planos permitidos (lista de billing_plans.code; vazio = todos), ciclos
--     permitidos (vazio = todos), validade (valido_ate), limite total de usos (max_usos) e ativo/inativo.
--     Cada ORGANIZAÇÃO usa o mesmo cupom no máximo uma vez (pedido pago; o estornado também conta como usado).
--
-- O que esta migration faz:
--   1. billing_cupons: tabela de PLATAFORMA (sem organization_id). RLS ligada e nenhuma policy; anon e
--      authenticated não leem nem escrevem; service_role só lê. A escrita é das funções definer abaixo.
--   2. billing_orders ganha cupom_id, desconto_cents (0 sem cupom) e preco_cheio_cents (só com cupom).
--   3. fn_billing_cupom_desconto (a conta, pura) e fn_billing_cupom_resolver (valida e calcula; interna).
--   4. fn_billing_criar_pedido ganha p_cupom_codigo, por último e com default nulo (quem não manda cupom tem
--      o comportamento de antes). Com cupom: valida, calcula sobre o preço do ciclo, o parcelamento aplica
--      os juros sobre o preço JÁ descontado, e o cupom entra na identidade da chave idempotente. A assinatura
--      de 12 parâmetros é derrubada antes do create (senão toda chamada com 12 argumentos seria ambígua).
--   5. fn_billing_cupom_simular (só leitura, para a tela mostrar o valor antes de confirmar), e as funções do
--      admin: fn_billing_cupom_criar, fn_billing_cupom_definir_ativo e fn_billing_cupom_listar.
--
-- Contagem de usos: pedidos pagos (e estornados) de OUTRAS organizações, mais pedidos abertos de outras
-- organizações CRIADOS nas últimas 24 horas (um pedido aberto abandonado não segura o cupom para sempre; a
-- janela conta da criação, para mexer no pedido não renovar a vaga).
--
-- Parcelado: cada parcela precisa ficar em pelo menos R$ 5,00 (billing_cupom_parcela_minima), na simulação e na
-- criação do pedido. Valor fixo: o desconto efetivo nunca passa de 99% do preço do ciclo, como o percentual.
-- Os pedidos da própria organização ficam de fora da conta: ela só pode ter um pedido de assinatura aberto,
-- e o reenvio do mesmo pedido não pode se esgotar sozinho.
--
-- Reaplicável com o app no ar e sobre a versão anterior: create table if not exists, colunas e constraints
-- só quando faltam, create or replace, lock_timeout curto, e uma transação única fecha a janela em que a
-- tabela e as funções novas teriam o ACL padrão do Supabase.
begin;

set lock_timeout = '3s';

-- ── 1. billing_cupons ──
create table if not exists public.billing_cupons (
  id uuid primary key default gen_random_uuid(),
  codigo citext not null,
  tipo text not null,
  valor integer not null,
  planos text[] not null default '{}',
  ciclos text[] not null default '{}',
  valido_ate timestamptz,
  max_usos integer,
  ativo boolean not null default true,
  descricao text,
  criado_por uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_cupons_codigo_unique unique (codigo),
  constraint billing_cupons_codigo_formato check (codigo::text ~ '^[A-Za-z0-9_-]{3,40}$'),
  constraint billing_cupons_tipo_valido check (tipo in ('percentual', 'valor')),
  constraint billing_cupons_valor_coerente check (
    (tipo = 'percentual' and valor between 1 and 99) or (tipo = 'valor' and valor > 0)
  ),
  constraint billing_cupons_ciclos_validos check (ciclos <@ array['monthly', 'semiannual', 'yearly']::text[]),
  constraint billing_cupons_max_usos_positivo check (max_usos is null or max_usos >= 1),
  constraint billing_cupons_descricao_tamanho check (descricao is null or length(descricao) <= 200)
);

comment on table public.billing_cupons is
  '0955: cupom de desconto na compra de PLANO. Tabela de plataforma (sem organization_id). tipo percentual (valor 1 a 99) ou valor (centavos). planos e ciclos vazios = todos. Vale só na primeira cobrança. Cada organização usa o mesmo cupom no máximo uma vez. RLS ligada sem policy: só o servidor lê (service_role); a escrita é de fn_billing_cupom_criar e fn_billing_cupom_definir_ativo.';

drop trigger if exists trg_billing_cupons_touch on public.billing_cupons;
create trigger trg_billing_cupons_touch
  before update on public.billing_cupons
  for each row execute function public.fn_touch_updated_at();

alter table public.billing_cupons enable row level security;

revoke all on public.billing_cupons from anon, authenticated;
revoke insert, update, delete, truncate on public.billing_cupons from service_role;
grant select on public.billing_cupons to service_role;

-- ── 2. billing_orders: o cupom e o desconto do pedido ──
alter table public.billing_orders
  add column if not exists cupom_id uuid references public.billing_cupons(id),
  add column if not exists desconto_cents integer not null default 0,
  add column if not exists preco_cheio_cents integer,
  add column if not exists pagador_impressao text;

do $cupons_constraints$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_orders_cupom_coerente') then
    alter table public.billing_orders
      add constraint billing_orders_cupom_coerente
      check (
        desconto_cents >= 0
        and ((cupom_id is null and desconto_cents = 0 and preco_cheio_cents is null)
          or (cupom_id is not null and desconto_cents > 0 and preco_cheio_cents is not null and preco_cheio_cents > desconto_cents))
      );
  end if;
end
$cupons_constraints$;

do $cupons_impressao$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_orders_pagador_impressao_formato') then
    alter table public.billing_orders
      add constraint billing_orders_pagador_impressao_formato
      check (pagador_impressao is null or (pagador_impressao ~ '^[0-9a-f]{64}$' and cupom_id is not null));
  end if;
end
$cupons_impressao$;

create index if not exists billing_orders_cupom_idx
  on public.billing_orders (cupom_id, status)
  where cupom_id is not null;

create index if not exists billing_orders_cupom_pagador_idx
  on public.billing_orders (cupom_id, pagador_impressao)
  where pagador_impressao is not null;

comment on column public.billing_orders.cupom_id is
  '0955: cupom aplicado ao pedido (só assinatura). Nulo = sem cupom.';
comment on column public.billing_orders.desconto_cents is
  '0955: desconto em centavos sobre o preço cheio do ciclo (0 sem cupom). amount_cents já é o total com desconto (e, no parcelado, com os juros calculados sobre o preço descontado).';
comment on column public.billing_orders.pagador_impressao is
  '0955: impressão do CPF/CNPJ do pagador (HMAC-SHA256 com chave do servidor, 64 hexadecimais), só em pedido com cupom. O documento nunca é gravado. Serve a uma regra só: o mesmo pagador usa o mesmo cupom uma vez, em qualquer organização.';
comment on column public.billing_orders.preco_cheio_cents is
  '0955: preço cheio do ciclo no momento do pedido, só quando há cupom. É o valor da assinatura do Asaas, que renova no preço cheio.';

-- ── 3. A conta e a validação ──
drop function if exists public.fn_billing_cupom_resolver(uuid, text, text, text, integer, boolean, boolean);

create or replace function public.fn_billing_cupom_desconto(
  p_tipo text,
  p_valor integer,
  p_preco_cents integer
)
returns integer
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_bruto bigint;
  v_total bigint;
begin
  if p_preco_cents is null or p_preco_cents <= 0 or p_valor is null or p_valor <= 0 then
    return 0;
  end if;

  v_bruto := case p_tipo
    when 'percentual' then round(p_preco_cents::numeric * least(p_valor, 99) / 100)::bigint
    -- Valor fixo: o desconto efetivo nunca passa de 99% do preço (a mesma regra do percentual).
    when 'valor' then least(p_valor::bigint, round(p_preco_cents::numeric * 99 / 100)::bigint)
    else 0
  end;

  -- Piso de R$ 5,00 (500 centavos, o mínimo do Asaas): o total nunca fica abaixo dele, e preço que já é
  -- igual ou menor que o piso não recebe desconto.
  v_total := greatest(p_preco_cents - v_bruto, least(500, p_preco_cents));
  return (p_preco_cents - v_total)::integer;
end;
$$;

comment on function public.fn_billing_cupom_desconto(text, integer, integer) is
  '0955: o desconto efetivo em centavos. percentual: round(preco x valor / 100), valor limitado a 99; valor: os centavos do cupom, limitados a 99% do preço. O total (preco menos desconto) nunca fica abaixo de 500 centavos; preço igual ou menor que 500 não recebe desconto. Interna: deny-all.';

revoke execute on function public.fn_billing_cupom_desconto(text, integer, integer) from public, anon, authenticated, service_role;

create or replace function public.fn_billing_cupom_resolver(
  p_org uuid,
  p_codigo text,
  p_plan_code text,
  p_ciclo text,
  p_preco_cents integer,
  p_validar boolean default true,
  p_travar boolean default false,
  p_impressao text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_codigo text := btrim(coalesce(p_codigo, ''));
  v_cupom public.billing_cupons%rowtype;
  v_desconto integer;
  v_usos integer;
begin
  if v_codigo !~ '^[A-Za-z0-9_-]{3,40}$' then
    raise exception 'billing_cupom_invalido' using errcode = '22023';
  end if;

  -- O cast para citext é necessário: citext = text resolveria para text = text e distinguiria maiúsculas.
  -- Quem cria o pedido trava a linha do cupom, para dois pedidos de organizações diferentes não passarem
  -- juntos pelo último uso.
  if p_travar then
    select * into v_cupom from public.billing_cupons where codigo = v_codigo::citext for update;
  else
    select * into v_cupom from public.billing_cupons where codigo = v_codigo::citext;
  end if;

  -- Inexistente e inativo dão a mesma resposta: o cliente não descobre códigos por tentativa.
  if not found then
    raise exception 'billing_cupom_invalido' using errcode = '22023';
  end if;

  if p_validar then
    if not v_cupom.ativo then
      raise exception 'billing_cupom_invalido' using errcode = '22023';
    end if;
    if v_cupom.valido_ate is not null and v_cupom.valido_ate <= now() then
      raise exception 'billing_cupom_expirado' using errcode = '22023';
    end if;
    if cardinality(v_cupom.planos) > 0 and not (p_plan_code = any (v_cupom.planos)) then
      raise exception 'billing_cupom_nao_vale_para_o_plano' using errcode = '22023';
    end if;
    if cardinality(v_cupom.ciclos) > 0 and not (p_ciclo = any (v_cupom.ciclos)) then
      raise exception 'billing_cupom_nao_vale_para_o_ciclo' using errcode = '22023';
    end if;

    if exists (
      select 1 from public.billing_orders o
       where o.cupom_id = v_cupom.id
         and o.organization_id = p_org
         and o.status in ('pago', 'estornado')
    ) then
      raise exception 'billing_cupom_ja_usado' using errcode = '22023';
    end if;

    -- O mesmo pagador (CPF/CNPJ), em qualquer organização, também só usa o cupom uma vez.
    if p_impressao is not null and exists (
      select 1 from public.billing_orders o
       where o.cupom_id = v_cupom.id
         and o.pagador_impressao = p_impressao
         and o.status in ('pago', 'estornado')
    ) then
      raise exception 'billing_cupom_ja_usado' using errcode = '22023';
    end if;

    if v_cupom.max_usos is not null then
      select count(*) into v_usos
        from public.billing_orders o
       where o.cupom_id = v_cupom.id
         and o.organization_id <> p_org
         and (
           o.status in ('pago', 'estornado')
           or (o.status in ('criado', 'processando', 'aguardando_pagamento', 'inconclusivo')
               and o.created_at > now() - interval '24 hours')
         );
      if v_usos >= v_cupom.max_usos then
        raise exception 'billing_cupom_esgotado' using errcode = '22023';
      end if;
    end if;
  end if;

  v_desconto := public.fn_billing_cupom_desconto(v_cupom.tipo, v_cupom.valor, p_preco_cents);

  if p_validar and v_desconto <= 0 then
    raise exception 'billing_cupom_sem_desconto' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'cupom_id', v_cupom.id,
    'codigo', v_cupom.codigo::text,
    'tipo', v_cupom.tipo,
    'valor', v_cupom.valor,
    'desconto_cents', v_desconto,
    'total_cents', p_preco_cents - v_desconto
  );
end;
$$;

comment on function public.fn_billing_cupom_resolver(uuid, text, text, text, integer, boolean, boolean, text) is
  '0955: acha o cupom pelo código (sem diferença de maiúsculas), valida (p_validar) e calcula o desconto sobre p_preco_cents. p_impressao é a impressão do pagador (a mesma pessoa não usa o cupom duas vezes, em organização nenhuma). Erros 22023: billing_cupom_invalido (formato, inexistente ou inativo), billing_cupom_expirado, billing_cupom_nao_vale_para_o_plano, billing_cupom_nao_vale_para_o_ciclo, billing_cupom_ja_usado, billing_cupom_esgotado, billing_cupom_sem_desconto. p_validar falso (repetição da mesma chave) só localiza e calcula. p_travar trava a linha do cupom. Interna: deny-all.';

revoke execute on function public.fn_billing_cupom_resolver(uuid, text, text, text, integer, boolean, boolean, text) from public, anon, authenticated, service_role;

-- ── 4. fn_billing_criar_pedido com p_cupom_codigo ──
drop function if exists public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer);
drop function if exists public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer, text);

create or replace function public.fn_billing_criar_pedido(
  p_org uuid,
  p_tipo text,
  p_plan_code text,
  p_ciclo text,
  p_pacote text,
  p_metodo text,
  p_ambiente text,
  p_chave uuid,
  p_actor uuid,
  p_termos_versao text default null,
  p_parcelas integer default 1,
  p_total_cents integer default null,
  p_cupom_codigo text default null,
  p_pagador_impressao text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_compra_pelo_cliente boolean;
  v_contract record;
  v_plan record;
  v_pacote record;
  v_plan_id uuid;
  v_ciclo text;
  v_pacote_id uuid;
  v_tokens bigint;
  v_amount_cents integer;
  v_preco_ciclo integer;
  v_existente record;
  v_pedido_id uuid;
  v_external_reference text;
  v_proxima_cobranca_em date;
  v_parcelas integer := coalesce(p_parcelas, 1);
  v_cfg record;
  v_teto_parcelas integer;
  v_total_calculado integer;
  v_preco_cheio integer;
  v_cupom_codigo text := nullif(btrim(coalesce(p_cupom_codigo, '')), '');
  v_cupom jsonb;
  v_cupom_id uuid;
  v_desconto_cents integer := 0;
  v_replay boolean := false;
  v_impressao text := nullif(btrim(coalesce(p_pagador_impressao, '')), '');
begin
  if p_chave is null then
    raise exception 'billing_chave_obrigatoria' using errcode = '22023';
  end if;

  if p_tipo not in ('assinatura', 'pacote_tokens') then
    raise exception 'billing_tipo_invalido' using errcode = '22023';
  end if;

  if p_metodo not in ('CREDIT_CARD', 'PIX') then
    raise exception 'billing_metodo_invalido' using errcode = '22023';
  end if;

  -- 0955: cupom de desconto vale só na compra de PLANO, nunca no pacote de tokens.
  if v_cupom_codigo is not null and p_tipo <> 'assinatura' then
    raise exception 'billing_cupom_nao_vale_para_o_plano' using errcode = '22023';
  end if;

  if p_ambiente not in ('sandbox', 'producao') then
    raise exception 'billing_ambiente_invalido' using errcode = '22023';
  end if;

  -- 0943 (D-133): aceite dos Termos de Uso. A compra do CLIENTE (p_actor preenchido: o usuário que
  -- clicou) só nasce com a versão dos Termos aceita; a chamada interna sem ator (script de
  -- homologação, ferramenta do operador) segue sem aceite, com p_termos_versao nulo. Versão em
  -- branco ou longa demais é recusada em qualquer chamada: o banco nunca guarda lixo como versão.
  if p_termos_versao is not null and (btrim(p_termos_versao) = '' or length(p_termos_versao) > 40) then
    raise exception 'billing_termos_invalidos' using errcode = '22023';
  end if;

  if p_actor is not null and p_termos_versao is null then
    raise exception 'billing_termos_nao_aceitos' using errcode = '22023';
  end if;

  -- 0945 (D-177): parcelamento. Número de parcelas inteiro de 1 a 12 (o teto do ciclo vem de
  -- billing_settings, mais abaixo). Só a assinatura semestral ou anual no cartão parcela: pacote de
  -- tokens, mensal e Pix ficam à vista.
  if v_parcelas < 1 or v_parcelas > 12 then
    raise exception 'billing_parcelas_invalidas' using errcode = '22023';
  end if;

  if v_parcelas > 1 then
    if p_tipo <> 'assinatura' or p_ciclo is null or p_ciclo not in ('semiannual', 'yearly') then
      raise exception 'billing_parcelamento_indisponivel' using errcode = '22023';
    end if;
    if p_metodo <> 'CREDIT_CARD' then
      raise exception 'billing_parcelamento_so_no_cartao' using errcode = '22023';
    end if;
  end if;

  if p_tipo = 'assinatura' then
    if p_plan_code is null or btrim(p_plan_code) = '' then
      raise exception 'billing_plan_code_obrigatorio' using errcode = '22023';
    end if;
    if p_ciclo not in ('monthly', 'semiannual', 'yearly') then
      raise exception 'billing_ciclo_invalido' using errcode = '22023';
    end if;
  else
    if p_pacote is null or btrim(p_pacote) = '' then
      raise exception 'billing_pacote_obrigatorio' using errcode = '22023';
    end if;
  end if;

  -- Decisão 12: leitura de billing_settings SEM for share, feita ANTES de
  -- tomar a trava (não precisa travar a linha, e é o rejeite mais barato).
  select compra_pelo_cliente into v_compra_pelo_cliente
    from public.billing_settings
    where id = 1;

  if not coalesce(v_compra_pelo_cliente, false) then
    raise exception 'billing_compra_desligada' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('billing_assinatura:' || p_org::text, 0));

  select * into v_contract
    from public.billing_contracts
    where organization_id = p_org
    for update;

  if not found then
    raise exception 'billing_contrato_nao_encontrado' using errcode = 'P0002';
  end if;

  -- 0955: a impressão do pagador (só com cupom). Sem ela, vale a da última compra com cupom da organização.
  if v_cupom_codigo is not null then
    if v_impressao is not null and v_impressao !~ '^[0-9a-f]{64}$' then
      raise exception 'billing_pagador_impressao_invalida' using errcode = '22023';
    end if;
    if v_impressao is null then
      select o.pagador_impressao into v_impressao
        from public.billing_orders o
       where o.organization_id = p_org and o.pagador_impressao is not null
       order by o.created_at desc
       limit 1;
    end if;
  end if;

  -- 0955: repetição da MESMA chave (já existe pedido com ela): o cupom não é validado de novo (pode ter
  -- vencido ou esgotado depois de este pedido nascer), só localizado e calculado para a comparação de
  -- identidade da chave mais abaixo.
  if v_cupom_codigo is not null then
    v_replay := exists (select 1 from public.billing_orders where organization_id = p_org and chave = p_chave);
  end if;

  if p_tipo = 'assinatura' then
    select * into v_plan
      from public.billing_plans
      where code = p_plan_code and active
      limit 1;

    if not found then
      raise exception 'plano_nao_encontrado_ou_inativo' using errcode = 'P0002';
    end if;

    if not v_plan.for_sale then
      raise exception 'billing_plano_fora_de_venda' using errcode = '22023';
    end if;

    v_plan_id := v_plan.id;
    v_ciclo := p_ciclo;

    if p_ciclo = 'monthly' then
      -- Preço não se inventa (N8/N9, restrição fixa 3): plano sem preço
      -- mensal positivo não aparece para compra mensal.
      if coalesce(v_plan.price_monthly_cents, 0) <= 0 then
        raise exception 'billing_preco_nao_definido' using errcode = '22023';
      end if;
      -- Decisão 2 (oferta desta fase): mensal só no cartão.
      if p_metodo <> 'CREDIT_CARD' then
        raise exception 'billing_metodo_invalido_para_oferta' using errcode = '22023';
      end if;
      v_preco_cheio := v_plan.price_monthly_cents;
      v_amount_cents := v_preco_cheio;

      if v_cupom_codigo is not null then
        v_cupom := public.fn_billing_cupom_resolver(
          p_org, v_cupom_codigo, p_plan_code, p_ciclo, v_preco_cheio, not v_replay, not v_replay, v_impressao
        );
        v_cupom_id := (v_cupom ->> 'cupom_id')::uuid;
        v_desconto_cents := (v_cupom ->> 'desconto_cents')::integer;
        v_amount_cents := (v_cupom ->> 'total_cents')::integer;
      end if;
    else
      -- semiannual e yearly: cartão ou Pix (decisão 2, estendida ao semestral na
      -- 0941), cada um com o próprio preço do período inteiro. Plano sem preço
      -- do ciclo (coluna nula ou zero) não aparece para compra desse ciclo, com
      -- CREDIT_CARD ou com PIX: o preço nunca vem da entrada nem se calcula.
      v_preco_ciclo := case p_ciclo
        when 'semiannual' then v_plan.price_semiannual_cents
        else v_plan.price_yearly_cents
      end;
      if coalesce(v_preco_ciclo, 0) <= 0 then
        raise exception 'billing_preco_nao_definido' using errcode = '22023';
      end if;
      v_preco_cheio := v_preco_ciclo;
      v_amount_cents := v_preco_cheio;

      if v_cupom_codigo is not null then
        v_cupom := public.fn_billing_cupom_resolver(
          p_org, v_cupom_codigo, p_plan_code, p_ciclo, v_preco_cheio, not v_replay, not v_replay, v_impressao
        );
        v_cupom_id := (v_cupom ->> 'cupom_id')::uuid;
        v_desconto_cents := (v_cupom ->> 'desconto_cents')::integer;
        v_amount_cents := (v_cupom ->> 'total_cents')::integer;
      end if;

      -- 0945 (D-177): parcelamento. O teto e a taxa vêm de billing_settings (nunca da entrada); o
      -- total é a conta do banco, e quem chama manda o que calculou só para ser CONFERIDO: total
      -- diferente é recusado, e o amount_cents do pedido parcelado é sempre o do banco.
      if v_parcelas > 1 then
        select parcelamento_taxa_mensal, parcelamento_sem_juros_ate,
               parcelamento_max_semestral, parcelamento_max_anual
          into v_cfg
          from public.billing_settings
          where id = 1;

        v_teto_parcelas := coalesce(
          case p_ciclo when 'semiannual' then v_cfg.parcelamento_max_semestral else v_cfg.parcelamento_max_anual end,
          1
        );
        if v_parcelas > v_teto_parcelas then
          raise exception 'billing_parcelas_acima_do_teto' using errcode = '22023';
        end if;

        v_total_calculado := public.fn_billing_parcelamento_total(
          v_amount_cents, v_parcelas, v_cfg.parcelamento_taxa_mensal, v_cfg.parcelamento_sem_juros_ate
        );
        -- 0955: com cupom, quem chama pode não mandar o total (o desconto é do banco); se mandar, é conferido.
        if p_total_cents is distinct from v_total_calculado
          and not (v_cupom_id is not null and p_total_cents is null)
        then
          raise exception 'billing_parcelamento_total_divergente' using errcode = '22023';
        end if;
        v_amount_cents := v_total_calculado;
      end if;
    end if;

    -- 0942: troca de PLANO com período pago vigente também fica de fora. O Pix de outro plano
    -- empilhava o período sobre o do plano atual e, no pagamento, o plan_id trocava na hora: o
    -- cliente passava a ter o plano novo pelo período velho, e o período empilhado pagava um
    -- plano que ele ainda não podia usar. Vale para cartão e Pix. Mesmo plano e mesmo ciclo
    -- empilha normalmente (renovação antecipada). Período pago vigente = pagamento recebido, não
    -- estornado, com fim no futuro: contrato com período só de cortesia (sem pagamento) troca
    -- de plano comprando, como sempre. Vem ANTES da recusa de troca de ciclo.
    if v_contract.status = 'ativa'
       and v_contract.plan_id is distinct from v_plan_id
       and v_contract.current_period_end is not null
       and v_contract.current_period_end > now()
       and exists (
         select 1 from public.billing_payments p
          where p.organization_id = p_org
            and p.status in ('RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH')
            and p.billing_period_end > now()
            and not exists (
              select 1 from public.billing_payments r
               where r.estorna_pagamento_id = p.id and r.status = 'REFUNDED'
            )
       )
    then
      raise exception 'billing_troca_de_plano_indisponivel' using errcode = '22023';
    end if;

    -- 0941: troca de ciclo de quem já tem contrato em andamento fica de fora
    -- desta fase. Contrato ativo, com ciclo conhecido e período ainda pago, não
    -- aceita pedido de OUTRO ciclo (nem pelo cartão, nem pelo Pix): a troca
    -- pediria crédito proporcional e cancelar a assinatura do Asaas, e isso
    -- ainda não foi decidido. Contrato sem ciclo (registro manual), vencido,
    -- suspenso ou cancelado não entra aqui. Vem ANTES da recusa de assinatura
    -- viva para a pessoa ler o motivo certo.
    if v_contract.status = 'ativa'
       and v_contract.cycle is not null
       and v_contract.cycle <> p_ciclo
       and v_contract.current_period_end is not null
       and v_contract.current_period_end > now()
    then
      raise exception 'billing_troca_de_ciclo_indisponivel' using errcode = '22023';
    end if;

    -- Decisão 18: "billing_ja_tem_assinatura_asaas" só considera assinatura
    -- SEM o marcador de encerramento (decisão 22): uma assinatura já
    -- encerrada (ou nunca existente) não bloqueia um pedido novo.
    if v_contract.asaas_subscription_id is not null and v_contract.asaas_assinatura_encerrada_em is null then
      raise exception 'billing_ja_tem_assinatura_asaas' using errcode = '22023';
    end if;

    -- Decisão 26: com período ainda vigente (pago no futuro), a próxima
    -- cobrança nasce no dia seguinte ao último dia já pago, ou seja, a data
    -- civil em America/Sao_Paulo de current_period_end (que já é esse limite
    -- exclusivo, 00h de SP do dia seguinte). Sem período vigente, null: o
    -- serviço de compra (Tarefa 14) usa hoje em SP.
    if v_contract.current_period_end is not null and v_contract.current_period_end > now() then
      v_proxima_cobranca_em := (v_contract.current_period_end at time zone 'America/Sao_Paulo')::date;
    else
      v_proxima_cobranca_em := null;
    end if;
  else
    select * into v_pacote
      from public.billing_token_pacotes
      where codigo = p_pacote and ativo
      limit 1;

    if not found then
      raise exception 'pacote_nao_encontrado_ou_inativo' using errcode = 'P0002';
    end if;

    -- Preço não se inventa (N9, restrição fixa 3): pacote sem preço não
    -- aparece para compra.
    if coalesce(v_pacote.preco_cents, 0) <= 0 then
      raise exception 'billing_preco_nao_definido' using errcode = '22023';
    end if;

    -- Decisão 2: pacote aceita CREDIT_CARD ou PIX, os dois únicos valores
    -- possíveis de p_metodo (já validado acima). Nenhuma restrição extra.
    v_ciclo := null;
    v_pacote_id := v_pacote.id;
    v_tokens := v_pacote.tokens;
    v_amount_cents := v_pacote.preco_cents;
    v_proxima_cobranca_em := null;
  end if;

  -- 0955: com cupom, cada parcela fica em pelo menos R$ 5,00 (500 centavos).
  if v_cupom_id is not null and v_parcelas > 1 and v_amount_cents < 500 * v_parcelas then
    raise exception 'billing_cupom_parcela_minima' using errcode = '22023';
  end if;

  -- 0945: à vista com total informado também é conferido (o total de quem não parcela é o preço).
  if v_parcelas = 1 and p_total_cents is not null and p_total_cents <> v_amount_cents then
    raise exception 'billing_parcelamento_total_divergente' using errcode = '22023';
  end if;

  -- Idempotência pela chave (decisão 13), DEPOIS de resolver o catálogo
  -- (decisão 17): compara contra o que o banco decidiu, nunca contra a
  -- entrada crua.
  select * into v_existente
    from public.billing_orders
    where organization_id = p_org and chave = p_chave;

  if found then
    if v_existente.tipo = p_tipo
      and v_existente.parcelas = v_parcelas
      and v_existente.plan_id is not distinct from v_plan_id
      and v_existente.ciclo is not distinct from v_ciclo
      and v_existente.pacote_id is not distinct from v_pacote_id
      and v_existente.tokens is not distinct from v_tokens
      and v_existente.metodo = p_metodo
      and v_existente.ambiente = p_ambiente
      and v_existente.amount_cents = v_amount_cents
      and v_existente.cupom_id is not distinct from v_cupom_id
      and v_existente.desconto_cents = v_desconto_cents
    then
      return jsonb_build_object(
        'pedido_id', v_existente.id,
        'external_reference', v_existente.external_reference,
        'amount_cents', v_existente.amount_cents,
        'parcelas', v_existente.parcelas,
        'desconto_cents', v_existente.desconto_cents,
        'cupom_id', v_existente.cupom_id,
        'ja_existia', true,
        'proxima_cobranca_em', v_proxima_cobranca_em
      );
    end if;
    raise exception 'billing_chave_com_valores_diferentes' using errcode = '22023';
  end if;

  -- Decisão 11 (idempotência em três camadas) e decisão 25 (posse atômica):
  -- um pedido ABERTO por organização e por tipo, incluindo 'processando'. O
  -- índice único parcial billing_orders_aberto_por_tipo_unique (Tarefa 1) é a
  -- rede de segurança final; este select devolve a mensagem PRÓPRIA antes de
  -- deixar o insert estourar um erro genérico de unicidade.
  if exists (
    select 1 from public.billing_orders
    where organization_id = p_org and tipo = p_tipo
      and status in ('criado', 'aguardando_pagamento', 'inconclusivo', 'processando')
  ) then
    raise exception 'billing_pedido_aberto_existe' using errcode = '22023';
  end if;

  insert into public.billing_orders (
    organization_id, ambiente, tipo, plan_id, ciclo, pacote_id, tokens,
    metodo, amount_cents, chave, criado_por, termos_versao, termos_aceitos_em, parcelas,
    cupom_id, desconto_cents, preco_cheio_cents, pagador_impressao
  ) values (
    p_org, p_ambiente, p_tipo, v_plan_id, v_ciclo, v_pacote_id, v_tokens,
    p_metodo, v_amount_cents, p_chave, p_actor, btrim(p_termos_versao),
    case when p_termos_versao is null then null else now() end,
    v_parcelas,
    v_cupom_id, v_desconto_cents, case when v_cupom_id is null then null else v_preco_cheio end,
    case when v_cupom_id is null then null else v_impressao end
  )
  returning id, external_reference into v_pedido_id, v_external_reference;

  return jsonb_build_object(
    'pedido_id', v_pedido_id,
    'external_reference', v_external_reference,
    'amount_cents', v_amount_cents,
    'parcelas', v_parcelas,
    'desconto_cents', v_desconto_cents,
    'cupom_id', v_cupom_id,
    'ja_existia', false,
    'proxima_cobranca_em', v_proxima_cobranca_em
  );
end;
$$;

comment on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer, text, text) is
  '0909, Tarefa 3, redefinida nas 0941, 0942, 0943, 0945 e 0955 (cupom de desconto): cria o pedido de compra. Todas as regras anteriores seguem (preço, plano, ciclo, pacote, tokens e total sempre do banco; Termos; parcelamento; troca de ciclo e de plano; idempotência pela chave). 0955: p_cupom_codigo (último, default nulo; sem ele o comportamento é o de antes). Com cupom, só na assinatura: valida pelo fn_billing_cupom_resolver (billing_cupom_invalido, billing_cupom_expirado, billing_cupom_esgotado, billing_cupom_ja_usado, billing_cupom_nao_vale_para_o_plano, billing_cupom_nao_vale_para_o_ciclo, billing_cupom_sem_desconto, billing_cupom_parcela_minima quando alguma parcela ficaria abaixo de 500 centavos), recusa o mesmo pagador (p_pagador_impressao, ou a da última compra com cupom da organização) que já pagou com o cupom, desconta o preço do ciclo com o piso de 500 centavos, o parcelamento calcula os juros sobre o preço já descontado (p_total_cents, se vier, é conferido; nulo é aceito com cupom), e grava cupom_id, desconto_cents, preco_cheio_cents e amount_cents final. O cupom faz parte da identidade da chave: a mesma chave com cupom diferente é billing_chave_com_valores_diferentes, e a repetição da mesma chave não revalida o cupom. Devolve também desconto_cents e cupom_id.';

revoke execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer, text, text) to service_role;

-- ── 5. Simulação e funções do admin ──
create or replace function public.fn_billing_cupom_simular(
  p_org uuid,
  p_codigo text,
  p_plan_code text,
  p_ciclo text,
  p_parcelas integer default 1
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan record;
  v_cfg record;
  v_preco integer;
  v_cupom jsonb;
  v_parcelas integer := coalesce(p_parcelas, 1);
  v_teto integer;
  v_total_ciclo integer;
  v_final integer;
begin
  if p_org is null or p_plan_code is null or p_ciclo is null or p_ciclo not in ('monthly', 'semiannual', 'yearly') then
    return jsonb_build_object('ok', false, 'erro', 'billing_dados_invalidos');
  end if;

  select * into v_plan from public.billing_plans where code = p_plan_code and active limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'plano_nao_encontrado_ou_inativo');
  end if;
  if not v_plan.for_sale then
    return jsonb_build_object('ok', false, 'erro', 'billing_plano_fora_de_venda');
  end if;

  v_preco := case p_ciclo
    when 'monthly' then v_plan.price_monthly_cents
    when 'semiannual' then v_plan.price_semiannual_cents
    else v_plan.price_yearly_cents
  end;
  if coalesce(v_preco, 0) <= 0 then
    return jsonb_build_object('ok', false, 'erro', 'billing_preco_nao_definido');
  end if;

  if v_parcelas < 1 or v_parcelas > 12 then
    return jsonb_build_object('ok', false, 'erro', 'billing_parcelas_invalidas');
  end if;
  if v_parcelas > 1 and p_ciclo not in ('semiannual', 'yearly') then
    return jsonb_build_object('ok', false, 'erro', 'billing_parcelamento_indisponivel');
  end if;

  begin
    v_cupom := public.fn_billing_cupom_resolver(p_org, p_codigo, p_plan_code, p_ciclo, v_preco, true, false);
  exception when sqlstate '22023' then
    if sqlerrm like 'billing_cupom_%' then
      return jsonb_build_object('ok', false, 'erro', sqlerrm);
    end if;
    raise;
  end;

  v_total_ciclo := (v_cupom ->> 'total_cents')::integer;
  v_final := v_total_ciclo;

  if v_parcelas > 1 then
    select parcelamento_taxa_mensal, parcelamento_sem_juros_ate,
           parcelamento_max_semestral, parcelamento_max_anual
      into v_cfg
      from public.billing_settings
      where id = 1;
    v_teto := coalesce(
      case p_ciclo when 'semiannual' then v_cfg.parcelamento_max_semestral else v_cfg.parcelamento_max_anual end,
      1
    );
    if v_parcelas > v_teto then
      return jsonb_build_object('ok', false, 'erro', 'billing_parcelas_acima_do_teto');
    end if;
    v_final := public.fn_billing_parcelamento_total(
      v_total_ciclo, v_parcelas, v_cfg.parcelamento_taxa_mensal, v_cfg.parcelamento_sem_juros_ate
    );
    if v_final < 500 * v_parcelas then
      return jsonb_build_object('ok', false, 'erro', 'billing_cupom_parcela_minima');
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'codigo', v_cupom ->> 'codigo',
    'tipo', v_cupom ->> 'tipo',
    'valor', (v_cupom ->> 'valor')::integer,
    'preco_cheio_cents', v_preco,
    'desconto_cents', (v_cupom ->> 'desconto_cents')::integer,
    'total_cents', v_total_ciclo,
    'parcelas', v_parcelas,
    'total_final_cents', v_final
  );
end;
$$;

comment on function public.fn_billing_cupom_simular(uuid, text, text, text, integer) is
  '0955: só leitura. Devolve {ok: true, codigo, tipo, valor, preco_cheio_cents, desconto_cents, total_cents (preço do ciclo com desconto, sem juros), parcelas, total_final_cents (com os juros do parcelamento, se houver)} ou {ok: false, erro: <código>}. As mesmas regras de fn_billing_criar_pedido (inclusive a parcela mínima de 500 centavos: erro billing_cupom_parcela_minima), sem criar pedido nem travar o cupom. A regra do mesmo pagador só vale na compra, porque o documento não passa por aqui. Só service_role.';

revoke execute on function public.fn_billing_cupom_simular(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.fn_billing_cupom_simular(uuid, text, text, text, integer) to service_role;

create or replace function public.fn_billing_cupom_criar(
  p_codigo text,
  p_tipo text,
  p_valor integer,
  p_planos text[],
  p_ciclos text[],
  p_valido_ate timestamptz,
  p_max_usos integer,
  p_descricao text,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_codigo text := btrim(coalesce(p_codigo, ''));
  v_planos text[];
  v_ciclos text[];
  v_id uuid;
  v_descricao text := nullif(btrim(coalesce(p_descricao, '')), '');
begin
  if v_codigo !~ '^[A-Za-z0-9_-]{3,40}$' then
    raise exception 'billing_cupom_codigo_invalido' using errcode = '22023';
  end if;
  if p_tipo is null or p_tipo not in ('percentual', 'valor') then
    raise exception 'billing_cupom_tipo_invalido' using errcode = '22023';
  end if;
  if p_valor is null
     or (p_tipo = 'percentual' and p_valor not between 1 and 99)
     or (p_tipo = 'valor' and p_valor <= 0)
  then
    raise exception 'billing_cupom_valor_invalido' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct x order by x), '{}') into v_planos from unnest(coalesce(p_planos, '{}')) as x;
  if exists (
    select 1 from unnest(v_planos) as c where not exists (select 1 from public.billing_plans bp where bp.code = c)
  ) then
    raise exception 'billing_cupom_plano_inexistente' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct x order by x), '{}') into v_ciclos from unnest(coalesce(p_ciclos, '{}')) as x;
  if not (v_ciclos <@ array['monthly', 'semiannual', 'yearly']::text[]) then
    raise exception 'billing_cupom_ciclo_invalido' using errcode = '22023';
  end if;

  if p_valido_ate is not null and p_valido_ate <= now() then
    raise exception 'billing_cupom_validade_invalida' using errcode = '22023';
  end if;
  if p_max_usos is not null and p_max_usos < 1 then
    raise exception 'billing_cupom_max_usos_invalido' using errcode = '22023';
  end if;
  if v_descricao is not null and length(v_descricao) > 200 then
    raise exception 'billing_cupom_descricao_longa' using errcode = '22023';
  end if;

  if exists (select 1 from public.billing_cupons where codigo = v_codigo::citext) then
    raise exception 'billing_cupom_codigo_em_uso' using errcode = '22023';
  end if;

  insert into public.billing_cupons (codigo, tipo, valor, planos, ciclos, valido_ate, max_usos, descricao, criado_por)
  values (v_codigo::citext, p_tipo, p_valor, v_planos, v_ciclos, p_valido_ate, p_max_usos, v_descricao, p_actor)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'codigo', v_codigo, 'tipo', p_tipo, 'valor', p_valor);
end;
$$;

comment on function public.fn_billing_cupom_criar(text, text, integer, text[], text[], timestamptz, integer, text, uuid) is
  '0955: cria um cupom. Erros 22023: billing_cupom_codigo_invalido, billing_cupom_tipo_invalido, billing_cupom_valor_invalido (percentual 1 a 99; valor > 0), billing_cupom_plano_inexistente, billing_cupom_ciclo_invalido, billing_cupom_validade_invalida (no passado), billing_cupom_max_usos_invalido, billing_cupom_descricao_longa, billing_cupom_codigo_em_uso. Só service_role.';

revoke execute on function public.fn_billing_cupom_criar(text, text, integer, text[], text[], timestamptz, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_cupom_criar(text, text, integer, text[], text[], timestamptz, integer, text, uuid) to service_role;

create or replace function public.fn_billing_cupom_definir_ativo(
  p_cupom uuid,
  p_ativo boolean,
  p_actor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_cupom public.billing_cupons%rowtype;
begin
  if p_ativo is null then
    raise exception 'billing_cupom_ativo_obrigatorio' using errcode = '22023';
  end if;

  select * into v_cupom from public.billing_cupons where id = p_cupom for update;
  if not found then
    raise exception 'billing_cupom_nao_encontrado' using errcode = 'P0002';
  end if;

  update public.billing_cupons set ativo = p_ativo where id = v_cupom.id;

  return jsonb_build_object(
    'id', v_cupom.id,
    'codigo', v_cupom.codigo::text,
    'ativo_anterior', v_cupom.ativo,
    'ativo_novo', p_ativo
  );
end;
$$;

comment on function public.fn_billing_cupom_definir_ativo(uuid, boolean, uuid) is
  '0955: ativa ou desativa um cupom. Desativar não mexe em pedido já criado. Cupom inexistente: P0002 billing_cupom_nao_encontrado. Só service_role.';

revoke execute on function public.fn_billing_cupom_definir_ativo(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_cupom_definir_ativo(uuid, boolean, uuid) to service_role;

create or replace function public.fn_billing_cupom_listar()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(x.linha order by x.criado desc, x.id), '[]'::jsonb)
  from (
    select c.created_at as criado, c.id as id,
           jsonb_build_object(
             'id', c.id,
             'codigo', c.codigo::text,
             'tipo', c.tipo,
             'valor', c.valor,
             'planos', to_jsonb(c.planos),
             'ciclos', to_jsonb(c.ciclos),
             'valido_ate', c.valido_ate,
             'max_usos', c.max_usos,
             'ativo', c.ativo,
             'descricao', c.descricao,
             'criado_em', c.created_at,
             'usos_pagos', (select count(*) from public.billing_orders o
                             where o.cupom_id = c.id and o.status in ('pago', 'estornado')),
             'usos_abertos', (select count(*) from public.billing_orders o
                               where o.cupom_id = c.id
                                 and o.status in ('criado', 'processando', 'aguardando_pagamento', 'inconclusivo')
                                 and o.created_at > now() - interval '24 hours')
           ) as linha
      from public.billing_cupons c
  ) x;
$$;

comment on function public.fn_billing_cupom_listar() is
  '0955: todos os cupons, do mais novo para o mais antigo (jsonb array), com usos_pagos (pedidos pagos ou estornados) e usos_abertos (pedidos abertos criados nas últimas 24 horas). Só service_role.';

revoke execute on function public.fn_billing_cupom_listar() from public, anon, authenticated;
grant execute on function public.fn_billing_cupom_listar() to service_role;

do $agent_worker_cupons$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke select, insert, update, delete, truncate on public.billing_cupons from agent_worker';
    execute 'revoke execute on function public.fn_billing_criar_pedido(uuid, text, text, text, text, text, text, uuid, uuid, text, integer, integer, text, text), public.fn_billing_cupom_simular(uuid, text, text, text, integer), public.fn_billing_cupom_criar(text, text, integer, text[], text[], timestamptz, integer, text, uuid), public.fn_billing_cupom_definir_ativo(uuid, boolean, uuid), public.fn_billing_cupom_listar() from agent_worker';
  end if;
end
$agent_worker_cupons$;

commit;

reset lock_timeout;
