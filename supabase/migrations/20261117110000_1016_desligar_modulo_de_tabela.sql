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
--     susto), mas o estado `desligado` fica. Falha de provisionadora continua marcando `suspenso`.
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
      -- trocar o estado.
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
      when others then
        update public.modulos_instalados
          set estado = 'suspenso', motivo_suspensao = sqlerrm
          where modulo = r.modulo;
    end;
  end loop;
  perform pg_notify('pgrst', 'reload schema');
end $$;

revoke execute on function public.fn_reaplicar_modulos_instalados() from public, anon, authenticated, service_role;

comment on table public.modulos_instalados is
  'Módulos opcionais instalados NA INSTÂNCIA (ADR-0002, D3). Sem organization_id: o corte é por instalação. Escrito só por fn_modulo_instalar, fn_modulo_definir_estado (1016: desligar/religar, sem apagar dados) e fn_reaplicar_modulos_instalados.';
