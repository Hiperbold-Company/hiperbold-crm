-- ============================================================================
-- 0972 — PRODUTOS NO NEGÓCIO: preço fixo ou variável no catálogo e itens na
-- ficha do negócio, com o valor do negócio somado pelo banco.
--
-- Pedido do dono do produto (20/10/2026). Três mudanças que andam juntas:
--
-- 1. `catalog_products.tipo_de_preco` ('fixo' | 'variavel') e `preco_cents`
--    deixa de ser `not null`. Produto de valor variável (serviço sob medida,
--    orçamento) não tem preço de tabela: o atendente define o valor dentro de
--    cada negócio, e o agente de IA NÃO cota preço dele.
--
-- 2. `crm_lead_itens`: os produtos de UM negócio, cada um com quantidade e valor
--    unitário. Tabela nova, tenant-aware, com a visibilidade do negócio-pai.
--
-- 3. O VALOR DO NEGÓCIO (`crm_leads.value_cents`) passa a ser a SOMA dos itens
--    quando o negócio tem itens. Negócio sem itens continua com o valor digitado
--    à mão, como sempre foi.
--
-- ─── Por que a soma mora em GATILHO, e não na rota ───────────────────────────
--
-- O valor do negócio é escrito por muitos caminhos que não passam pela rota de
-- itens: o formulário da ficha (PATCH do lead), a importação de planilha, a
-- automação "criar ou mover negócio", o MCP, o lote. Se a soma morasse na rota,
-- cada um desses caminhos poderia sobrescrever o total com um número digitado e
-- o negócio passaria a dizer R$ 100 com itens que somam R$ 300 — o defeito que
-- a doutrina DIRC chama de "campo sincronizado à mão": o total é CALCULÁVEL
-- (letra C), então ele não pode ter um segundo dono.
--
-- Dois gatilhos, uma regra:
--   a) depois de inserir, alterar ou apagar um item, o valor do negócio vira a
--      soma dos itens (`fn_crm_lead_itens_recalcula_valor`);
--   b) antes de alterar `value_cents` de um negócio que TEM itens, o valor
--      gravado é a soma dos itens, qualquer que seja o que o chamador mandou
--      (`fn_crm_leads_valor_pelos_itens`).
-- Nenhum dos dois faz HTTP (CLAUDE.md, anti-pattern 9): é aritmética na mesma
-- transação da escrita.
--
-- Apagar o ÚLTIMO item não zera o valor: o negócio volta a ser "valor à mão" e
-- fica com o último total, que a pessoa edita na própria ficha. Zerar apagaria
-- um número que ela provavelmente quer ver.
--
-- A soma arredonda item a item (`round(quantidade * valor_unitario_cents)`), e
-- não o total: a tela mostra o subtotal de cada linha em centavos inteiros, e a
-- soma dos subtotais que ela mostra tem de ser o total que o banco guarda.
--
-- Os dois gatilhos são SECURITY DEFINER: a soma não pode depender do que a RLS
-- deixa o chamador enxergar. Quem pode ESCREVER um item já foi decidido pela
-- policy da tabela; o total é consequência, não uma segunda permissão. Nenhum é
-- RPC: EXECUTE revogado de todos.
--
-- ─── Por que `product_id` é `on delete set null` com `nome_snapshot` ─────────
--
-- Apagar um produto do catálogo não pode apagar o histórico de negócios que o
-- venderam, nem ser barrado por ele (a tela tem "Desativar", mas o DELETE da API
-- existe). O nome vai copiado para o item no momento da inclusão: o negócio
-- continua dizendo o que foi vendido mesmo que o catálogo mude ou o produto saia.
--
-- Tetos (auditoria de 20/10/2026): subtotal da linha <= 9e13 centavos, nome <= 300, no máximo 100 itens por
-- negócio (gatilho com lock do negócio) e escrita só do admin de plataforma COMPLETO.
--
-- Idempotente: `if not exists`, `create or replace`, `drop ... if exists`.
-- Aditiva: o default 'fixo' satisfaz o CHECK em toda linha existente.
-- ============================================================================

-- ---- 1. catálogo: preço fixo ou variável ----------------------------------

