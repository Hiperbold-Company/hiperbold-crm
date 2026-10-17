/**
 * CPF normalization + hashing helpers.
 *
 * `cpf_hash` is sha256(hex) of the 11-digit normalized CPF — used for exact-match
 * lookup and dedup without exposing plaintext. At-rest encryption (column
 * `cpf_encrypted bytea`) requires a server-side `encrypt_cpf` SQL function which
 * is not yet provisioned — see follow-up note in EPIC-05 commit message.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export function normalizeCpf(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Stable sha256 hex of normalized CPF for fuzzy/exact search via `cpf_hash`.
 */
export function hashCpf(raw: string): string {
  return createHash("sha256").update(normalizeCpf(raw)).digest("hex");
}

/**
 * At-rest CPF encryption via pgcrypto-backed `encrypt_cpf` RPC.
 *
 * Returns null when the RPC is not yet provisioned in the database — caller
 * should still persist `cpf_hash` and emit a single console.warn (we tolerate
 * the gap until the migration lands).
 */
export async function encryptCpfSql(
  supabase: SupabaseClient,
  plaintext: string,
): Promise<Uint8Array | null> {
  const { data, error } = await supabase.rpc("encrypt_cpf", { p_plaintext: plaintext });
  if (error) {
    console.warn(
      "[contacts.cpf] encrypt_cpf RPC unavailable — storing cpf_hash only.",
      error.message,
    );
    return null;
  }
  if (!data) return null;
  return data as Uint8Array;
}

/**
 * Cifra o CPF com a chave da INSTALAÇÃO, no banco: a RPC `fn_encrypt_oauth`
 * (`pgp_sym_encrypt`, aes256, chave de `private.app_secrets` /
 * `app.nuvemshop_oauth_key`; `execute` só para `service_role`). É o que o
 * formulário de captação grava em `contacts.cpf_encrypted`, junto de
 * `cpf_hash = hashCpf(cpf)` — a constraint `contacts_cpf_consistency` exige os
 * dois ou nenhum. Para ler de volta: `fn_decrypt_oauth(cpf_encrypted)`, também
 * só `service_role`.
 *
 * Existe porque `encryptCpfSql` chama a RPC `encrypt_cpf`, que NÃO existe no
 * schema (congelada em `tests/unit/rpc-do-codigo-nasce-no-schema.test.ts`).
 *
 * Devolve `null` sem lançar quando o banco não consegue cifrar (chave mestra
 * ausente): quem chama NÃO grava o CPF em claro nesse caso. O erro nunca é
 * logado com o texto do CPF.
 */
export async function cifrarCpfDaInstalacao(
  admin: SupabaseClient,
  digitos: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc("fn_encrypt_oauth", { plaintext: digitos });
  if (error || !data) return null;
  return data as unknown as string;
}
