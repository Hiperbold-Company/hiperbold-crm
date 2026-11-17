-- manifest: **Campos personalizados passam a ser da ORGANIZAÇÃO, em dois níveis: contato e negócio (fork Hiperbold, decisão do dono 17/11/2026).** Tabela `custom_field_definitions` (entidade `contato`|`negocio`, chave única por organização sem diferenciar maiúsculas, tipo text+CHECK, props da tela nova e `config` jsonb com options/mostrar_quando/padrao/mensagem_padrao/allow_new/multiple, `position numeric`). RLS `tenant_isolation_custom_field_definitions_all` (gerente+ grava) + `custom_field_definitions_select_membro` (membro lê). A obrigatoriedade continua no funil: `crm_pipelines.settings.campos_obrigatorios = {chave: {etapas, ao_ganhar, ao_perder}}`. `crm_pipelines.settings.fields` vira PROJEÇÃO derivada pelo banco (gatilhos `trg_crm_pipelines_projetar_campos` e `trg_custom_field_definitions_projetar`): organização com definições tem `fields` = definições + regras do funil, e os leitores de `fields` não mudam; organização sem definição segue no legado. Migração de dados genérica: copia `fields` para `settings.campos_legados` (rollback), monta `campos_obrigatorios` e insere uma definição por chave (primeiro funil por `created_at` vence; conflito de tipo/escopo vai para NOTICE, valores intactos). `fn_estatisticas_do_campo_personalizado` (invoker, só service_role). Espelho no apêndice do `supabase/baseline.sql`; prova em `tests/invariants/campos-personalizados-da-organizacao.test.ts`.
-- 1015 — CAMPOS PERSONALIZADOS DA ORGANIZAÇÃO (contato e negócio), fork Hiperbold.
--
-- ═══ Por quê ═══
--
-- Até aqui cada funil declarava os próprios campos em `crm_pipelines.settings.fields[]`, com um
-- `escopo` (negocio|contato) por item. Quem tinha cinco funis cadastrava o mesmo "CPF" cinco vezes,
-- e a ficha do contato só lia o funil padrão. Decisão do dono do produto (17/11/2026): os campos
-- passam a ser da organização, em dois níveis — CONTATO e NEGÓCIO —, e o campo de negócio vale para
-- todos os funis. O que continua no funil é só a regra "obrigatório na etapa X / ao ganhar / ao
-- perder", em `settings.campos_obrigatorios`.
--
-- ═══ Como, sem reescrever os leitores ═══
--
-- Mais de cinquenta pontos do produto (quadro, dossiê, automações, captação, MCP, cron do gatilho
-- de data) leem `settings.fields` do funil. Em vez de trocar todos, o banco passa a DERIVAR esse
-- array: `fields` é a projeção das definições da organização com a obrigatoriedade daquele funil.
-- A fonte da verdade é `custom_field_definitions`; `fields` é cópia declarada, refeita por gatilho
-- (nunca por cron), sem rede dentro da transação.
--  - `trg_crm_pipelines_projetar_campos` (BEFORE INSERT/UPDATE OF settings): quando a organização
--    tem ao menos uma definição, `NEW.settings.fields` é recalculado. Escrita direta em `fields`
--    nessa organização não pega — o app recusa antes, com a frase que manda para a tela nova.
--  - `trg_custom_field_definitions_projetar` (AFTER INSERT/UPDATE/DELETE): refaz `fields` em todos
--    os funis da organização. Apagar a ÚLTIMA definição deixa `fields = []`.
--  - Organização SEM nenhuma definição fica como sempre foi (legado): `fields` não é tocado.
--
-- ═══ A migração de dados ═══
--
-- Para cada organização que ainda não tem definição: (1) cada funil com campos guarda a lista
-- original em `settings.campos_legados` (só se a chave não existir) e ganha `campos_obrigatorios`
-- montado a partir do `obrigatorio_em` dos itens, já com a chave canônica; (2) uma definição por
-- chave (sem diferenciar maiúsculas): vence a do funil mais antigo (`created_at`, depois id, depois
-- a ordem no array). Chave repetida com tipo ou escopo diferente entra no NOTICE de conflito; os
-- valores gravados em `crm_leads.custom_fields`/`contacts.custom_fields` não são tocados.
-- Item que o Zod já descartava (sem chave válida, sem rótulo, tipo fora da lista) não migra.
-- Reaplicar não refaz nada: organização que já tem definição é pulada.
--
-- Portável em psql puro: sem BEGIN/COMMIT, sem tabela temporária. Funções com
-- `set search_path = public, pg_temp`, EXECUTE revogado de public e anon (e de authenticated).

