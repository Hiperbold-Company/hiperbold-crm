-- 0973 — organização nova nasce com a IA da instalação: OpenRouter + Luna (decisão do dono, 20/10/2026)
--
-- Toda chamada de IA que roda na CHAVE DA INSTALAÇÃO (a que desconta dos tokens do plano) sai pela
-- OpenRouter, com o modelo liberado em `MODELOS_DA_INSTALACAO` (hoje Luna, `openai/gpt-6-luna`). O gatilho
-- `trg_seed_org_llm_defaults` ainda semeava `provider = 'anthropic'` e `default_model = <o curado da
-- Anthropic>` em toda organização nova — um padrão que a chave da instalação já não executa (o freio de custo
-- o trocava por Luna na hora do turno, mas o cadastro mostrava Claude).
--
-- Agora o gatilho semeia o par `openrouter` + o PRIMEIRO modelo de `platform_config.MODELOS_DA_INSTALACAO`
-- (a lista que o operador edita em /admin/configuracao) e, sem linha ou com a lista em `*`, o literal Luna.
-- Quem cola a PRÓPRIA chave depois troca o par em Configurações › IA (`padrao-da-organizacao.ts`), como antes.
--
-- Não toca organização existente: o padrão delas é escolha (ou herança) que o dono do produto reavalia
-- caso a caso, e o motor já manda a chave da instalação pela OpenRouter qualquer que seja o provedor gravado.
--
-- Reaplicável: create or replace + drop/create trigger.

create or replace function public.fn_seed_org_llm_defaults() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_lista  text;
  v_modelo text;
begin
  if coalesce(new.settings->'llm'->>'default_model', '') = '' then
    -- O primeiro da lista liberada na chave da instalação. `platform_config` pode não existir num clone
    -- com o schema atrasado: nesse caso vale o literal.
    begin
      select valor into v_lista
        from public.platform_config
       where chave = 'MODELOS_DA_INSTALACAO' and not eh_segredo
       limit 1;
    exception when others then
      v_lista := null;
    end;
    v_modelo := nullif(btrim(split_part(regexp_replace(coalesce(v_lista, ''), '[;' || chr(10) || ']', ',', 'g'), ',', 1)), '');
    if v_modelo is null or v_modelo = '*' then
      v_modelo := 'openai/gpt-6-luna';
    end if;
    new.settings := jsonb_set(
      coalesce(new.settings, '{}'::jsonb),
      '{llm}',
      coalesce(new.settings->'llm', '{}'::jsonb)
        || jsonb_build_object('provider', 'openrouter', 'default_model', v_modelo),
      true
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_seed_org_llm_defaults() from public, anon;

drop trigger if exists trg_seed_org_llm_defaults on public.organizations;
create trigger trg_seed_org_llm_defaults
  before insert on public.organizations
  for each row execute function public.fn_seed_org_llm_defaults();
