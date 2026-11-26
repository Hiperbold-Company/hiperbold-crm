-- manifest: **A transcrição de áudio desconta tokens do plano (fork Hiperbold, 25/11/2026).** `llm_calls.audio_seconds` (numeric, nula) guarda a duração que o serviço informou; `fn_billing_ponderado_da_chamada` faz o débito (`fn_billing_debitar_chamada`) e o conferidor (`fn_billing_debitos_pendentes`) ponderarem a transcrição pela duração, 6.000 tokens por minuto (`fn_billing_tokens_por_minuto_de_audio`), arredondado para cima, só com a chave da instalação. Espelho no apêndice do `supabase/baseline.sql`.
--
-- Decisão do dono do produto: a transcrição pela chave da instalação desconta
-- do plano como as outras chamadas de IA. A linha de transcrição tem 0 tokens
-- (o serviço cobra por minuto), então o débito saía cedo pelo "ponderado zero"
-- e o áudio nunca descontava nada. Transcrição que falhou (status erro) ou sem
-- duração conhecida continua sem débito; credencial da organização continua
-- fora da carteira (a régua de origem_da_chave não muda).
--
-- Idempotente: add column if not exists, constraint nomeada criada só se não
-- existe, create or replace, revoke/grant reaplicáveis. Sem dado a corrigir:
-- a coluna nasce nula em toda linha antiga, e linha antiga não debita de novo
-- (o livro-caixa já tem ou não tem a linha dela; o conferidor só olha 35 dias
-- e só chamadas sem linha, que com duração nula seguem com ponderado zero).
-- Coluna nova: a duração do áudio transcrito, em segundos. Nula em toda
-- chamada que não é transcrição e na transcrição cuja duração o serviço não
-- informou (aí não há débito por duração: nunca uma estimativa).
alter table public.llm_calls add column if not exists audio_seconds numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'llm_calls_audio_seconds_check') then
    alter table public.llm_calls
      add constraint llm_calls_audio_seconds_check check (audio_seconds is null or audio_seconds >= 0);
  end if;
end
$$;

comment on column public.llm_calls.audio_seconds is
  '1025: duração do áudio transcrito, em segundos, informada pelo serviço de transcrição. Base do débito da transcrição na carteira (fn_billing_ponderado_da_chamada). Nula = desconhecida ou não é transcrição.';

-- A TAXA, num lugar só e com nome. Decisão do dono do produto (25/11/2026):
-- 6.000 tokens ponderados por minuto de áudio. Constante de propósito, e não
-- coluna de billing_settings: trocar a taxa é decisão de preço, e uma
-- migration nova deixa o rastro de quando ela mudou.
create or replace function public.fn_billing_tokens_por_minuto_de_audio()
returns integer
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select 6000
$$;

comment on function public.fn_billing_tokens_por_minuto_de_audio() is
  '1025: tokens ponderados por minuto de áudio transcrito (6.000, decisão do dono do produto em 25/11/2026). Lugar único da taxa; quem lê é fn_billing_ponderado_da_chamada.';

revoke execute on function public.fn_billing_tokens_por_minuto_de_audio() from public, anon, authenticated;
grant execute on function public.fn_billing_tokens_por_minuto_de_audio() to service_role;

-- O ponderado de UMA chamada, para o débito e para o conferidor. A
-- transcrição de áudio (purpose = transcricao_de_audio) que deu certo e tem
-- duração positiva pondera pelos segundos: ceil(segundos * taxa / 60 *
-- peso_proposito / 100). Qualquer outra chamada (inclusive a transcrição pelo
-- modelo de conversa, que já traz tokens e nenhuma duração) segue a fórmula
-- de tokens de sempre, fn_billing_tokens_ponderados. O peso por propósito
-- multiplica as duas, como multiplicava antes (padrão 100).
create or replace function public.fn_billing_ponderado_da_chamada(
  p_purpose text,
  p_status text,
  p_audio_seconds numeric,
  p_input int,
  p_output int,
  p_cache_read int,
  p_peso_cache int,
  p_peso_proposito int
)
returns bigint
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_purpose = 'transcricao_de_audio'
      and p_status is not distinct from 'ok'
      and p_audio_seconds is not null
      and p_audio_seconds > 0
    then ceil(
      p_audio_seconds
      * public.fn_billing_tokens_por_minuto_de_audio()::numeric / 60
      * p_peso_proposito::numeric / 100
    )::bigint
    else public.fn_billing_tokens_ponderados(p_input, p_output, p_cache_read, p_peso_cache, p_peso_proposito)
  end
