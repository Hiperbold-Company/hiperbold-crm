-- manifest: **A chave do cofre das automações fica presa aos endereços que ela pode receber (fork Hiperbold, achado da auditoria do lote 4).** Coluna `automacao_segredos.hosts_permitidos text[]`, nula nas chaves que já existem (seguem indo para qualquer endereço, e a tela avisa) e com CHECK de forma `automacao_segredos_hosts_permitidos_forma`: 1 a 10 itens, cada um host em minúsculas, sem esquema, caminho, porta nem curinga, com pelo menos dois rótulos, sem item nulo (a repetição a rota tira). SELECT da coluna para `authenticated` (não é segredo). O motor (`lib/automacoes/efeitos/http.ts`) confere o host da URL contra a lista antes de anexar a chave, e a requisição não sai. Sem função nova. Espelho no apêndice do `supabase/baseline.sql`, antes da varredura de anon; prova em `tests/invariants/automacao-segredos-cofre.test.ts`.
-- ---- automações: a chave secreta só vai para os endereços permitidos dela (migration 1007, fork Hiperbold) ----
-- 1007 — Quem edita uma automação não vê o valor de nenhuma chave do cofre (1004), mas escolhe a
-- URL do bloco "Requisição HTTP". Sem limite de destino, um bloco apontado para um servidor
-- próprio com a chave no cabeçalho entregava o token. Agora cada chave guarda os hosts para onde
-- pode ir, e o servidor recusa o envio para qualquer outro (regra em `lib/automacoes/hosts-permitidos.ts`).
--
-- `null` = chave anterior a esta migration: continua indo para qualquer endereço, para não quebrar
-- automação publicada. Chave nova nasce com pelo menos um endereço (Zod nas rotas do cofre).
--
-- A forma é conferida no banco, e não só no Zod: a coluna é a régua do envio, e um valor torto
-- (com `https://`, com porta, com `*`) nunca bateria com o host da URL — a chave ficaria muda, ou,
-- pior, alguém leria o item como curinga. Sem subconsulta no CHECK: o item vira texto com
-- `array_to_string` (que PULA nulo — por isso o `array_position(.., null)` à parte) e a lista
-- inteira casa com uma expressão de hosts separados por vírgula. Repetição não é conferida aqui
-- (CHECK não aceita subconsulta, e uma função só para isso seria superfície nova): item repetido
-- é inofensivo, e a rota já grava a lista sem repetição.
--
-- Reaplicável: add column if not exists, constraint conferida no catálogo, grant idempotente.

alter table public.automacao_segredos add column if not exists hosts_permitidos text[];

do $hb_1007_hosts$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.automacao_segredos'::regclass
                 and conname = 'automacao_segredos_hosts_permitidos_forma') then
    -- Nenhuma linha viola: a coluna acabou de nascer nula. Se um clone tiver gravado algo torto
    -- antes (não deveria: só esta migration cria a coluna), o item torto é zerado para nulo — a
    -- chave volta ao comportamento antigo e a tela pede o endereço — em vez de quebrar o update.
    update public.automacao_segredos set hosts_permitidos = null
     where hosts_permitidos is not null
       and not (
         cardinality(hosts_permitidos) between 1 and 10
         and array_position(hosts_permitidos, null) is null
         and char_length(array_to_string(hosts_permitidos, ',')) <= 2540
         -- a vírgula é o separador: um item com vírgula dentro ("a.com,b.com") casaria a expressão
         and char_length(array_to_string(hosts_permitidos, ',')) - char_length(replace(array_to_string(hosts_permitidos, ','), ',', '')) = cardinality(hosts_permitidos) - 1
         and array_to_string(hosts_permitidos, ',') ~
           '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(,[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)*$'
       );
    alter table public.automacao_segredos add constraint automacao_segredos_hosts_permitidos_forma
      check (
        hosts_permitidos is null or (
          cardinality(hosts_permitidos) between 1 and 10
          and array_position(hosts_permitidos, null) is null
          and char_length(array_to_string(hosts_permitidos, ',')) <= 2540
          -- a vírgula é o separador: um item com vírgula dentro ("a.com,b.com") casaria a expressão
          and char_length(array_to_string(hosts_permitidos, ',')) - char_length(replace(array_to_string(hosts_permitidos, ','), ',', '')) = cardinality(hosts_permitidos) - 1
          and array_to_string(hosts_permitidos, ',') ~
            '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(,[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)*$'
        )
      );
  end if;
end
$hb_1007_hosts$;

-- A tela lê a lista pela rota (service role), mas `authenticated` tem SELECT coluna a coluna
-- (1004): a coluna nova entra nele, porque não é segredo.
grant select (hosts_permitidos) on table public.automacao_segredos to authenticated;

comment on column public.automacao_segredos.hosts_permitidos is
  '1007: os hosts para onde o bloco Requisição HTTP pode mandar esta chave (minúsculas, sem esquema, porta nem curinga). null = chave anterior à 1007, vai para qualquer endereço.';

notify pgrst, 'reload schema';
