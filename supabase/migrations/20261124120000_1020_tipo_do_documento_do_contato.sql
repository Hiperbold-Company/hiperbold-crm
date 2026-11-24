-- manifest: **Tipo do documento do contato (fork Hiperbold, decisão do dono do produto em 24/11/2026: país Estados Unidos).** Coluna `contacts.document_type text` nullable com CHECK `contacts_document_type_check` (`us_drivers_license`, `us_state_id`, `us_passport`, `us_green_card`, `us_itin`, `foreign_passport`, `br_cpf`; sem SSN de propósito). Coluna nova sem legado em clone nenhum, por isso o CHECK pode entrar; vocabulário em `lib/legal/tipos-de-documento.ts` (`TIPOS_DE_DOCUMENTO_DO_CONTATO`), par em `tests/invariants/vocabulario-banco-x-typescript.test.ts`. O número continua no par `cpf_hash`/`cpf_encrypted` (só servidor); o tipo é gravado junto pelo servidor. Gatilho `trg_contacts_tipo_segue_o_documento` (BEFORE INSERT OR UPDATE, função `fn_contacts_tipo_segue_o_documento`, EXECUTE revogado de public/anon/authenticated) zera o tipo quando `cpf_hash` fica nulo, então a anonimização LGPD apaga o tipo sem reemitir `fn_lgpd_cascade_redact_contact`. Grant por coluna (select/insert/update) a anon/authenticated, na régua da 0967/0998. Brasil e Portugal gravam `null` (tipo implícito), comportamento inalterado. Idempotente; espelho no apêndice do `supabase/baseline.sql`.
--
-- 1020, tipo do documento do contato (fork Hiperbold, 24/11/2026).
--
-- Nos EUA não há documento nacional do titular: ele ESCOLHE qual informa (carteira de motorista,
-- State ID, passaporte americano, Green Card, ITIN, passaporte estrangeiro ou CPF). O número segue
-- no par cifrado de sempre; esta coluna diz de que tipo ele é. Idempotente: add column if not
-- exists, drop/add constraint, create or replace function, drop trigger if exists, grant.

set lock_timeout = '3s';

alter table public.contacts
  add column if not exists document_type text;

alter table public.contacts
  drop constraint if exists contacts_document_type_check;

alter table public.contacts
  add constraint contacts_document_type_check
  check (document_type is null or document_type in (
    'us_drivers_license', 'us_state_id', 'us_passport', 'us_green_card',
    'us_itin', 'foreign_passport', 'br_cpf'
  ));

comment on column public.contacts.document_type is
  'O TIPO do documento gravado em cpf_hash/cpf_encrypted (migration 1020). Só preenchido em país com seletor '
  '(EUA), onde o titular escolhe entre os tipos de lib/legal/tipos-de-documento.ts; null no Brasil e em Portugal '
  '(tipo implícito CPF/NIF) e em contato sem documento. O gatilho trg_contacts_tipo_segue_o_documento zera o tipo '
  'sempre que o par do documento fica nulo (anonimização LGPD inclusive). Sem SSN de propósito.';

-- O tipo morre junto com o documento: quem zera o par (fn_lgpd_cascade_redact_contact, merge, qualquer
-- caminho futuro) zera o tipo sem precisar saber dele. Sem HTTP, sem leitura de outra tabela.
create or replace function public.fn_contacts_tipo_segue_o_documento()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if new.cpf_hash is null then
    new.document_type := null;
  end if;
  return new;
end;
$fn$;

revoke execute on function public.fn_contacts_tipo_segue_o_documento() from public, anon, authenticated;

drop trigger if exists trg_contacts_tipo_segue_o_documento on public.contacts;
create trigger trg_contacts_tipo_segue_o_documento
  before insert or update on public.contacts
  for each row execute function public.fn_contacts_tipo_segue_o_documento();

-- A coluna nova segue a régua de grant por coluna da 0967/0998: tudo menos cpf_hash/cpf_encrypted é
-- legível e gravável por anon/authenticated (a RLS decide a linha). O tipo sozinho não é segredo; o
-- número continua só do servidor.
grant select (document_type), insert (document_type), update (document_type)
  on table public.contacts to anon, authenticated;