$$;

comment on function public.fn_billing_ponderado_da_chamada(text, text, numeric, int, int, int, int, int) is
  '1025: ponderado de uma chamada de llm_calls. Transcrição de áudio com status ok e audio_seconds > 0: ceil(audio_seconds * fn_billing_tokens_por_minuto_de_audio() / 60 * peso_proposito / 100). O resto: fn_billing_tokens_ponderados. Régua única de fn_billing_debitar_chamada e fn_billing_debitos_pendentes.';

revoke execute on function public.fn_billing_ponderado_da_chamada(text, text, numeric, int, int, int, int, int) from public, anon, authenticated;
grant execute on function public.fn_billing_ponderado_da_chamada(text, text, numeric, int, int, int, int, int) to service_role;

-- O débito, com o ponderado pela régua nova. Corpo copiado da última
-- definição (0906, Parte 2); só mudam as duas colunas lidas a mais e a
-- chamada de fn_billing_ponderado_da_chamada.
create or replace function public.fn_billing_debitar_chamada(p_llm_call_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_chamada record;
  v_settings record;
  v_peso_proposito int;
  v_ponderado bigint;
  v_ciclo date;
  v_dia date;
  v_restante bigint;
  v_disponivel_fonte bigint;
  v_teto_efetivo bigint;
  v_debito_plano bigint := 0;
  v_debito_adicional bigint := 0;
  v_debito_avulso bigint := 0;
  v_linhas int;
  v_entrou boolean := false;
begin
  select c.organization_id, c.created_at, c.legacy_invocation_id, c.origem_da_chave,
         c.purpose, c.agent_id, c.contact_id, c.input_tokens, c.output_tokens,
         c.cache_read_tokens, c.cost_cents, c.status, c.audio_seconds
    into v_chamada
    from public.llm_calls c
    where c.id = p_llm_call_id;

  if not found then
    return false;
  end if;

  -- Decisão 5: histórico copiado nunca debita.
  if v_chamada.legacy_invocation_id is not null then
    return false;
  end if;

  -- Decisão 3/N17: só a chave da instalação passa pela carteira. Nulo
  -- (ponto do código que ainda não grava a origem) e credencial_da_organizacao
  -- (BYOK, o cliente já paga direto) saem sem debitar.
  if v_chamada.origem_da_chave is distinct from 'chave_da_instalacao' then
    return false;
  end if;

  select carteira_desde, peso_cache_leitura_pct, pesos_por_proposito
    into v_settings
    from public.billing_settings
    where id = 1;

  -- Decisão 5: marca de início. Sem isso a primeira noite do conferidor
  -- (Tarefa 8) cobraria de uma vez todo o histórico anterior à carteira.
  if v_chamada.created_at < v_settings.carteira_desde then
    return false;
  end if;

  v_peso_proposito := coalesce((v_settings.pesos_por_proposito ->> v_chamada.purpose)::int, 100);

  -- 1025: a transcrição de áudio pondera pela DURAÇÃO (6.000 tokens por
  -- minuto); o resto, pelos tokens. Uma régua só, a mesma do conferidor
  -- (fn_billing_debitos_pendentes): fn_billing_ponderado_da_chamada.
  v_ponderado := public.fn_billing_ponderado_da_chamada(
    v_chamada.purpose,
    v_chamada.status,
    v_chamada.audio_seconds,
    v_chamada.input_tokens,
    v_chamada.output_tokens,
    v_chamada.cache_read_tokens,
    v_settings.peso_cache_leitura_pct,
    v_peso_proposito
  );

  -- Decisão 1: ponderado zero não gera linha nenhuma.
  if v_ponderado = 0 then
    return false;
  end if;

  -- Decisão 4: ciclo e dia SEMPRE do momento da CHAMADA, nunca de now().
  v_ciclo := public.fn_billing_ciclo_de(v_chamada.created_at);
  v_dia := (v_chamada.created_at at time zone 'America/Sao_Paulo')::date;

  -- Decisão 10/11: trava SEM espera, por organização. Se outra sessão já
  -- segura, sai já (o conferidor da Tarefa 8 pega depois); nunca atrasa
  -- quem inseriu a chamada.
  if not pg_try_advisory_xact_lock(hashtextextended('billing_tokens:' || v_chamada.organization_id::text, 0)) then
    return false;
  end if;

  -- M1 (auditoria de segurança, 23/09/2026): idempotência de verdade, logo
  -- depois de pegar a trava. As chaves 'consumo:<id>:<fonte>' só travam
  -- reenvio da MESMA fonte; se entre duas execuções desta função um crédito
  -- avulso mudar a divisão entre fontes (decisão 6), a segunda execução
  -- gravava uma linha de fonte NOVA para a MESMA chamada, debitando duas
  -- vezes o total (30.000 viravam 31.000, medido). Uma chamada já debitada
  -- (QUALQUER linha 'consumo:%' dela no livro-caixa) nunca é debitada de
  -- novo, ponto final.
  if exists (
    select 1 from public.billing_token_ledger
    where organization_id = v_chamada.organization_id and llm_call_id = p_llm_call_id
  ) then
    return false;
  end if;

  -- Já sob a trava: garante a concessão do ciclo DA CHAMADA (fn_billing_
  -- garantir_concessoes não faz nada sozinha se esse ciclo já fechou).
  perform public.fn_billing_garantir_concessoes(v_chamada.organization_id, v_ciclo);

  -- Item 4 da revisão (23/09/2026): Ilimitado (teto efetivo nulo) não pode
  -- consumir adicional nem avulso, mesmo que a organização tenha saldo de
  -- sobra nessas duas fontes (por exemplo, um pacote avulso comprado antes
  -- de virar Ilimitado): o ponderado inteiro cai direto em plano, sem
  -- fatiar. Sem este desvio, uma organização Ilimitada com avulso sobrando
  -- via aquele saldo escoar antes de "sem limite" fazer sentido de verdade.
  v_teto_efetivo := (public.fn_billing_limites_efetivos(v_chamada.organization_id) ->> 'tokens_ia_mes')::bigint;

  if v_teto_efetivo is null then
    v_debito_plano := v_ponderado;
  else
    -- Decisão 6: divide pelas fontes, nesta ordem, pelo saldo (creditado -
    -- consumido) de cada uma. sum() garante uma linha sempre (mesmo sem
    -- wallet ainda criada, vira 0 pelo coalesce) em vez de "select" simples,
    -- que sobre zero linhas deixaria a variável com o valor da fonte anterior.
    select coalesce(sum(creditado - consumido), 0) into v_disponivel_fonte
      from public.billing_token_wallets
      where organization_id = v_chamada.organization_id and fonte = 'plano' and ciclo = v_ciclo;
    v_restante := v_ponderado;
    v_debito_plano := least(v_restante, greatest(v_disponivel_fonte, 0));
    v_restante := v_restante - v_debito_plano;

    select coalesce(sum(creditado - consumido), 0) into v_disponivel_fonte
      from public.billing_token_wallets
      where organization_id = v_chamada.organization_id and fonte = 'adicional' and ciclo = v_ciclo;
    v_debito_adicional := least(v_restante, greatest(v_disponivel_fonte, 0));
    v_restante := v_restante - v_debito_adicional;

    select coalesce(sum(creditado - consumido), 0) into v_disponivel_fonte
      from public.billing_token_wallets
      where organization_id = v_chamada.organization_id and fonte = 'avulso' and ciclo is null;
    v_debito_avulso := least(v_restante, greatest(v_disponivel_fonte, 0));
    v_restante := v_restante - v_debito_avulso;

    -- O que sobra depois de zerar as três vai SOMADO na linha de plano
    -- (decisão 6): nunca uma quarta linha, nunca duas linhas de plano na
    -- mesma chamada. É o caso que atravessa o fim do saldo.
    v_debito_plano := v_debito_plano + v_restante;
  end if;

  if v_debito_plano > 0 then
    -- A1 (auditoria de segurança, item 2, defesa em profundidade): grava o
    -- ciclo DA CHAMADA também na linha de CONSUMO, não só na de concessão
    -- (que já carrega o ciclo na chave). fn_billing_conferir_carteira (Parte
    -- 4, abaixo) passa a recalcular consumido por esta coluna, sem depender
    -- de llm_calls continuar viva nem gravável por ninguém além de
    -- service_role.
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, llm_call_id, ciclo)
    values (v_chamada.organization_id, 'plano', -v_debito_plano, 'consumo:' || p_llm_call_id::text || ':plano', p_llm_call_id, v_ciclo)
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      v_entrou := true;
      insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
      values (v_chamada.organization_id, 'plano', v_ciclo, 0, v_debito_plano)
      on conflict (organization_id, fonte, ciclo) do update
        set consumido = public.billing_token_wallets.consumido + excluded.consumido,
            updated_at = now();
    end if;
  end if;

  if v_debito_adicional > 0 then
    -- A1, item 2 (defesa em profundidade): mesmo racional do bloco de plano,
    -- acima.
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, llm_call_id, ciclo)
    values (v_chamada.organization_id, 'adicional', -v_debito_adicional, 'consumo:' || p_llm_call_id::text || ':adicional', p_llm_call_id, v_ciclo)
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      v_entrou := true;
      insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
      values (v_chamada.organization_id, 'adicional', v_ciclo, 0, v_debito_adicional)
      on conflict (organization_id, fonte, ciclo) do update
        set consumido = public.billing_token_wallets.consumido + excluded.consumido,
            updated_at = now();
    end if;
  end if;

  if v_debito_avulso > 0 then
    -- A1, item 2 (defesa em profundidade): a linha de consumo também grava
    -- o ciclo da chamada, informativo (a carteira avulso não usa ciclo,
    -- decisão 6/N13: fn_billing_conferir_carteira, abaixo, ignora esta
    -- coluna para a fonte avulso e soma a fonte inteira, como já fazia).
    insert into public.billing_token_ledger (organization_id, fonte, tokens, chave, llm_call_id, ciclo)
    values (v_chamada.organization_id, 'avulso', -v_debito_avulso, 'consumo:' || p_llm_call_id::text || ':avulso', p_llm_call_id, v_ciclo)
    on conflict (organization_id, chave) do nothing;

    get diagnostics v_linhas = row_count;
    if v_linhas > 0 then
      v_entrou := true;
      insert into public.billing_token_wallets (organization_id, fonte, ciclo, creditado, consumido)
      values (v_chamada.organization_id, 'avulso', null, 0, v_debito_avulso)
      on conflict (organization_id, fonte, ciclo) do update
        set consumido = public.billing_token_wallets.consumido + excluded.consumido,
            updated_at = now();
    end if;
  end if;

  -- Decisão 13: o agregado só muda quando ALGUMA linha de consumo entrou de
  -- fato, uma vez por chamada, com o ponderado TOTAL (não fatiado por fonte)
  -- e os brutos crus da chamada.
  if v_entrou then
    insert into public.billing_token_consumo_diario (
      organization_id, dia, agent_id, contact_id, purpose,
      tokens_ponderados, tokens_entrada, tokens_saida, tokens_cache_lido,
      chamadas, cost_cents_conhecido, chamadas_custo_nulo
    )
    values (
      v_chamada.organization_id, v_dia, v_chamada.agent_id, v_chamada.contact_id, v_chamada.purpose,
      v_ponderado, v_chamada.input_tokens, v_chamada.output_tokens, v_chamada.cache_read_tokens,
      1, coalesce(v_chamada.cost_cents, 0), case when v_chamada.cost_cents is null then 1 else 0 end
    )
    on conflict (organization_id, dia, agent_id, contact_id, purpose) do update
      set tokens_ponderados = public.billing_token_consumo_diario.tokens_ponderados + excluded.tokens_ponderados,
          tokens_entrada = public.billing_token_consumo_diario.tokens_entrada + excluded.tokens_entrada,
          tokens_saida = public.billing_token_consumo_diario.tokens_saida + excluded.tokens_saida,
          tokens_cache_lido = public.billing_token_consumo_diario.tokens_cache_lido + excluded.tokens_cache_lido,
          chamadas = public.billing_token_consumo_diario.chamadas + excluded.chamadas,
          cost_cents_conhecido = public.billing_token_consumo_diario.cost_cents_conhecido + excluded.cost_cents_conhecido,
          chamadas_custo_nulo = public.billing_token_consumo_diario.chamadas_custo_nulo + excluded.chamadas_custo_nulo,
          updated_at = now();
  end if;

  -- Tarefa 2b (decisões 14 e 15): avisos de limiar (50/80/100%) e travas de
  -- segurança por organização e por conversa, só quando ALGUMA linha de
  -- consumo entrou de fato E o ciclo DA CHAMADA é o ciclo ATUAL: débito
  -- tardio de um ciclo já fechado (o conferidor da Tarefa 8) nunca avisa.
  -- Já dentro da MESMA advisory lock da organização que este débito segura
  -- (item 10, acima); fn_billing_avisar_carteira (Parte 3, fim deste
  -- arquivo) nunca lança (captura o próprio erro), então uma falha ali nunca
  -- derruba este débito.
  if v_entrou and v_ciclo = public.fn_billing_ciclo_de(now()) then
    perform public.fn_billing_avisar_carteira(v_chamada.organization_id, v_ciclo, v_dia, v_chamada.contact_id);
  end if;

  return v_entrou;