alter table public.catalog_products
  add column if not exists tipo_de_preco text not null default 'fixo';

alter table public.catalog_products
  drop constraint if exists catalog_products_tipo_de_preco_valido;
alter table public.catalog_products
  add constraint catalog_products_tipo_de_preco_valido
  check (tipo_de_preco in ('fixo', 'variavel'));

-- Variável não tem preço de tabela. O `check (preco_cents >= 0)` da 0204 segue
-- valendo: NULL passa em CHECK, e o que o NULL não pode é morar num produto fixo.
alter table public.catalog_products alter column preco_cents drop not null;

alter table public.catalog_products
  drop constraint if exists catalog_products_fixo_tem_preco;
alter table public.catalog_products
  add constraint catalog_products_fixo_tem_preco
  check (tipo_de_preco = 'variavel' or preco_cents is not null);

comment on column public.catalog_products.tipo_de_preco is
  'fixo = preco_cents é o preço de tabela (o agente de IA o cota). variavel = sem preço de tabela: o atendente define o valor dentro de cada negócio e o agente NÃO cota preço.';
comment on column public.catalog_products.preco_cents is
  'Preço de tabela em centavos. Obrigatório quando tipo_de_preco = fixo; nulo (a rota grava nulo) quando variavel.';

-- ---- 2. os itens do negócio ------------------------------------------------

create table if not exists public.crm_lead_itens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  -- set null + snapshot: ver o cabeçalho.
  product_id uuid references public.catalog_products(id) on delete set null,
  nome_snapshot text not null,
  quantidade numeric not null default 1,
  valor_unitario_cents bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint crm_lead_itens_quantidade_positiva check (quantidade > 0 and quantidade <= 1000000),
  constraint crm_lead_itens_valor_nao_negativo check (valor_unitario_cents >= 0 and valor_unitario_cents <= 100000000000),
  constraint crm_lead_itens_nome_nao_vazio check (length(btrim(nome_snapshot)) > 0)
);

create index if not exists crm_lead_itens_lead_idx
  on public.crm_lead_itens (lead_id, created_at);
-- A FK de produto precisa de índice para o `set null` do DELETE do catálogo não varrer a tabela.
create index if not exists crm_lead_itens_produto_idx
  on public.crm_lead_itens (product_id) where product_id is not null;
create index if not exists crm_lead_itens_org_idx
  on public.crm_lead_itens (organization_id);

drop trigger if exists trg_crm_lead_itens_updated_at on public.crm_lead_itens;
create trigger trg_crm_lead_itens_updated_at
  before update on public.crm_lead_itens
  for each row execute function public.fn_set_updated_at();

alter table public.crm_lead_itens enable row level security;

-- LEITURA: a organização do item E a mesma visibilidade do negócio-pai
-- (`fn_can_view_lead`, por EXISTS no lead_id — a lição G4-01 da 0042: um scalar
-- de dono devolveria NULL para o negócio oculto e trataria como fila).
drop policy if exists tenant_isolation_crm_lead_itens_select on public.crm_lead_itens;
create policy tenant_isolation_crm_lead_itens_select on public.crm_lead_itens
  for select using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_itens.lead_id
           and l.organization_id = crm_lead_itens.organization_id
           and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
      )
    )
  );

-- ESCRITA: `agent` para cima (viewer é só leitura), sobre negócio que o chamador
-- enxerga. Um comando por policy: `for all` deixaria o `using` governar o SELECT.
-- O bypass do admin de plataforma é o COMPLETO (`fn_is_platform_admin_full`):
-- `support_readonly` e sessão sem o segundo fator (aal1) leem, mas não escrevem.
drop policy if exists tenant_isolation_crm_lead_itens_insert on public.crm_lead_itens;
create policy tenant_isolation_crm_lead_itens_insert on public.crm_lead_itens
  for insert with check (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_itens.lead_id
           and l.organization_id = crm_lead_itens.organization_id
           and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
      )
    )
  );

