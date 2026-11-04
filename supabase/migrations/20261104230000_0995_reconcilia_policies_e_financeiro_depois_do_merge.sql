-- 0995 (fork Hiperbold): o que faltava depois do merge do upstream de 04/11/2026.
-- Espelho idêntico no apêndice do supabase/baseline.sql, em duas partes: as funções antes da
-- VARREDURA anon e as policies e travas no fim do arquivo. Detalhe na linha do MANIFEST.

-- ---- o merge do upstream de 04/11/2026: funções que faltavam (migration 0995, fork Hiperbold) ----
--
-- Cria FUNÇÕES: entra ANTES da VARREDURA anon. Três coisas:
-- 1. `fn_ai_mcp_connections_slug_imutavel` (0901, fork) ganha `search_path` fixo (Security
--    Advisor, 0521 do upstream). O corpo não muda.
-- 2. `fn_financeiro_policies_por_papel()`: as policies por papel da 0923 num lugar só.
-- 3. `fn_financeiro_provisionar()` (0619 do upstream) chama a de cima antes de proteger as
--    tabelas: o módulo instalado depois do baseline nasce com a régua do fork, não com o
--    `for all` de agent.

create or replace function public.fn_ai_mcp_connections_slug_imutavel() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.slug is distinct from new.slug then
    raise exception 'ai_mcp_connections_slug_imutavel' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.fn_financeiro_policies_por_papel()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  -- Hiperbold (0995): a régua da 0923 (D-138, D-127) nas cinco tabelas do módulo financeiro,
  -- num lugar só. Chamada pela provisionadora (módulo instalado depois do baseline) e pelo
  -- apêndice do baseline (quem atualiza). Troca o par _read/_write do upstream (0619) e o
  -- `for all` antigo pelas policies por operação:
  --   sales: insert e update de agent; update só em comanda aberta; nenhum delete.
  --   sale_items: agent, só enquanto a comanda é aberta e da mesma organização.
  --   commission_rules: manager. commissions: só leitura. loyalty_ledger: só insert de agent.
  -- Escrita de admin de plataforma só no escopo full (0508, 0992). Tabela ausente: nada a fazer.
  -- Idempotente: drop if exists e create, dentro de uma transação só. Nomes por format(%I),
  -- como o bloco condicional da 0923: o update.sh de releases antigas lê `create policy <nome>`
  -- literal no arquivo como regra que TEM de existir no banco, e estas só existem com o módulo.
  if to_regclass('public.sales') is not null then
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sales_all', 'sales');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sales_read', 'sales');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sales_write', 'sales');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sales_select', 'sales');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sales_insert', 'sales');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sales_update', 'sales');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sales_delete', 'sales');
    execute format('create policy %I on public.%I for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()))', 'tenant_isolation_sales_select', 'sales');
    execute format('create policy %I on public.%I for insert with check (public.fn_is_platform_admin_full() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, ''agent'')))', 'tenant_isolation_sales_insert', 'sales');
    execute format('create policy %I on public.%I for update using (public.fn_is_platform_admin_full() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, ''agent'')) and status = ''open'')) with check (public.fn_is_platform_admin_full() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, ''agent'')))', 'tenant_isolation_sales_update', 'sales');
  end if;
  if to_regclass('public.sale_items') is not null then
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sale_items_all', 'sale_items');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sale_items_read', 'sale_items');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sale_items_write', 'sale_items');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sale_items_select', 'sale_items');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sale_items_insert', 'sale_items');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sale_items_update', 'sale_items');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_sale_items_delete', 'sale_items');
    execute format('create policy %I on public.%I for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()))', 'tenant_isolation_sale_items_select', 'sale_items');
    execute format('create policy %I on public.%I for insert with check (public.fn_is_platform_admin_full() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, ''agent'')) and exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.organization_id = sale_items.organization_id and s.status = ''open'')))', 'tenant_isolation_sale_items_insert', 'sale_items');
    execute format('create policy %I on public.%I for update using (public.fn_is_platform_admin_full() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, ''agent'')) and exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.organization_id = sale_items.organization_id and s.status = ''open''))) with check (public.fn_is_platform_admin_full() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, ''agent'')) and exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.organization_id = sale_items.organization_id and s.status = ''open'')))', 'tenant_isolation_sale_items_update', 'sale_items');
    execute format('create policy %I on public.%I for delete using (public.fn_is_platform_admin_full() or ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, ''agent'')) and exists (select 1 from public.sales s where s.id = sale_items.sale_id and s.organization_id = sale_items.organization_id and s.status = ''open'')))', 'tenant_isolation_sale_items_delete', 'sale_items');
  end if;
  if to_regclass('public.commission_rules') is not null then
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commission_rules_all', 'commission_rules');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commission_rules_read', 'commission_rules');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commission_rules_write', 'commission_rules');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commission_rules_select', 'commission_rules');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commission_rules_insert', 'commission_rules');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commission_rules_update', 'commission_rules');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commission_rules_delete', 'commission_rules');
    execute format('create policy %I on public.%I for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()))', 'tenant_isolation_commission_rules_select', 'commission_rules');
    execute format('create policy %I on public.%I for insert with check (public.fn_is_platform_admin_full() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, ''manager'')))', 'tenant_isolation_commission_rules_insert', 'commission_rules');
    execute format('create policy %I on public.%I for update using (public.fn_is_platform_admin_full() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, ''manager''))) with check (public.fn_is_platform_admin_full() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, ''manager'')))', 'tenant_isolation_commission_rules_update', 'commission_rules');
  end if;
  if to_regclass('public.commissions') is not null then
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commissions_all', 'commissions');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commissions_read', 'commissions');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commissions_write', 'commissions');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commissions_select', 'commissions');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commissions_insert', 'commissions');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commissions_update', 'commissions');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_commissions_delete', 'commissions');
    execute format('create policy %I on public.%I for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()))', 'tenant_isolation_commissions_select', 'commissions');
  end if;
  if to_regclass('public.loyalty_ledger') is not null then
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_loyalty_ledger_all', 'loyalty_ledger');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_loyalty_ledger_read', 'loyalty_ledger');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_loyalty_ledger_write', 'loyalty_ledger');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_loyalty_ledger_select', 'loyalty_ledger');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_loyalty_ledger_insert', 'loyalty_ledger');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_loyalty_ledger_update', 'loyalty_ledger');
    execute format('drop policy if exists %I on public.%I', 'tenant_isolation_loyalty_ledger_delete', 'loyalty_ledger');
    execute format('create policy %I on public.%I for select using ((organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()))', 'tenant_isolation_loyalty_ledger_select', 'loyalty_ledger');
    execute format('create policy %I on public.%I for insert with check (public.fn_is_platform_admin_full() or (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, ''agent'')))', 'tenant_isolation_loyalty_ledger_insert', 'loyalty_ledger');
  end if;
