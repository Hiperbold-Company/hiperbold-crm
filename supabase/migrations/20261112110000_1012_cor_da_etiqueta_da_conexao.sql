-- 1012, a cor da etiqueta da conexão (fork Hiperbold).
--
-- Cada conexão (channel_sessions) ganha `label_color`: a CHAVE de um dos doze tons pastel da paleta
-- de `lib/conexoes/cores.ts` (CHAVES_DE_COR_DA_CONEXAO). Ela pinta a etiqueta que diz, na lista do
-- Chat, por qual número a conversa entrou, e aparece como prévia no cartão da conexão. Nula = a
-- aparência de antes.
--
-- Chave, e não hex: os tons moram só no código (afináveis sem migration) e cor livre não existe.
-- O CHECK e a tupla do TypeScript são vigiados juntos por
-- tests/invariants/vocabulario-banco-x-typescript.test.ts.
--
-- Idempotente: a coluna nasce nula (nenhuma linha viola o CHECK), e a constraint só é criada se
-- ainda não existir. Antes dela, qualquer valor fora da paleta (só possível por gravação à mão)
-- volta a nulo, para o update de um clone nunca quebrar.
--
-- Grant: `channel_sessions` tem SELECT coluna a coluna para `authenticated` (0948/0998, por causa do
-- token de webhook). Coluna nova não entra sozinha nesse grant, então ela é concedida aqui.

alter table public.channel_sessions add column if not exists label_color text;

update public.channel_sessions
   set label_color = null
 where label_color is not null
   and label_color not in ('rosa', 'coral', 'pessego', 'amarelo', 'lima', 'verde', 'menta',
                           'turquesa', 'azul', 'lavanda', 'lilas', 'cinza');

do $hb_1012_cor_da_conexao$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.channel_sessions'::regclass
       and conname = 'channel_sessions_label_color_check'
  ) then
    alter table public.channel_sessions
      add constraint channel_sessions_label_color_check
      check (label_color is null or label_color = any (array['rosa', 'coral', 'pessego', 'amarelo', 'lima',
             'verde', 'menta', 'turquesa', 'azul', 'lavanda', 'lilas', 'cinza']::text[]));
  end if;
end
$hb_1012_cor_da_conexao$;

comment on column public.channel_sessions.label_color is
  'Chave da cor da etiqueta da conexão (paleta em lib/conexoes/cores.ts). Nula = sem cor. Migration 1012.';

grant select (label_color) on table public.channel_sessions to authenticated;
