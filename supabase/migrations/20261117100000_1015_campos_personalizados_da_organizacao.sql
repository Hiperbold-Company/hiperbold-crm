-- manifest: **Campos personalizados passam a ser da ORGANIZAÇÃO, em dois níveis: contato e negócio (fork Hiperbold, decisão do dono 17/11/2026).** Tabela `custom_field_definitions` (entidade `contato`|`negocio`, chave única por organização sem diferenciar maiúsculas, tipo text+CHECK, props da tela nova e `config` jsonb com options/mostrar_quando/padrao/mensagem_padrao/allow_new/multiple, `position numeric`). RLS `tenant_isolation_custom_field_definitions_all` (gerente+ grava) + `custom_field_definitions_select_membro` (membro lê). A obrigatoriedade continua no funil: `crm_pipelines.settings.campos_obrigatorios = {chave: {etapas, ao_ganhar, ao_perder}}`. `crm_pipelines.settings.fields` vira PROJEÇÃO derivada pelo banco (gatilhos `trg_crm_pipelines_projetar_campos` e `trg_custom_field_definitions_projetar`): organização com definições tem `fields` = definições + regras do funil, e os leitores de `fields` não mudam; organização sem definição segue no legado. Migração de dados genérica por `fn_adotar_campos_legados_da_organizacao(org)` (idempotente, só service_role; o DO a chama para cada organização e o gatilho `trg_custom_field_definitions_antes_de_inserir` a chama na passagem de 0 para 1 definição, ANTES de a projeção regravar `fields`): copia `fields` para `settings.campos_legados` (rollback), monta `campos_obrigatorios` e insere uma definição por chave (primeiro funil por `created_at` vence; diferença de tipo, opções, obrigatório ou maiúsculas fica gravada em `organizations.settings.campos_conflitos`; a mesma chave em contato e negócio NUNCA se funde: a segunda ganha chave própria e os valores são copiados para ela). `authenticated` só lê a tabela; `config` tem teto de tamanho e a organização, 50 definições por entidade, no banco. `fn_estatisticas_do_campo_personalizado` (invoker, só service_role). Espelho no apêndice do `supabase/baseline.sql`; prova em `tests/invariants/campos-personalizados-da-organizacao.test.ts`.
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
-- ═══ A migração de dados (a ADOÇÃO do legado) ═══
--
-- Mora numa função por organização, `fn_adotar_campos_legados_da_organizacao`, porque precisa
-- rodar em DOIS momentos: no DO do fim deste arquivo (toda organização que já tinha campos) e na
-- passagem de 0 para 1 definição (organização que ganhou campos pelo caminho antigo depois da
-- atualização — sem isso a primeira definição faria a projeção APAGAR os campos dos funis, sem
-- cópia). Para cada organização que ainda não tem definição: (1) cada funil com campos guarda a
-- lista original em `settings.campos_legados` (só se a chave não existir) e ganha
-- `campos_obrigatorios` montado a partir do `obrigatorio_em` dos itens, já com a chave canônica;
-- (2) uma definição por chave (sem diferenciar maiúsculas): vence a do funil mais antigo
-- (`created_at`, depois id, depois a ordem no array). Quando a mesma chave aparece com tipo,
-- opções, obrigatoriedade ou maiúsculas diferentes, o conflito fica GRAVADO em
-- `organizations.settings.campos_conflitos` (chave, funis, diferença), não só num NOTICE.
-- A mesma chave em CONTATO e em NEGÓCIO nunca se funde: a segunda ganha uma chave própria
-- (`<chave>_contato` ou `<chave>_negocio`) e os valores dela são COPIADOS para essa chave nos
-- registros (contato não anonimizado; negócio dos funis que a declaravam). A chave antiga fica.
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
  -- Teto de tamanho do `config` (256 KB). Não é 16 KB porque a lista pesquisável existe para listas
  -- longas (a de municípios passa de 150 KB). Linha antiga acima do teto não quebra o update.sh: a
  -- constraint entra NOT VALID e vale para toda escrita nova.
  if not exists (select 1 from pg_constraint where conrelid = 'public.custom_field_definitions'::regclass
                 and conname = 'custom_field_definitions_config_tamanho_check') then
    alter table public.custom_field_definitions add constraint custom_field_definitions_config_tamanho_check
      check (pg_column_size(config) < 262144) not valid;
    if not exists (select 1 from public.custom_field_definitions where pg_column_size(config) >= 262144) then
      alter table public.custom_field_definitions validate constraint custom_field_definitions_config_tamanho_check;
    end if;
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