end
$f$;
revoke execute on function public.fn_financeiro_policies_por_papel() from public, anon, authenticated, service_role;

create or replace function public.fn_financeiro_provisionar()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin

  -- ─── a comanda ───────────────────────────────────────────────────────────────
  create table if not exists public.sales (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,

    -- Número visível, por organização. `bigint` e não `serial`: a sequência é
    -- própria de cada tenant (ver `fn_proximo_numero_de_comanda`), e um serial
    -- global vazaria o volume de um cliente para outro.
    number bigint not null,

    contact_id uuid references public.contacts(id) on delete set null,
    -- Quem atendeu. `set null` porque a pessoa pode sair da equipe e a venda
    -- continua tendo acontecido.
    attendant_user_id uuid references auth.users(id) on delete set null,
    appointment_id uuid references public.calendar_appointments(id) on delete set null,

    status text not null default 'open'
      check (status in ('open', 'finalized', 'cancelled')),

    -- Desconto da COMANDA, separado do desconto de item. Fidelidade e comissão
    -- incidem sobre o item, nunca sobre este — senão um desconto de caixa
    -- reduziria o prêmio de quem atendeu.
    discount_cents bigint not null default 0 check (discount_cents >= 0),
    total_cents bigint not null default 0,
    currency text not null default 'BRL' check (char_length(currency) = 3),

    payment_method_id uuid references public.payment_methods(id) on delete restrict,

    notes text,
    finalized_at timestamptz,
    cancelled_at timestamptz,
    cancel_reason text,
    -- Estornada: a comanda continua finalizada e ganha o contra-lançamento.
    reversed_at timestamptz,
    reverse_reason text,

    created_by_user_id uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- Finalizar exige forma de pagamento: é ela que diz em que conta o dinheiro
    -- cai. Sem isso, a entrada não teria destino — e o CHECK diz isso no schema,
    -- não numa validação que alguém pode esquecer de chamar.
    constraint sales_finalizada_tem_forma
      check (status <> 'finalized' or payment_method_id is not null)
  );

  create unique index if not exists sales_org_numero_key on public.sales (organization_id, number);
  create index if not exists sales_org_status_idx on public.sales (organization_id, status, created_at desc);
  create index if not exists sales_org_contato_idx on public.sales (organization_id, contact_id);
  create index if not exists sales_appointment_idx on public.sales (appointment_id)
    where appointment_id is not null;

  -- ─── o item ──────────────────────────────────────────────────────────────────
  create table if not exists public.sale_items (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    -- `cascade` aqui e só aqui: item não existe fora da comanda, e comanda não é
    -- apagada (cancela). O cascade só dispara se a ORGANIZAÇÃO inteira sair.
    sale_id uuid not null references public.sales(id) on delete cascade,

    -- O que foi feito. `event_type_id` porque, neste produto, o catálogo de
    -- serviços JÁ é `calendar_event_types` — criar uma tabela de serviços ao lado
    -- seria a segunda fonte da mesma verdade.
    event_type_id uuid references public.calendar_event_types(id) on delete restrict,
    -- Congelado na inclusão: o nome muda, a linha da venda não.
    description text not null,

    attendant_user_id uuid references auth.users(id) on delete set null,

    quantity integer not null default 1 check (quantity > 0),
    unit_price_cents bigint not null check (unit_price_cents >= 0),
    discount_cents bigint not null default 0 check (discount_cents >= 0),
    total_cents bigint not null,

    -- ⚠️ RESOLVIDA NA INCLUSÃO e gravada aqui. A finalização não recalcula:
    -- mudar a regra amanhã não mexe no que já foi combinado ontem.
    commission_percent numeric(5, 2) not null default 0
      check (commission_percent >= 0 and commission_percent <= 100),

    created_at timestamptz not null default now()
  );

  create index if not exists sale_items_sale_idx on public.sale_items (sale_id);
  create index if not exists sale_items_org_idx on public.sale_items (organization_id, created_at desc);

  -- ─── a regra de comissão ─────────────────────────────────────────────────────
  --
  -- Precedência: (pessoa + serviço) → (pessoa) → (serviço). A mais específica
  -- vence, e é por isso que as três colunas são nullable com um índice único por
  -- combinação — não há linha "curinga" mágica, há ausência.
  create table if not exists public.commission_rules (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,

    attendant_user_id uuid references auth.users(id) on delete cascade,
    event_type_id uuid references public.calendar_event_types(id) on delete cascade,

    percent numeric(5, 2) not null check (percent >= 0 and percent <= 100),

    created_at timestamptz not null default now(),

    -- Pelo menos um dos dois: uma regra sem pessoa E sem serviço seria a regra
    -- "de tudo", que é o default da organização e mora em outro lugar.
    constraint commission_rules_tem_alvo
      check (attendant_user_id is not null or event_type_id is not null)
  );

  -- `coalesce` no índice: NULL não colide com NULL numa UNIQUE, e sem isto duas
  -- regras "só para a Ana" passariam as duas, em silêncio.
  create unique index if not exists commission_rules_alvo_key on public.commission_rules (
    organization_id,
    coalesce(attendant_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(event_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

  -- ─── a comissão gerada ───────────────────────────────────────────────────────
  create table if not exists public.commissions (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    sale_item_id uuid not null references public.sale_items(id) on delete cascade,
    attendant_user_id uuid not null references auth.users(id) on delete restrict,

    percent numeric(5, 2) not null,
    amount_cents bigint not null,

    status text not null default 'pending' check (status in ('pending', 'paid', 'reversed')),
    paid_at timestamptz,
    reversed_at timestamptz,

    created_at timestamptz not null default now()
  );

  create unique index if not exists commissions_item_key on public.commissions (sale_item_id);
  create index if not exists commissions_org_pessoa_idx
    on public.commissions (organization_id, attendant_user_id, status);

  -- ─── o livro-razão da fidelidade ─────────────────────────────────────────────
  --
  -- LEDGER, não saldo. O saldo do cliente é `sum(points)` e nunca uma coluna:
  -- guardar o saldo faria o primeiro estorno divergir em silêncio.
  create table if not exists public.loyalty_ledger (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    contact_id uuid not null references public.contacts(id) on delete cascade,

    -- Assinado: ganhar é positivo, resgatar é negativo. Uma coluna de "tipo" ao
    -- lado seria a segunda forma de dizer o mesmo sinal.
    points integer not null,
    reason text not null,

    sale_id uuid references public.sales(id) on delete set null,
    sale_item_id uuid references public.sale_items(id) on delete set null,

    -- Idempotência do ganho: finalizar a mesma comanda duas vezes não dá ponto
    -- em dobro. A UNIQUE parcial é a garantia, não a boa intenção de quem chama.
    idempotency_key text,

    created_by_user_id uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
  );

  create unique index if not exists loyalty_ledger_idem_key
    on public.loyalty_ledger (organization_id, idempotency_key)
    where idempotency_key is not null;
  create index if not exists loyalty_ledger_contato_idx
    on public.loyalty_ledger (organization_id, contact_id, created_at desc);
  -- 0354 — a regra de comissão entra no catálogo, e para isso INATIVA em vez de
  -- sumir: o percentual já aplicado está congelado no item, então apagar perderia
  -- a resposta a "por que aquela comanda saiu com este percentual".
  alter table public.commission_rules
    add column if not exists name text not null default 'Regra de comissão';

  alter table public.commission_rules
    add column if not exists is_active boolean not null default true;

  comment on column public.commission_rules.is_active is
    'Regra em vigor. Inativa em vez de apagar: o percentual já aplicado está congelado no item, e o que se perderia é a resposta a "por que aquela comanda saiu com este percentual".';

  create index if not exists commission_rules_org_ativas_idx
    on public.commission_rules (organization_id, event_type_id, attendant_user_id)
    where is_active;

  -- 0352 — uma comanda por agendamento. PARCIAL nas duas condições: comanda avulsa
  -- é a maioria e não se exclui de comanda de agendamento, e comanda cancelada
  -- deixa de valer (sem isto, cancelar por engano trancaria o agendamento para
  -- sempre, sem conserto pela tela).
  create unique index if not exists sales_agendamento_unico_idx
    on public.sales (organization_id, appointment_id)
    where appointment_id is not null and status <> 'cancelled';

  -- Os comentários das tabelas da comanda moram AQUI, e não no bloco do RLS do
  -- núcleo: `comment on table` no baseline recriaria as tabelas num banco onde o
  -- módulo não está instalado — que é exatamente o que a D2 proíbe.
  comment on table public.sales is
    'A comanda. Cancela, nunca apaga. `number` é sequencial por organização e não reinicia.';
  comment on table public.loyalty_ledger is
    'Livro-razão de fidelidade. O saldo do cliente é sum(points) — NUNCA uma coluna.';

  -- A FK do caixa (`financial_entries.sale_id → sales.id`) SAIU do corpo: molde da
  -- onda 10 proíbe corpo de provisionadora alterar tabela do núcleo. Ela passou a
  -- `fn_financeiro_ligar_caixa_a_comanda()`, definida no fim do bloco desta
  -- migration (mesmo código da cadeia, gate `apendice-do-baseline-nao-diverge`):
  -- a provisionadora chama a rotina, e o topo também — onde a comanda já existe,
  -- a FK nasce na própria passada do kit. A conferência é por EXISTÊNCIA de
  -- qualquer FK da relação, para não criar a segunda onde já há
  -- `financial_entries_sale_id_fkey` (item 5 do #1907).

  -- ── RLS das cinco tabelas, declarada por ESTA função (#1906 + D5) ──────────
  -- A rotina 0325 (`fn_proteger_tabelas_de_organizacao`) só enxerga tabela com
  -- RLS DESLIGADA: ligando aqui a decisão do módulo prevalece, e o `revoke` de
  -- `anon` vem junto porque é a MESMA rotina que o faria — se ela não enxerga a
  -- tabela, ela não faz por nós.
  --
  -- Cada `create policy` deste corpo ocupa DUAS linhas de propósito (issue
  -- #1906): a conferência antiga do `update.sh` (v1.39.0 a v1.63.0) casava o
  -- nome da policy e o `on public.` na MESMA linha e abortava a atualização
  -- de quem tem o módulo instalado. É a quebra entre as duas linhas que tira
  -- a regra do olhar daquela varredura sem tirar a regra da tabela.
  --
  -- 0533 (#2115): o `tenant_isolation_<t>_all` virou o PAR `_read`/`_write`,
  -- o mesmo desenho que o baseline dá a `financial_entries` no núcleo. Leitura
  -- com a função pura (o `support_readonly` continua LENDO a comanda); escrita
  -- com `scope='full'` e papel `agent+` — era isso que a política larga escondia:
  -- sem o par, quem só lê escrevia a comanda inteira. O `drop ... _all` fica em
  -- cada bloco para o reaplicar (D6) converter banco provisionado pela versão
  -- antiga do corpo, e o par nasce AQUI porque a rotina 0325 só enxerga tabela
  -- com RLS DESLIGADA — estas já nascem ligadas.
  alter table public.sales enable row level security;
  revoke all on public.sales from anon;
  drop policy if exists tenant_isolation_sales_all on public.sales;
  drop policy if exists tenant_isolation_sales_read on public.sales;
  create policy tenant_isolation_sales_read
    on public.sales for select
    using (organization_id in (select public.fn_user_org_ids())
           or public.fn_is_platform_admin());
  drop policy if exists tenant_isolation_sales_write on public.sales;
  create policy tenant_isolation_sales_write
    on public.sales for all
    using (organization_id in (select public.fn_user_org_ids())
           or public.fn_is_platform_admin_full())
    with check (
      public.fn_is_platform_admin_full()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'agent'))
    );

  alter table public.sale_items enable row level security;
  revoke all on public.sale_items from anon;
  drop policy if exists tenant_isolation_sale_items_all on public.sale_items;
  drop policy if exists tenant_isolation_sale_items_read on public.sale_items;
  create policy tenant_isolation_sale_items_read
    on public.sale_items for select
    using (organization_id in (select public.fn_user_org_ids())
           or public.fn_is_platform_admin());
  drop policy if exists tenant_isolation_sale_items_write on public.sale_items;
  create policy tenant_isolation_sale_items_write
    on public.sale_items for all
    using (organization_id in (select public.fn_user_org_ids())
           or public.fn_is_platform_admin_full())
    with check (
      public.fn_is_platform_admin_full()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'agent'))
    );

  alter table public.commission_rules enable row level security;
  revoke all on public.commission_rules from anon;
  drop policy if exists tenant_isolation_commission_rules_all on public.commission_rules;
  drop policy if exists tenant_isolation_commission_rules_read on public.commission_rules;
  create policy tenant_isolation_commission_rules_read
    on public.commission_rules for select
    using (organization_id in (select public.fn_user_org_ids())
           or public.fn_is_platform_admin());
  drop policy if exists tenant_isolation_commission_rules_write on public.commission_rules;
  create policy tenant_isolation_commission_rules_write
    on public.commission_rules for all
    using (organization_id in (select public.fn_user_org_ids())
           or public.fn_is_platform_admin_full())
    with check (
      public.fn_is_platform_admin_full()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'agent'))
    );

  alter table public.commissions enable row level security;
  revoke all on public.commissions from anon;
  drop policy if exists tenant_isolation_commissions_all on public.commissions;
  drop policy if exists tenant_isolation_commissions_read on public.commissions;
  create policy tenant_isolation_commissions_read
    on public.commissions for select
    using (organization_id in (select public.fn_user_org_ids())
           or public.fn_is_platform_admin());
  drop policy if exists tenant_isolation_commissions_write on public.commissions;
  create policy tenant_isolation_commissions_write
    on public.commissions for all
    using (organization_id in (select public.fn_user_org_ids())
           or public.fn_is_platform_admin_full())
    with check (
      public.fn_is_platform_admin_full()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'agent'))
    );

  alter table public.loyalty_ledger enable row level security;
  revoke all on public.loyalty_ledger from anon;
  drop policy if exists tenant_isolation_loyalty_ledger_all on public.loyalty_ledger;
  drop policy if exists tenant_isolation_loyalty_ledger_read on public.loyalty_ledger;
  create policy tenant_isolation_loyalty_ledger_read
    on public.loyalty_ledger for select
    using (organization_id in (select public.fn_user_org_ids())
           or public.fn_is_platform_admin());
  drop policy if exists tenant_isolation_loyalty_ledger_write on public.loyalty_ledger;
  create policy tenant_isolation_loyalty_ledger_write
    on public.loyalty_ledger for all
    using (organization_id in (select public.fn_user_org_ids())
           or public.fn_is_platform_admin_full())
    with check (
      public.fn_is_platform_admin_full()
      or (organization_id in (select public.fn_user_org_ids())
          and public.fn_role_at_least(organization_id, 'agent'))
    );

    -- D5: a proteção na MESMA transação. Sem esta linha a tabela nasce com a anon
    -- key podendo ler tudo — `baseline.sql:4748` dá, por
    -- `alter default privileges`, privilégio total a `anon` no que nasce depois.
    -- Hiperbold (0995): as policies por papel da 0923 (D-138, D-127) substituem o par
    -- _read/_write amplo acima, na MESMA transação. Sem isto quem instala o módulo depois do
    -- baseline recebe a escrita `for all` de agent, com delete, em vez da régua do fork.
    perform public.fn_financeiro_policies_por_papel();

    perform public.fn_proteger_modulo_provisionado();

    -- A comanda alcançada por SEÇÃO declarada (D8, migration 0485), não por passo
    -- escrito na cascata: `notes`/`cancel_reason`/`reverse_reason` são texto da
    -- pessoa, e a redação passou a acontecer no gatilho `trg_lgpd_secoes_de_modulo`,
    -- nos DOIS caminhos de anonimização — sem o núcleo nomear `sales`.
    perform public.fn_financeiro_declarar_secoes_lgpd();

    -- A FK do caixa, que o molde não deixa o corpo criar: sai para a rotina própria
    -- do fim do bloco, com guarda de `to_regclass` e conferência de qualquer FK.
    perform public.fn_financeiro_ligar_caixa_a_comanda();
  end
