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
--  2. RLS: o membro só INSERE, na própria organização, como ele mesmo, com status `novo` e sem
--     nota. `authenticated` não tem SELECT, UPDATE nem DELETE: nenhum membro lê relato, nem o
--     próprio. A leitura e a troca de status são do administrador da instalação, pelo service
--     role. As CHECKs repetem os limites da rota, porque quem tem a anon key e uma sessão pode
--     inserir direto pela REST, sem passar pelo Zod.
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
    check (page_url is null or char_length(page_url) <= 2000),
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

alter table public.bug_reports enable row level security;

drop policy if exists bug_reports_insert_membro on public.bug_reports;
create policy bug_reports_insert_membro on public.bug_reports
  for insert to authenticated
  with check (
    organization_id in (select public.fn_user_org_ids())
    and user_id = (select auth.uid())
    and status = 'novo'
    and admin_note is null
  );

-- `service_role` também sai do `revoke all` (o default ACL do Supabase dá tudo aos três papéis)
-- e recebe de volta só o que usa, como na 1017.
revoke all on public.bug_reports from public, anon, authenticated, service_role;
grant insert on public.bug_reports to authenticated;
grant select, insert, update, delete on public.bug_reports to service_role;

comment on table public.bug_reports is
  'Migration 1018 (fork Hiperbold): relato de problema enviado pelo botão "Relatar problema" do CRM. O membro só insere (POST /api/v1/bug-reports); quem lê e muda o status é o administrador da instalação em /admin/relatos, pelo service role. Linha e print saem aos 90 dias (cron data-retention).';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bug-reports', 'bug-reports', false, 3145728, array['image/webp', 'image/png'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