create table if not exists public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entidade text not null,
  key text not null,
  label text not null,
  type text not null,
  descricao text,
  grupo text,
  obrigatorio boolean not null default false,
  publico boolean not null default true,
  sempre_visivel boolean not null default false,
  exibir_no_perfil boolean not null default false,
  dica_de_ajuda text,
  config jsonb not null default '{}'::jsonb,
  position numeric not null default 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);

do $hb_1015_constraints$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.custom_field_definitions'::regclass
                 and conname = 'custom_field_definitions_entidade_check') then
    alter table public.custom_field_definitions add constraint custom_field_definitions_entidade_check
      check (entidade in ('contato', 'negocio'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.custom_field_definitions'::regclass
                 and conname = 'custom_field_definitions_key_check') then
    alter table public.custom_field_definitions add constraint custom_field_definitions_key_check
      check (key ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.custom_field_definitions'::regclass
                 and conname = 'custom_field_definitions_label_check') then
    alter table public.custom_field_definitions add constraint custom_field_definitions_label_check
      check (char_length(btrim(label)) between 1 and 80);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.custom_field_definitions'::regclass
                 and conname = 'custom_field_definitions_type_check') then
    alter table public.custom_field_definitions add constraint custom_field_definitions_type_check
      check (type in ('text', 'textarea', 'number', 'currency', 'date', 'select', 'multiselect',
                      'searchable_select', 'boolean', 'email', 'phone', 'url', 'file'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.custom_field_definitions'::regclass
                 and conname = 'custom_field_definitions_grupo_check') then
    alter table public.custom_field_definitions add constraint custom_field_definitions_grupo_check
      check (grupo is null or grupo in ('dados', 'rastreamento'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.custom_field_definitions'::regclass
                 and conname = 'custom_field_definitions_textos_check') then
    alter table public.custom_field_definitions add constraint custom_field_definitions_textos_check
      check (coalesce(char_length(descricao), 0) <= 500 and coalesce(char_length(dica_de_ajuda), 0) <= 300);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.custom_field_definitions'::regclass
                 and conname = 'custom_field_definitions_config_check') then
    alter table public.custom_field_definitions add constraint custom_field_definitions_config_check
      check (jsonb_typeof(config) = 'object');
  end if;
end
$hb_1015_constraints$;

-- Uma chave por organização, SEM diferenciar maiúsculas e sem separar por entidade: a projeção põe
-- contato e negócio no MESMO array `fields`, e duas definições `cidade` (uma de cada nível) fariam o
-- leitor do funil achar a errada.
create unique index if not exists uniq_custom_field_definitions_org_key
  on public.custom_field_definitions (organization_id, lower(key));
create index if not exists idx_custom_field_definitions_org_entidade
  on public.custom_field_definitions (organization_id, entidade, position);

alter table public.custom_field_definitions enable row level security;

drop policy if exists tenant_isolation_custom_field_definitions_all on public.custom_field_definitions;
create policy tenant_isolation_custom_field_definitions_all on public.custom_field_definitions
  for all
  to authenticated
  using (
    organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
  with check (
    organization_id in (select * from public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );

-- Ler a definição é de todo membro (a ficha do atendente desenha os campos). Políticas permissivas
-- somam: o SELECT passa por esta, a escrita só pela de cima (gerente ou acima).
drop policy if exists custom_field_definitions_select_membro on public.custom_field_definitions;
create policy custom_field_definitions_select_membro on public.custom_field_definitions
  for select
  to authenticated
  using (organization_id in (select * from public.fn_user_org_ids()));

revoke all on table public.custom_field_definitions from anon, authenticated, service_role;
grant select, insert, update, delete on table public.custom_field_definitions to authenticated, service_role;

drop trigger if exists trg_custom_field_definitions_updated_at on public.custom_field_definitions;
create trigger trg_custom_field_definitions_updated_at
  before update on public.custom_field_definitions
  for each row execute function public.fn_set_updated_at();

comment on table public.custom_field_definitions is
  '1015: definições dos campos personalizados da organização (entidade contato|negocio). Fonte da verdade; crm_pipelines.settings.fields é a projeção derivada por gatilho. Valores continuam em crm_leads.custom_fields e contacts.custom_fields.';
comment on column public.custom_field_definitions.config is
  '1015: o que é próprio do tipo — options, mostrar_quando, padrao, mensagem_padrao, allow_new, multiple —, validado por lib/campos/definicoes.ts.';
comment on column public.custom_field_definitions.publico is
  '1015: false = só administrador vê o campo na ficha.';

-- A chave, a entidade, o tipo e a organização não mudam depois de criados: os valores já gravados
-- seguem a forma antiga, e trocar a entidade levaria o campo para outro jsonb sem levar o valor.
create or replace function public.fn_custom_field_definitions_guarda()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.entidade is distinct from old.entidade
     or new.key is distinct from old.key
     or new.type is distinct from old.type then
    raise exception 'A chave, a entidade e o tipo de um campo personalizado não mudam depois de criados.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_custom_field_definitions_guarda() from public, anon, authenticated;

drop trigger if exists trg_custom_field_definitions_guarda on public.custom_field_definitions;
create trigger trg_custom_field_definitions_guarda
  before update on public.custom_field_definitions
  for each row execute function public.fn_custom_field_definitions_guarda();

-- A PROJEÇÃO: as definições da organização na forma de `settings.fields[]` (a de customFieldSchema),
-- com o `obrigatorio_em` do funil. Chave nula sai do item (ausência é o padrão de toda prop).
create or replace function public.fn_campos_personalizados_projetados(p_org uuid, p_obrigatorios jsonb)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(item order by ordem_pos, ordem_criado, ordem_chave), '[]'::jsonb)
    from (
      select d.position as ordem_pos,
             d.created_at as ordem_criado,
             d.key as ordem_chave,
             (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                from jsonb_each(
                       (select coalesce(jsonb_object_agg(c.key, c.value), '{}'::jsonb)
                          from jsonb_each(d.config) c
                         where c.key in ('options', 'mostrar_quando', 'padrao', 'mensagem_padrao',
                                         'allow_new', 'multiple'))
                       || jsonb_build_object(
                            'key', d.key,
                            'label', d.label,
                            'type', d.type,
                            'required', case when d.obrigatorio then true end,
                            'grupo', d.grupo,
                            'escopo', case when d.entidade = 'contato' then 'contato' end,
                            'descricao', d.descricao,
                            'publico', case when not d.publico then false end,
                            'sempre_visivel', case when d.sempre_visivel then true end,
                            'exibir_no_perfil', case when d.exibir_no_perfil then true end,
                            'dica_de_ajuda', d.dica_de_ajuda,
                            'obrigatorio_em',
                              case when jsonb_typeof(p_obrigatorios) = 'object'
                                    and jsonb_typeof(p_obrigatorios -> d.key) = 'object'
                                   then p_obrigatorios -> d.key end
                          )) e
               where e.value <> 'null'::jsonb) as item
        from public.custom_field_definitions d
       where d.organization_id = p_org
    ) projetados;
$$;

revoke execute on function public.fn_campos_personalizados_projetados(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_campos_personalizados_projetados(uuid, jsonb) to service_role;

create or replace function public.fn_crm_pipelines_projetar_campos()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if jsonb_typeof(new.settings) is distinct from 'object' then
    return new;
  end if;
  if exists (select 1 from public.custom_field_definitions d where d.organization_id = new.organization_id) then
    new.settings := jsonb_set(
      new.settings,
      '{fields}',
      public.fn_campos_personalizados_projetados(new.organization_id, new.settings -> 'campos_obrigatorios')
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_crm_pipelines_projetar_campos() from public, anon, authenticated;

drop trigger if exists trg_crm_pipelines_projetar_campos on public.crm_pipelines;
create trigger trg_crm_pipelines_projetar_campos
  before insert or update of settings on public.crm_pipelines
  for each row execute function public.fn_crm_pipelines_projetar_campos();

create or replace function public.fn_custom_field_definitions_projetar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
  else
    v_org := new.organization_id;
  end if;
  -- `jsonb_set` explícito: quando a última definição sai, o gatilho do funil já não projeta (a
  -- organização voltou a não ter definição) e é esta linha que deixa `fields = []`.
  update public.crm_pipelines p
     set settings = jsonb_set(
           p.settings,
           '{fields}',
           public.fn_campos_personalizados_projetados(v_org, p.settings -> 'campos_obrigatorios')
         )
   where p.organization_id = v_org
     and jsonb_typeof(p.settings) = 'object';
  return null;
end;
$$;

revoke execute on function public.fn_custom_field_definitions_projetar() from public, anon, authenticated;

drop trigger if exists trg_custom_field_definitions_projetar on public.custom_field_definitions;
create trigger trg_custom_field_definitions_projetar
  after insert or update or delete on public.custom_field_definitions
  for each row execute function public.fn_custom_field_definitions_projetar();

-- AS ESTATÍSTICAS DE UM CAMPO (tela nova, aba Estatísticas). Invoker e só para a service role: a rota
-- resolve a organização da sessão e a filtra aqui; nenhum papel do PostgREST a chama.
create or replace function public.fn_estatisticas_do_campo_personalizado(p_org uuid, p_entidade text, p_key text)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  if p_entidade = 'contato' then
    select jsonb_build_object(
             'total', count(*),
             'preenchidos', count(*) filter (where c.custom_fields -> p_key is not null
                                             and c.custom_fields -> p_key not in ('null', '""', '[]', '{}')),
             'ultimo_uso', max(c.updated_at) filter (where c.custom_fields -> p_key is not null
                                                     and c.custom_fields -> p_key not in ('null', '""', '[]', '{}')),
             'tamanho_medio', round(avg(char_length(case jsonb_typeof(c.custom_fields -> p_key)
                                                      when 'string' then c.custom_fields ->> p_key
                                                      else (c.custom_fields -> p_key)::text end))
                                    filter (where c.custom_fields -> p_key is not null
                                            and c.custom_fields -> p_key not in ('null', '""', '[]', '{}')), 1))
      into v
      from public.contacts c
     where c.organization_id = p_org
       and c.is_merged_into is null;
  else
    select jsonb_build_object(
             'total', count(*),
             'preenchidos', count(*) filter (where l.custom_fields -> p_key is not null
                                             and l.custom_fields -> p_key not in ('null', '""', '[]', '{}')),
             'ultimo_uso', max(l.updated_at) filter (where l.custom_fields -> p_key is not null
                                                     and l.custom_fields -> p_key not in ('null', '""', '[]', '{}')),
             'tamanho_medio', round(avg(char_length(case jsonb_typeof(l.custom_fields -> p_key)
                                                      when 'string' then l.custom_fields ->> p_key
                                                      else (l.custom_fields -> p_key)::text end))
                                    filter (where l.custom_fields -> p_key is not null
                                            and l.custom_fields -> p_key not in ('null', '""', '[]', '{}')), 1))
      into v
      from public.crm_leads l
     where l.organization_id = p_org;
    -- Campo de ARQUIVO não mora em custom_fields: uma linha por anexo em crm_lead_attachments.
    v := v || jsonb_build_object(
      'anexados', (select count(distinct a.lead_id) from public.crm_lead_attachments a
                    where a.organization_id = p_org and a.field_key = p_key)
    );
  end if;
  return v;
end;
$$;

revoke execute on function public.fn_estatisticas_do_campo_personalizado(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_estatisticas_do_campo_personalizado(uuid, text, text) to service_role;

-- ═══ A migração de dados (genérica; reaplicar não refaz) ═══
do $hb_1015_migrar_campos$
declare
  v_conflitos text;
  v_inseridas integer;
begin
  -- (1) rollback e obrigatoriedade, ANTES de a projeção reescrever `fields`.
  with funis as (
    select p.id, p.organization_id, p.settings
      from public.crm_pipelines p
     where jsonb_typeof(p.settings) = 'object'
       and jsonb_typeof(p.settings -> 'fields') = 'array'
       and jsonb_array_length(p.settings -> 'fields') > 0
       and not exists (select 1 from public.custom_field_definitions d
                        where d.organization_id = p.organization_id)
  ),
  canon as (
    select distinct on (p.organization_id, lower(f.item ->> 'key'))
           p.organization_id, lower(f.item ->> 'key') as k, f.item ->> 'key' as chave
      from public.crm_pipelines p
     cross join lateral jsonb_array_elements(p.settings -> 'fields') with ordinality as f(item, ord)
     where p.id in (select id from funis)
       and jsonb_typeof(f.item) = 'object'
       and coalesce(f.item ->> 'key', '') ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'
       and btrim(coalesce(f.item ->> 'label', '')) <> ''
       and f.item ->> 'type' in ('text', 'textarea', 'number', 'currency', 'date', 'select', 'multiselect',
                                 'searchable_select', 'boolean', 'email', 'phone', 'url', 'file')
     order by p.organization_id, lower(f.item ->> 'key'), p.created_at, p.id, f.ord
  ),
  obrig as (
    select fu.id, jsonb_object_agg(c.chave, f.item -> 'obrigatorio_em') as mapa
      from funis fu
     cross join lateral jsonb_array_elements(fu.settings -> 'fields') as f(item)
      join canon c on c.organization_id = fu.organization_id and c.k = lower(f.item ->> 'key')
     where jsonb_typeof(f.item) = 'object'
       and jsonb_typeof(f.item -> 'obrigatorio_em') = 'object'
     group by fu.id
  )
  update public.crm_pipelines p
     set settings = p.settings
         || case when p.settings ? 'campos_legados' then '{}'::jsonb
                 else jsonb_build_object('campos_legados', p.settings -> 'fields') end
         || case when p.settings ? 'campos_obrigatorios' then '{}'::jsonb
                 else jsonb_build_object('campos_obrigatorios', coalesce(o.mapa, '{}'::jsonb)) end
    from funis fu
    left join obrig o on o.id = fu.id
   where p.id = fu.id;

  -- (2) o conflito: a mesma chave declarada com tipo ou escopo diferente em outro funil.
  with itens as (
    select p.organization_id, p.created_at as p_criado, p.id as p_id, f.ord, f.item,
           lower(f.item ->> 'key') as k
      from public.crm_pipelines p
     cross join lateral jsonb_array_elements(p.settings -> 'fields') with ordinality as f(item, ord)
     where jsonb_typeof(p.settings) = 'object'
       and jsonb_typeof(p.settings -> 'fields') = 'array'
       and not exists (select 1 from public.custom_field_definitions d
                        where d.organization_id = p.organization_id)
       and jsonb_typeof(f.item) = 'object'
       and coalesce(f.item ->> 'key', '') ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'
       and btrim(coalesce(f.item ->> 'label', '')) <> ''
       and f.item ->> 'type' in ('text', 'textarea', 'number', 'currency', 'date', 'select', 'multiselect',
                                 'searchable_select', 'boolean', 'email', 'phone', 'url', 'file')
  ),
  primeiros as (
    select distinct on (organization_id, k) *
      from itens
     order by organization_id, k, p_criado, p_id, ord
  )
  select string_agg(distinct i.organization_id::text || ':' || (i.item ->> 'key'), ', ')
    into v_conflitos
    from itens i
    join primeiros pr on pr.organization_id = i.organization_id and pr.k = i.k
   where i.item ->> 'type' is distinct from pr.item ->> 'type'
      or (i.item ->> 'escopo' = 'contato') is distinct from (pr.item ->> 'escopo' = 'contato');

  if v_conflitos is not null then
    raise notice '1015: chaves com tipo ou escopo diferente entre funis (vale o funil mais antigo; valores intactos): %',
      v_conflitos;
  end if;

  -- (3) uma definição por chave. A projeção corre pelos gatilhos acima, linha a linha.
  with itens as (
    select p.organization_id, p.created_at as p_criado, p.id as p_id, f.ord, f.item,
           lower(f.item ->> 'key') as k
      from public.crm_pipelines p
     cross join lateral jsonb_array_elements(p.settings -> 'fields') with ordinality as f(item, ord)
     where jsonb_typeof(p.settings) = 'object'
       and jsonb_typeof(p.settings -> 'fields') = 'array'
       and not exists (select 1 from public.custom_field_definitions d
                        where d.organization_id = p.organization_id)
       and jsonb_typeof(f.item) = 'object'
       and coalesce(f.item ->> 'key', '') ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'
       and btrim(coalesce(f.item ->> 'label', '')) <> ''
       and f.item ->> 'type' in ('text', 'textarea', 'number', 'currency', 'date', 'select', 'multiselect',
                                 'searchable_select', 'boolean', 'email', 'phone', 'url', 'file')
  ),
  primeiros as (
    select distinct on (organization_id, k) *
      from itens
     order by organization_id, k, p_criado, p_id, ord
  ),
  ordenados as (
    select pr.*, row_number() over (partition by pr.organization_id order by pr.p_criado, pr.p_id, pr.ord) as pos
      from primeiros pr
  )
  insert into public.custom_field_definitions
    (organization_id, entidade, key, label, type, obrigatorio, grupo, config, position)
  select o.organization_id,
         case when o.item ->> 'escopo' = 'contato' then 'contato' else 'negocio' end,
         o.item ->> 'key',
         left(btrim(o.item ->> 'label'), 80),
         o.item ->> 'type',
         coalesce(o.item -> 'required' = 'true'::jsonb, false),
         case when o.item ->> 'grupo' in ('dados', 'rastreamento') then o.item ->> 'grupo' end,
         (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
            from jsonb_each(o.item) e
           where e.key in ('options', 'mostrar_quando', 'padrao', 'mensagem_padrao', 'allow_new', 'multiple')),
         o.pos * 1000
    from ordenados o
  on conflict do nothing;
  get diagnostics v_inseridas = row_count;
  raise notice '1015: % definição(ões) de campo personalizado migradas dos funis', v_inseridas;
end
$hb_1015_migrar_campos$;

notify pgrst, 'reload schema';