$f$;
revoke execute on function public.fn_financeiro_provisionar() from public, anon, authenticated;
grant execute on function public.fn_financeiro_provisionar() to service_role;

-- ---- o merge do upstream de 04/11/2026: o que a cadeia de migrations reabria (migration 0995, fork Hiperbold) ----
--
-- Na cadeia de migrations, duas do upstream rodam DEPOIS das do fork e desfazem a régua dele:
-- a 0508 (01/10) recria pares _read/_write que o fork tinha trocado por SELECT de membro e
-- escrita por papel (0926, 0932), e a 0529/0533 (03 e 04/10) redefinem a escrita de
-- messages, crm_lead_activities e crm_lead_links só por pertencer à organização, sem o papel
-- da 0932. Aqui os pares saem e as policies voltam à forma da instalação (0932 com o admin de
-- plataforma só no escopo full). No baseline é no-op: as linhas já estão assim.
-- O mesmo par saía de volta nas quatro tabelas do caixa (financial_entries e afins).
-- Por último, as travas do suporte de novo: a 0992 tirou a escrita da sessão de quatro tabelas
-- DEPOIS da última chamada, e as `support_write_*` delas sobravam.

do $hb_0995_pares_da_0508$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists tenant_isolation_ai_invocations_read on public.ai_invocations;
 drop policy if exists tenant_isolation_ai_invocations_write on public.ai_invocations;
 drop policy if exists warmup_tenant_isolation_read on public.channel_session_warmup;
 drop policy if exists warmup_tenant_isolation_write on public.channel_session_warmup;
 drop policy if exists tenant_isolation_contacts_read on public.contacts;
 drop policy if exists tenant_isolation_contacts_write on public.contacts;
 drop policy if exists nuvemshop_products_read on public.nuvemshop_products;
 drop policy if exists nuvemshop_products_tenant_write on public.nuvemshop_products;
 drop policy if exists orders_tenant_write on public.orders;