end;
$$;

revoke execute on function public.fn_billing_debitar_chamada(uuid) from public, anon, authenticated;
grant execute on function public.fn_billing_debitar_chamada(uuid) to service_role;

-- O conferidor diário, com a MESMA régua: sem isto, a transcrição que o
-- gatilho não debitou (trava ocupada) nunca seria achada (ponderado de tokens
-- = 0). Corpo copiado da última definição (0906, Parte 4).
create or replace function public.fn_billing_debitos_pendentes(p_org uuid, p_limite integer default 500)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id
  from public.llm_calls c, public.billing_settings s
  where s.id = 1
    and c.organization_id = p_org
    -- Item 3 da revisão (23/09/2026): sem s.pesos_alterados_em aqui, trocar
    -- um peso de 0 para um valor maior (ex.: embedding_indexar) faria este
    -- conferidor recalcular com o peso NOVO até 35 dias de chamada ANTIGA
    -- que nunca deveriam ter debitado nada (o peso vigente no momento da
    -- chamada era 0). greatest() ignora NULL sozinho (pesos_alterados_em
    -- nunca mudou = coluna nula = sem efeito nesta comparação).
    and c.created_at >= greatest(s.carteira_desde, s.pesos_alterados_em, now() - interval '35 days')
    and c.legacy_invocation_id is null
    and c.origem_da_chave = 'chave_da_instalacao'
    and public.fn_billing_ponderado_da_chamada(
          c.purpose,
          c.status,
          c.audio_seconds,
          c.input_tokens,
          c.output_tokens,
          c.cache_read_tokens,
          s.peso_cache_leitura_pct,
          coalesce((s.pesos_por_proposito ->> c.purpose)::int, 100)
        ) > 0
    and not exists (
      select 1 from public.billing_token_ledger l where l.llm_call_id = c.id
    )
  order by c.created_at
  limit p_limite
$$;

revoke execute on function public.fn_billing_debitos_pendentes(uuid, integer) from public, anon, authenticated;
grant execute on function public.fn_billing_debitos_pendentes(uuid, integer) to service_role;

-- agent_worker (bypassrls) ganharia execute nas funções novas por alter
-- default privileges: mesmo bloco das partes da 0906.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'agent_worker') then
    execute 'revoke execute on function public.fn_billing_tokens_por_minuto_de_audio(), public.fn_billing_ponderado_da_chamada(text, text, numeric, int, int, int, int, int) from agent_worker';
  end if;
end
$$;

notify pgrst, 'reload schema';