drop policy if exists tenant_isolation_crm_lead_itens_update on public.crm_lead_itens;
create policy tenant_isolation_crm_lead_itens_update on public.crm_lead_itens
  for update using (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_itens.lead_id
           and l.organization_id = crm_lead_itens.organization_id
           and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
      )
    )
  ) with check (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_itens.lead_id
           and l.organization_id = crm_lead_itens.organization_id
           and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
      )
    )
  );

drop policy if exists tenant_isolation_crm_lead_itens_delete on public.crm_lead_itens;
create policy tenant_isolation_crm_lead_itens_delete on public.crm_lead_itens
  for delete using (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = crm_lead_itens.lead_id
           and l.organization_id = crm_lead_itens.organization_id
           and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
      )
    )
  );

-- O `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon` do baseline
-- alcança toda tabela criada depois dele. Sem o revoke, os itens (nome e preço
-- de venda por negócio) ficam legíveis pela anon key, que vai para o browser.
revoke all on public.crm_lead_itens from anon;
grant select, insert, update, delete on public.crm_lead_itens to authenticated;
grant all on public.crm_lead_itens to service_role;
-- O default ACL do Supabase concede também TRUNCATE, REFERENCES e TRIGGER a `authenticated`, e o `grant`
-- acima só acrescenta. TRUNCATE ignora RLS e esvaziaria os itens de TODAS as organizações. (`service_role`
-- segue com tudo, como nas demais tabelas de dados; só a auditoria é append-only, migration 0258.)
revoke truncate, references, trigger on public.crm_lead_itens from authenticated;

comment on table public.crm_lead_itens is
  'Os produtos de UM negócio (quantidade e valor unitário). Com itens, crm_leads.value_cents é a soma deles, mantida por gatilho (0972). product_id é set null: o nome fica copiado em nome_snapshot.';
comment on column public.crm_lead_itens.nome_snapshot is
  'Nome do produto no momento da inclusão. O negócio continua dizendo o que vendeu se o catálogo mudar ou o produto for apagado.';
comment on column public.crm_lead_itens.valor_unitario_cents is
  'Valor de UMA unidade, em centavos. Produto fixo nasce com o preço do catálogo (editável); produto variável nasce vazio e é definido aqui.';

-- ---- 3a. o negócio, filho de uma só organização -----------------------------
-- O negócio e o produto do item têm de ser da organização do item. A FK só
-- garante que o pai existe, não de QUAL organização ele é (mesma classe da 0938).
-- Security definer: o pai de outra organização é invisível para quem escreve.

create or replace function public.fn_crm_lead_itens_vinculos_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.crm_leads p
     where p.id = new.lead_id
       and p.organization_id is distinct from new.organization_id
  ) then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;

  if new.product_id is not null
     and (tg_op = 'INSERT' or new.product_id is distinct from old.product_id
          or new.organization_id is distinct from old.organization_id)
     and exists (
       select 1 from public.catalog_products p
        where p.id = new.product_id
          and p.organization_id is distinct from new.organization_id
     ) then
    raise exception 'Registro vinculado não encontrado.' using errcode = '23503';
  end if;

  return new;
end;
$$;

revoke execute on function public.fn_crm_lead_itens_vinculos_da_organizacao() from public, anon, authenticated;

drop trigger if exists trg_crm_lead_itens_vinculos_da_organizacao on public.crm_lead_itens;
create trigger trg_crm_lead_itens_vinculos_da_organizacao
  before insert or update of lead_id, product_id, organization_id on public.crm_lead_itens
  for each row execute function public.fn_crm_lead_itens_vinculos_da_organizacao();

-- ---- tetos: subtotal seguro para o JavaScript, nome curto, no máximo 100 itens ----
-- `quantidade <= 1.000.000` e `valor <= 1e11` sozinhos deixam o produto passar de 1e17, acima do inteiro
-- seguro do JavaScript (9,007e15): a soma na tela e a do banco divergiriam. O teto do SUBTOTAL da linha é
-- 9e13 centavos; com no máximo 100 itens por negócio a soma fica abaixo de Number.MAX_SAFE_INTEGER.
-- Constraints em `alter` (e não só no `create table`) para um banco que já tem a tabela receber o teto.
alter table public.crm_lead_itens
  drop constraint if exists crm_lead_itens_subtotal_teto;