end
$hb_0995_pares_da_0508$;

do $hb_0995_messages$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists messages_insert on public.messages;
 create policy messages_insert on public.messages for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin_full());
 drop policy if exists messages_update on public.messages;
 create policy messages_update on public.messages for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin_full()) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin_full());
 drop policy if exists messages_delete on public.messages;
 create policy messages_delete on public.messages for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin_full());
end
$hb_0995_messages$;

do $hb_0995_crm_lead_activities$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists crm_lead_activities_insert on public.crm_lead_activities;
 create policy crm_lead_activities_insert on public.crm_lead_activities for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin_full());
end
$hb_0995_crm_lead_activities$;

do $hb_0995_crm_lead_links$
begin
 perform set_config('lock_timeout','3s',true);
 drop policy if exists crm_lead_links_insert on public.crm_lead_links;
 create policy crm_lead_links_insert on public.crm_lead_links for insert with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'agent')) or public.fn_is_platform_admin_full());
 drop policy if exists crm_lead_links_update on public.crm_lead_links;
 create policy crm_lead_links_update on public.crm_lead_links for update using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')) or public.fn_is_platform_admin_full()) with check ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')) or public.fn_is_platform_admin_full());
 drop policy if exists crm_lead_links_delete on public.crm_lead_links;
 create policy crm_lead_links_delete on public.crm_lead_links for delete using ((organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')) or public.fn_is_platform_admin_full());
end
$hb_0995_crm_lead_links$;

-- As quatro tabelas do caixa que ficaram no núcleo também ganharam do upstream (0533) o par
-- _read/_write: o _write é `for all` com USING só de membro, e somava por OR com as policies por
-- operação da 0923, devolvendo ao viewer o DELETE de lançamento pago. O par sai; a régua da 0923
-- (já no banco, nos blocos dela) fica sozinha.
do $hb_0995_caixa$
declare t text;
begin
 perform set_config('lock_timeout','3s',true);
 foreach t in array array['financial_entries','financial_accounts','payment_methods','account_plans'] loop
  if exists (select 1 from pg_policy where polrelid = ('public.'||t)::regclass and polname = 'tenant_isolation_'||t||'_select') then
   execute format('drop policy if exists %I on public.%I', 'tenant_isolation_'||t||'_read', t);
   execute format('drop policy if exists %I on public.%I', 'tenant_isolation_'||t||'_write', t);
  end if;
 end loop;
end
$hb_0995_caixa$;

do $hb_0995_financeiro$ begin perform public.fn_financeiro_policies_por_papel(); end $hb_0995_financeiro$;

do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
