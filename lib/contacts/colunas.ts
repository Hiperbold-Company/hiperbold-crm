/**
 * Todas as colunas de `contacts` MENOS as do documento (`cpf_hash`, `cpf_encrypted` e o tipo, `document_type`), na
 * ordem do banco.
 *
 * Para quem lê o contato inteiro (contexto de automação, por exemplo) sem `select *`: o `*` traria o hash e o
 * cifrado do CPF para a memória, de onde `{{contact.cpf_hash}}` poderia sair num texto enviado ao cliente (D-216).
 *
 * A lista é vigiada por `tests/invariants/contacts-cpf-so-do-servidor.test.ts`: coluna nova em `contacts` reprova até
 * ser acrescentada aqui (e ao grant de coluna da migration que a criou).
 */
export const COLUNAS_DO_CONTATO_SEM_CPF = [
  "id",
  "organization_id",
  "name",
  "display_name",
  "email",
  "email_normalized",
  "phone_number",
  "birthdate",
  "is_blocked",
  "blocked_reason",
  "blocked_at",
  "is_anonymized",
  "anonymized_at",
  "is_merged_into",
  "merged_at",
  "consent",
  "tags",
  "source",
  "source_metadata",
  "created_at",
  "updated_at",
  "created_by_user_id",
  "last_activity_at",
  "force_human",
  "wa_identity",
  "phone_lookup_at",
  "locale",
  "avatar_storage_path",
  "avatar_updated_at",
  "wa_lid",
  "ai_authorized_at",
  "ai_authorized_reason",
  "custom_fields",
  "birthday_md",
  "first_service_at",
  "client_recognized_at",
  "client_tag_by_system",
  "social_identity",
  "person_id",
  "kind",
  "carteira_user_id",
  "carteira_origem",
  "carteira_definida_em",
  "address_book_name",
  "name_lookup_at",
  "is_personal",
  "phone_type",
  "phone_whatsapp",
  "zip_code",
  "street",
  "number",
  "complement",
  "district",
  "city",
  "state",
  "busca_sem_acento",
  "ai_opt_out",
  "contact_type",
  // `document_type` (migration 1020) fica FORA, como o par do CPF: o tipo do
  // documento tem a visibilidade do número (só gerente+ vê), e o contexto da
  // automação vai para texto enviado ao cliente.
].join(", ");
