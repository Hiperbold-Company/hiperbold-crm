-- 1018, relatos de problema (fork Hiperbold, decisão do dono do produto em 17/11/2026).
--
-- Todo usuário logado no CRM ganha, no computador, uma aba "Relatar problema" presa à borda
-- direita. Ela tira um print da tela, abre um formulário com a descrição e manda tudo para
-- `POST /api/v1/bug-reports`. Quem lê é só o administrador da instalação, na tela
-- `/admin/relatos`, pelo client de serviço. Não há aviso externo nem retorno ao usuário.
--
--  1. `bug_reports`: organização, quem relatou, descrição (10 a 2000 caracteres), a tela,
--     o contexto técnico (jsonb: user agent, viewport, idioma, últimos erros do console),
--     o caminho do print no bucket, status com CHECK (novo, em_andamento, resolvido,
--     descartado) e a nota do administrador.
--  2. RLS ligada e NENHUM papel do PostgREST além do `service_role` toca a tabela: nem `anon`
--     nem `authenticated` leem, inserem, alteram ou apagam. Quem grava é a rota, pelo service
--     role, com `organization_id` e `user_id` da sessão (`requireRole`). Um insert direto pela
--     REST furaria o limite de 10 por hora e gravaria `created_at` no futuro, fora da poda.
--     Banco que já recebeu a versão anterior desta migration (com insert para `authenticated`)
--     perde o grant e a policy aqui: `revoke all` + `drop policy if exists`.
--  2b. `page_url` só aceita caminho relativo (`/...`, nunca `//...`, sem `\` e sem esquema): o
--     painel do administrador monta link com ele, e uma URL externa viraria isca de golpe.
--  3. O caminho do print só pode ser `<organization_id>/<id>.webp` (ou `.png`): o cron de
--     retenção apaga o arquivo pelo caminho da linha, e um caminho escolhido pelo cliente
--     apontaria a poda para o arquivo de outro lugar.
--  4. Bucket privado `bug-reports` (3 MB, webp e png), sem policy em `storage.objects`: só o
--     service role sobe e assina.
--
-- Retenção: o cron `data-retention` apaga linha e print com mais de 90 dias.
-- Idempotente: create ... if not exists, drop/create policy, insert ... on conflict.
-- Gate: tests/invariants/relatos-de-problema-rls.test.ts.

create table if not exists public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  description text not null,
  page_url text,
  context jsonb not null default '{}'::jsonb,
  screenshot_path text,
  status text not null default 'novo',
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bug_reports_status_check
    check (status in ('novo', 'em_andamento', 'resolvido', 'descartado')),
  constraint bug_reports_description_check
    check (char_length(description) between 10 and 2000),
  constraint bug_reports_page_url_check
    check (
      page_url is null
      or (
        char_length(page_url) <= 2000
        and left(page_url, 1) = '/'
        and left(page_url, 2) <> '//'
        and position(chr(92) in page_url) = 0
      )
    ),
  constraint bug_reports_context_check
    check (jsonb_typeof(context) = 'object' and pg_column_size(context) <= 16384),
  constraint bug_reports_admin_note_check
    check (admin_note is null or char_length(admin_note) <= 2000),
  constraint bug_reports_screenshot_path_check
    check (
      screenshot_path is null
      or screenshot_path = organization_id::text || '/' || id::text || '.webp'
      or screenshot_path = organization_id::text || '/' || id::text || '.png'
    )
);

-- A lista da administração: por status, os mais novos primeiro.
create index if not exists bug_reports_status_created_idx
  on public.bug_reports (status, created_at desc);
-- A poda de 90 dias.
create index if not exists bug_reports_created_idx
  on public.bug_reports (created_at);

-- A regra do `page_url` também em banco que já tinha a tabela com a CHECK antiga (só tamanho):
-- o valor fora da regra vira nulo ANTES de a constraint nova entrar, senão o update quebra.
update public.bug_reports
   set page_url = null
 where page_url is not null
   and not (
     char_length(page_url) <= 2000
     and left(page_url, 1) = '/'
     and left(page_url, 2) <> '//'
     and position(chr(92) in page_url) = 0
   );
alter table public.bug_reports drop constraint if exists bug_reports_page_url_check;
alter table public.bug_reports add constraint bug_reports_page_url_check
  check (
    page_url is null
    or (
      char_length(page_url) <= 2000
      and left(page_url, 1) = '/'
      and left(page_url, 2) <> '//'
      and position(chr(92) in page_url) = 0
    )
  );

alter table public.bug_reports enable row level security;

-- Nenhuma policy para `authenticated`: quem grava é só o servidor. O drop desfaz a versão
-- anterior desta migration num banco que já a recebeu.
drop policy if exists bug_reports_insert_membro on public.bug_reports;

-- `service_role` também sai do `revoke all` (o default ACL do Supabase dá tudo aos três papéis)
-- e recebe de volta só o que usa, como na 1017. `anon` e `authenticated` ficam sem nada.
revoke all on public.bug_reports from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.bug_reports to service_role;

comment on table public.bug_reports is
  'Migration 1018 (fork Hiperbold): relato de problema enviado pelo botão "Relatar problema" do CRM. Só o service role toca a tabela: a rota POST /api/v1/bug-reports grava com a organização e o usuário da sessão; quem lê e muda o status é o administrador da instalação em /admin/relatos, pelo service role. Linha e print saem aos 90 dias (cron data-retention).';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bug-reports', 'bug-reports', false, 3145728, array['image/webp', 'image/png'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