-- `authenticated` SÓ LÊ: quem grava é o app, pela service role, depois de conferir o papel
-- (administrador) na porta. A política de escrita acima fica como segunda trava, sem GRANT que a use.
revoke all on table public.custom_field_definitions from anon, authenticated, service_role;
grant select on table public.custom_field_definitions to authenticated;
grant select, insert, update, delete on table public.custom_field_definitions to service_role;

drop trigger if exists trg_custom_field_definitions_updated_at on public.custom_field_definitions;
create trigger trg_custom_field_definitions_updated_at
  before update on public.custom_field_definitions
  for each row execute function public.fn_set_updated_at();

comment on table public.custom_field_definitions is
  '1015: definições dos campos personalizados da organização (entidade contato|negocio). Fonte da verdade; crm_pipelines.settings.fields é a projeção derivada por gatilho. Valores continuam em crm_leads.custom_fields e contacts.custom_fields.';
comment on column public.custom_field_definitions.config is
  '1015: o que é próprio do tipo — options, mostrar_quando, padrao, mensagem_padrao, allow_new, multiple —, validado por lib/campos/definicoes.ts.';
comment on column public.custom_field_definitions.publico is
  '1015: false = o app só mostra o campo (definição e valor) a administrador, nas telas e exportações, e nunca o entrega ao agente de IA nem às variáveis de automação. NÃO é sigilo: quem lê crm_leads/contacts pela REST com a própria sessão vê o valor.';

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

