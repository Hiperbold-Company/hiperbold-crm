-- manifest: **Tipo do documento do contato (fork Hiperbold, decisão do dono do produto em 24/11/2026: país Estados Unidos).** Coluna `contacts.document_type text` nullable com CHECK `contacts_document_type_check` (`us_drivers_license`, `us_state_id`, `us_passport`, `us_green_card`, `us_itin`, `foreign_passport`, `br_cpf`; sem SSN de propósito). Coluna nova sem legado em clone nenhum, por isso o CHECK pode entrar; vocabulário em `lib/legal/tipos-de-documento.ts` (`TIPOS_DE_DOCUMENTO_DO_CONTATO`), par em `tests/invariants/vocabulario-banco-x-typescript.test.ts`. O número continua no par `cpf_hash`/`cpf_encrypted` (só servidor); o tipo é gravado junto pelo servidor. Gatilho `trg_contacts_tipo_segue_o_documento` (BEFORE INSERT OR UPDATE, função `fn_contacts_tipo_segue_o_documento`, EXECUTE revogado de public/anon/authenticated) zera o tipo quando `cpf_hash` fica nulo, então a anonimização LGPD apaga o tipo sem reemitir `fn_lgpd_cascade_redact_contact`. O mesmo gatilho é catraca (padrão da 0967): UPDATE que troca `document_type` sem trocar `cpf_hash` é recusado com 42501 para quem não é `service_role`/`postgres`. CHECK criado só quando falta (bloco `do`, padrão da 1012). Sem grant de coluna a anon/authenticated (revoke explícito de select/insert/update), como o par do CPF: o tipo tem a visibilidade do número e só o servidor o lê e grava; o bloco da 0998 no baseline também o exclui. Brasil e Portugal gravam `null` (tipo implícito), comportamento inalterado. Idempotente; espelho no apêndice do `supabase/baseline.sql`.
--
-- 1020, tipo do documento do contato (fork Hiperbold, 24/11/2026).
--
-- Nos EUA não há documento nacional do titular: ele ESCOLHE qual informa (carteira de motorista,
-- State ID, passaporte americano, Green Card, ITIN, passaporte estrangeiro ou CPF). O número segue
-- no par cifrado de sempre; esta coluna diz de que tipo ele é. Idempotente: add column if not
-- exists, constraint só quando falta, create or replace function, drop trigger if exists, grant.

set lock_timeout = '3s';

alter table public.contacts
  add column if not exists document_type text;

-- Só cria quando falta (padrão do bloco 1012): o update.sh reaplica o baseline inteiro, e drop+add
-- revalidaria a tabela toda a cada atualização.
do $hb_1020_check_do_tipo$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.contacts'::regclass
       and conname = 'contacts_document_type_check'
  ) then
    alter table public.contacts
      add constraint contacts_document_type_check
      check (document_type is null or document_type = any (array['us_drivers_license', 'us_state_id',
             'us_passport', 'us_green_card', 'us_itin', 'foreign_passport', 'br_cpf']::text[]));
  end if;
end
$hb_1020_check_do_tipo$;

comment on column public.contacts.document_type is
  'O TIPO do documento gravado em cpf_hash/cpf_encrypted (migration 1020). Só preenchido em país com seletor '
  '(EUA), onde o titular escolhe entre os tipos de lib/legal/tipos-de-documento.ts; null no Brasil e em Portugal '
  '(tipo implícito CPF/NIF) e em contato sem documento. O gatilho trg_contacts_tipo_segue_o_documento zera o tipo '
  'sempre que o par do documento fica nulo (anonimização LGPD inclusive). Sem SSN de propósito.';

-- O tipo morre junto com o documento: quem zera o par (fn_lgpd_cascade_redact_contact, merge, qualquer
-- caminho futuro) zera o tipo sem precisar saber dele. Sem HTTP, sem leitura de outra tabela.
--
-- E o tipo não muda SEM o número (catraca no padrão da 0967): o papel `authenticated` tem grant de
-- UPDATE na coluna (régua de grant por coluna da 0998), e sem esta recusa trocaria pela REST o tipo de
-- um número que ele nem lê — o passaporte viraria "CPF" com os mesmos caracteres. Quem grava o par é
-- o servidor (`service_role`, `gravarCpfDoContatoPorUsuario`) ou função do dono (`postgres`), e esses
-- passam.
create or replace function public.fn_contacts_tipo_segue_o_documento()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE'
     and new.document_type is distinct from old.document_type
     and new.cpf_hash is not distinct from old.cpf_hash
     and current_user not in ('service_role', 'postgres') then
    raise exception 'document_type só muda junto com o documento, pelo servidor'
      using errcode = '42501';
  end if;
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

-- O tipo segue o padrão do PAR do CPF (0967/0998), não o das outras colunas: só o servidor lê e grava.
-- O tipo tem a visibilidade do número (só gerente+ vê, e quem vê é o servidor, com o cliente de serviço);
-- com grant, qualquer membro o leria pela REST. Revoke explícito: quem atualizou de uma versão desta
-- migration que concedia o grant não fica com ele. O bloco da 0998 no fim do baseline também o exclui.
revoke select (document_type), insert (document_type), update (document_type)
  on table public.contacts from public, anon, authenticated;