alter table public.crm_lead_itens
  add constraint crm_lead_itens_subtotal_teto
  check (round(quantidade * valor_unitario_cents) <= 90000000000000);

alter table public.crm_lead_itens
  drop constraint if exists crm_lead_itens_nome_curto;
alter table public.crm_lead_itens
  add constraint crm_lead_itens_nome_curto
  check (length(nome_snapshot) <= 300);

-- No máximo 100 itens por negócio, NO BANCO. A rota também confere (mensagem melhor), mas a rota não é a única
-- porta: o PostgREST atende direto. O lock da linha do negócio (`for no key update`, que não conflita com o
-- `for key share` da FK) faz duas inserções simultâneas passarem uma de cada vez pela contagem.
-- Security definer: a contagem não pode depender do que a RLS deixa o chamador ver. Não é RPC.
create or replace function public.fn_crm_lead_itens_limite_por_negocio()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from public.crm_leads l where l.id = new.lead_id for no key update;
  if (select count(*) from public.crm_lead_itens i where i.lead_id = new.lead_id) >= 100 then
    raise exception 'Esse negócio já tem o máximo de produtos.' using errcode = 'PT422';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_crm_lead_itens_limite_por_negocio() from public, anon, authenticated;

drop trigger if exists trg_crm_lead_itens_limite_por_negocio on public.crm_lead_itens;
create trigger trg_crm_lead_itens_limite_por_negocio
  before insert on public.crm_lead_itens
  for each row execute function public.fn_crm_lead_itens_limite_por_negocio();

-- ---- 3b. o item mexeu: o valor do negócio vira a soma -----------------------

create or replace function public.fn_crm_lead_itens_recalcula_valor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lead uuid;
  v_soma bigint;
  v_itens bigint;
begin
  -- O item pode mudar de negócio num UPDATE: os dois totais se refazem.
  for v_lead in
    select distinct x from unnest(array[
      case when tg_op in ('UPDATE', 'DELETE') then old.lead_id end,
      case when tg_op in ('INSERT', 'UPDATE') then new.lead_id end
    ]) as x where x is not null
  loop
    select count(*), coalesce(sum(round(i.quantidade * i.valor_unitario_cents)), 0)::bigint
      into v_itens, v_soma
      from public.crm_lead_itens i
     where i.lead_id = v_lead;

    -- Sem itens o valor é do usuário: não se escreve nada. E só se escreve quando
    -- muda, para não acordar os demais gatilhos do negócio à toa.
    if v_itens > 0 then
      update public.crm_leads l
         set value_cents = v_soma
       where l.id = v_lead
         and l.value_cents is distinct from v_soma;
    end if;
  end loop;

  return null;
end;
$$;

revoke execute on function public.fn_crm_lead_itens_recalcula_valor() from public, anon, authenticated;

drop trigger if exists trg_crm_lead_itens_recalcula_valor on public.crm_lead_itens;
create trigger trg_crm_lead_itens_recalcula_valor
  after insert or update or delete on public.crm_lead_itens
  for each row execute function public.fn_crm_lead_itens_recalcula_valor();

-- ---- 3c. o valor foi digitado num negócio com itens: vale a soma ------------
-- Só dispara quando `value_cents` MUDA. A escrita do gatilho 3b cai aqui também
-- e calcula o mesmo número, então é idempotente.

create or replace function public.fn_crm_leads_valor_pelos_itens()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_soma bigint;
  v_itens bigint;
begin
  select count(*), coalesce(sum(round(i.quantidade * i.valor_unitario_cents)), 0)::bigint
    into v_itens, v_soma
    from public.crm_lead_itens i
   where i.lead_id = new.id;

  if v_itens > 0 then
    new.value_cents := v_soma;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_crm_leads_valor_pelos_itens() from public, anon, authenticated;

drop trigger if exists trg_crm_leads_valor_pelos_itens on public.crm_leads;
create trigger trg_crm_leads_valor_pelos_itens
  before update of value_cents on public.crm_leads
  for each row
  when (new.value_cents is distinct from old.value_cents)
  execute function public.fn_crm_leads_valor_pelos_itens();