-- A ADOÇÃO DO LEGADO de UMA organização (ver "A migração de dados" no cabeçalho). Idempotente:
-- organização que já tem definição devolve 0 sem tocar em nada. Trava consultiva por organização,
-- para duas adoções simultâneas não inserirem em dobro. `hb.campos_adocao` (local à transação) diz
-- ao gatilho de inserção que a linha vem daqui: nem adota de novo, nem conta o teto (a união dos
-- funis pode passar de 50 — nada some; só campo NOVO é recusado até a organização ficar abaixo).
create or replace function public.fn_adotar_campos_legados_da_organizacao(p_org uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_tipos constant text[] := array['text', 'textarea', 'number', 'currency', 'date', 'select', 'multiselect',
                                   'searchable_select', 'boolean', 'email', 'phone', 'url', 'file'];
  c_props constant text[] := array['options', 'mostrar_quando', 'padrao', 'mensagem_padrao', 'allow_new', 'multiple'];
  r record;
  v_ent text;
  v_outra text;
  v_lk text;
  v_chave text;
  v_cand text;
  v_i integer;
  v_grupo jsonb;
  v_venc jsonb;
  v_dif jsonb;
  v_canon jsonb := '{}'::jsonb;      -- lower(chave) -> { entidade: {chave, original, item, funil, funil_nome, renomeado} }
  v_ordem jsonb := '[]'::jsonb;      -- [[lower(chave), entidade], ...] na ordem em que apareceram
  v_obrig jsonb := '{}'::jsonb;      -- funil -> { chave: obrigatorio_em }
  v_conflitos jsonb := '[]'::jsonb;
  v_todas jsonb;
  v_usadas jsonb := '{}'::jsonb;
  v_par jsonb;
  v_n integer;
  v_def jsonb;
  v_item jsonb;
  v_ins integer;
  v_inseridas integer := 0;
begin
  if p_org is null then
    return 0;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hb_1015_campos:' || p_org::text, 0));
  if exists (select 1 from public.custom_field_definitions d where d.organization_id = p_org) then
    return 0;
  end if;
  perform set_config('hb.campos_adocao', p_org::text, true);

  -- Toda chave válida que já existe na organização: a chave distinta de uma entidade nunca pode
  -- cair em cima de outra que aparece mais adiante.
  select coalesce(jsonb_object_agg(k, true), '{}'::jsonb)
    into v_todas
    from (select distinct lower(f.item ->> 'key') as k
            from public.crm_pipelines p
           cross join lateral jsonb_array_elements(
                   case when jsonb_typeof(p.settings -> 'fields') = 'array' then p.settings -> 'fields'
                        else '[]'::jsonb end) as f(item)
           where p.organization_id = p_org
             and jsonb_typeof(f.item) = 'object'
             and coalesce(f.item ->> 'key', '') ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$') chaves;

  for r in
    select p.id as funil, p.name as funil_nome, f.item, f.ord
      from public.crm_pipelines p
     cross join lateral jsonb_array_elements(
             case when jsonb_typeof(p.settings -> 'fields') = 'array' then p.settings -> 'fields'
                  else '[]'::jsonb end) with ordinality as f(item, ord)
     where p.organization_id = p_org
       and jsonb_typeof(p.settings) = 'object'
     order by p.created_at, p.id, f.ord
  loop
    continue when jsonb_typeof(r.item) is distinct from 'object'
      or coalesce(r.item ->> 'key', '') !~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'
      or btrim(coalesce(r.item ->> 'label', '')) = ''
      or not (coalesce(r.item ->> 'type', '') = any (c_tipos));

    v_ent := case when r.item ->> 'escopo' = 'contato' then 'contato' else 'negocio' end;
    v_outra := case when v_ent = 'contato' then 'negocio' else 'contato' end;
    v_lk := lower(r.item ->> 'key');
    v_grupo := coalesce(v_canon -> v_lk, '{}'::jsonb);
    v_venc := v_grupo -> v_ent;

    if v_venc is null then
      if v_grupo ? v_outra then
        -- A mesma chave já é da OUTRA entidade: chave própria, nunca fusão.
        v_i := 1;
        loop
          v_cand := case when v_i = 1 then left(r.item ->> 'key', 31) || '_' || v_ent
                         else left(r.item ->> 'key', 31 - length(v_i::text)) || '_' || v_ent || v_i::text end;
          exit when not (v_todas ? lower(v_cand)) and not (v_usadas ? lower(v_cand));
          v_i := v_i + 1;
        end loop;
        v_chave := v_cand;
        v_usadas := v_usadas || jsonb_build_object(lower(v_chave), true);
        v_conflitos := v_conflitos || jsonb_build_array(jsonb_build_object(
          'chave', v_grupo -> v_outra ->> 'chave',
          'chave_nova', v_chave,
          'entidade_nova', v_ent,
          'funis', jsonb_build_array(
            jsonb_build_object('id', v_grupo -> v_outra ->> 'funil', 'nome', v_grupo -> v_outra ->> 'funil_nome'),
            jsonb_build_object('id', r.funil, 'nome', r.funil_nome)),
          'diferenca', jsonb_build_array('entidade'),
          'resolucao', 'chave_distinta_com_valores_copiados'));
      else
        v_chave := r.item ->> 'key';
      end if;
      v_venc := jsonb_build_object('chave', v_chave, 'original', r.item ->> 'key', 'item', r.item,
                                   'funil', r.funil, 'funil_nome', r.funil_nome,
                                   'renomeado', v_chave is distinct from r.item ->> 'key');
      v_canon := v_canon || jsonb_build_object(v_lk, v_grupo || jsonb_build_object(v_ent, v_venc));
      v_ordem := v_ordem || jsonb_build_array(jsonb_build_array(v_lk, v_ent));
    else
      v_dif := '[]'::jsonb;
      if (r.item ->> 'type') is distinct from (v_venc -> 'item' ->> 'type') then
        v_dif := v_dif || '["tipo"]'::jsonb;
      end if;
      if (r.item -> 'options') is distinct from (v_venc -> 'item' -> 'options') then
        v_dif := v_dif || '["opcoes"]'::jsonb;
      end if;
      if coalesce(r.item -> 'required' = 'true'::jsonb, false)
         is distinct from coalesce(v_venc -> 'item' -> 'required' = 'true'::jsonb, false) then
        v_dif := v_dif || '["obrigatorio"]'::jsonb;
      end if;
      if (r.item ->> 'key') is distinct from (v_venc ->> 'original') then
        v_dif := v_dif || '["maiusculas"]'::jsonb;
      end if;
      if jsonb_array_length(v_dif) > 0 then
        v_conflitos := v_conflitos || jsonb_build_array(jsonb_build_object(
          'chave', v_venc ->> 'chave',
          'chave_no_funil', r.item ->> 'key',
          'entidade', v_ent,
          'funis', jsonb_build_array(
            jsonb_build_object('id', v_venc ->> 'funil', 'nome', v_venc ->> 'funil_nome'),
            jsonb_build_object('id', r.funil, 'nome', r.funil_nome)),
          'diferenca', v_dif,
          'resolucao', 'vale_o_funil_mais_antigo'));
      end if;
      v_chave := v_venc ->> 'chave';
    end if;

    -- Chave final diferente da do funil (chave própria da outra entidade, OU a mesma chave com
    -- maiúsculas diferentes que caiu na definição do funil mais antigo): COPIA os valores para a
    -- chave final (a antiga fica onde estava). Só olhar `renomeado` deixava `Cidade` do segundo
    -- funil fora da definição `cidade`.
    if v_chave is distinct from (r.item ->> 'key') then
      if v_ent = 'contato' then
        update public.contacts c
           set custom_fields = c.custom_fields || jsonb_build_object(v_chave, c.custom_fields -> (r.item ->> 'key'))
         where c.organization_id = p_org
           and c.is_anonymized is not true
           and jsonb_typeof(c.custom_fields) = 'object'
           and c.custom_fields ? (r.item ->> 'key')
           and not c.custom_fields ? v_chave;
      else
        update public.crm_leads l
           set custom_fields = l.custom_fields || jsonb_build_object(v_chave, l.custom_fields -> (r.item ->> 'key'))
         where l.organization_id = p_org
           and l.pipeline_id = r.funil
           and jsonb_typeof(l.custom_fields) = 'object'
           and l.custom_fields ? (r.item ->> 'key')
           and not l.custom_fields ? v_chave;
      end if;
    end if;

    -- A obrigatoriedade do funil, na chave final; a primeira ocorrência no funil vence.
    if jsonb_typeof(r.item -> 'obrigatorio_em') = 'object'
       and not (coalesce(v_obrig -> (r.funil::text), '{}'::jsonb) ? v_chave) then
      v_obrig := v_obrig || jsonb_build_object(r.funil::text,
        coalesce(v_obrig -> (r.funil::text), '{}'::jsonb) || jsonb_build_object(v_chave, r.item -> 'obrigatorio_em'));
    end if;
  end loop;

  if jsonb_array_length(v_ordem) = 0 then
    perform set_config('hb.campos_adocao', '', true);
    return 0;
  end if;

  -- (1) rollback e obrigatoriedade, ANTES de a projeção reescrever `fields`. A regra que já estava
  -- em `campos_obrigatorios` vence a que vem do item.
  update public.crm_pipelines p
     set settings = p.settings
         || case when p.settings ? 'campos_legados' then '{}'::jsonb
                 else jsonb_build_object('campos_legados', p.settings -> 'fields') end
         || jsonb_build_object('campos_obrigatorios',
              coalesce(v_obrig -> (p.id::text), '{}'::jsonb)
              || case when jsonb_typeof(p.settings -> 'campos_obrigatorios') = 'object'
                      then p.settings -> 'campos_obrigatorios' else '{}'::jsonb end)
   where p.organization_id = p_org
     and jsonb_typeof(p.settings) = 'object'
     and jsonb_typeof(p.settings -> 'fields') = 'array'
     and jsonb_array_length(p.settings -> 'fields') > 0;

  -- (2) uma definição por chave final. A projeção corre pelo gatilho AFTER, linha a linha.
  for v_par, v_n in
    select x.e, x.o::integer from jsonb_array_elements(v_ordem) with ordinality as x(e, o)
  loop
    v_def := v_canon -> (v_par ->> 0) -> (v_par ->> 1);
    v_item := v_def -> 'item';
    insert into public.custom_field_definitions
      (organization_id, entidade, key, label, type, obrigatorio, grupo, descricao, publico, sempre_visivel,
       exibir_no_perfil, dica_de_ajuda, config, position)
    values (
      p_org,
      v_par ->> 1,
      v_def ->> 'chave',
      left(btrim(v_item ->> 'label'), 80),
      v_item ->> 'type',
      coalesce(v_item -> 'required' = 'true'::jsonb, false),
      case when v_item ->> 'grupo' in ('dados', 'rastreamento') then v_item ->> 'grupo' end,
      case when jsonb_typeof(v_item -> 'descricao') = 'string' then nullif(left(v_item ->> 'descricao', 500), '') end,
      coalesce(v_item -> 'publico' <> 'false'::jsonb, true),
      coalesce(v_item -> 'sempre_visivel' = 'true'::jsonb, false),
      coalesce(v_item -> 'exibir_no_perfil' = 'true'::jsonb, false),
      case when jsonb_typeof(v_item -> 'dica_de_ajuda') = 'string' then nullif(left(v_item ->> 'dica_de_ajuda', 300), '') end,
      (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
         from jsonb_each(v_item) e
        where e.key = any (c_props) and e.value <> 'null'::jsonb),
      v_n * 1000
    )
    on conflict do nothing;
    get diagnostics v_ins = row_count;
    v_inseridas := v_inseridas + v_ins;
  end loop;

  -- (3) o conflito fica GRAVADO na organização (a tela e o suporte o leem depois).
  if jsonb_array_length(v_conflitos) > 0 then
    update public.organizations o
       set settings = coalesce(o.settings, '{}'::jsonb)
           || jsonb_build_object('campos_conflitos',
                case when jsonb_typeof(o.settings -> 'campos_conflitos') = 'array'
                     then o.settings -> 'campos_conflitos' else '[]'::jsonb end || v_conflitos)
     where o.id = p_org
       and jsonb_typeof(coalesce(o.settings, '{}'::jsonb)) = 'object';
    raise notice '1015: % conflito(s) de campo personalizado na organização % (gravados em organizations.settings.campos_conflitos)',
      jsonb_array_length(v_conflitos), p_org;
  end if;

  perform set_config('hb.campos_adocao', '', true);
  return v_inseridas;
end;
$$;

revoke execute on function public.fn_adotar_campos_legados_da_organizacao(uuid) from public, anon, authenticated;
grant execute on function public.fn_adotar_campos_legados_da_organizacao(uuid) to service_role;

-- ANTES DE INSERIR uma definição: (1) na passagem de 0 para 1, adota o legado da organização ANTES
-- de a projeção (AFTER) regravar `fields` — sem isso os campos dos funis sumiriam; (2) o teto de 50
-- definições por entidade, o mesmo `COTA_DE_CAMPOS_POR_ENTIDADE` do app, sob a mesma trava
-- consultiva (duas inserções simultâneas não passam juntas do teto). Linha da própria adoção passa.
create or replace function public.fn_custom_field_definitions_antes_de_inserir()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_qtd integer;
  v_ultima numeric;
begin
  if coalesce(current_setting('hb.campos_adocao', true), '') = new.organization_id::text then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hb_1015_campos:' || new.organization_id::text, 0));
  if not exists (select 1 from public.custom_field_definitions d where d.organization_id = new.organization_id) then
    if public.fn_adotar_campos_legados_da_organizacao(new.organization_id) > 0 then
      -- A posição que quem cria calculou (a tela soma 1000 à última que VIU) é de antes da adoção:
      -- com zero definições ela dá 1000, a mesma da primeira adotada. A campo novo vai DEPOIS dos
      -- campos que a organização já tinha nos funis.
      select max(d.position) into v_ultima
        from public.custom_field_definitions d
       where d.organization_id = new.organization_id
         and d.entidade = new.entidade;
      if v_ultima is not null and new.position <= v_ultima then
        new.position := v_ultima + 1000;
      end if;
    end if;
  end if;
  select count(*) into v_qtd
    from public.custom_field_definitions d
   where d.organization_id = new.organization_id
     and d.entidade = new.entidade;
  if v_qtd >= 50 then
    raise exception 'teto de campos personalizados: a organização aceita no máximo 50 campos de %', new.entidade
      using errcode = '23514', constraint = 'custom_field_definitions_teto_por_entidade';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_custom_field_definitions_antes_de_inserir() from public, anon, authenticated;

drop trigger if exists trg_custom_field_definitions_antes_de_inserir on public.custom_field_definitions;
create trigger trg_custom_field_definitions_antes_de_inserir
  before insert on public.custom_field_definitions
  for each row execute function public.fn_custom_field_definitions_antes_de_inserir();

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
-- Uma organização por vez, cada uma no próprio bloco: a falha de uma (dado fora de toda forma) vira
-- WARNING e não desfaz a adoção das outras — o update.sh roda sem ON_ERROR_STOP.
do $hb_1015_migrar_campos$
declare
  v_org uuid;
  v_inseridas integer := 0;
begin
  for v_org in
    select distinct p.organization_id
      from public.crm_pipelines p
     where jsonb_typeof(p.settings) = 'object'
       and jsonb_typeof(p.settings -> 'fields') = 'array'
       and jsonb_array_length(p.settings -> 'fields') > 0
       and not exists (select 1 from public.custom_field_definitions d
                        where d.organization_id = p.organization_id)
  loop
    begin
      v_inseridas := v_inseridas + public.fn_adotar_campos_legados_da_organizacao(v_org);
    exception when others then
      raise warning '1015: a organização % não teve os campos adotados (%): os funis seguem no legado', v_org, sqlerrm;
    end;
  end loop;
  raise notice '1015: % definição(ões) de campo personalizado migradas dos funis', v_inseridas;
end
$hb_1015_migrar_campos$;

notify pgrst, 'reload schema';
