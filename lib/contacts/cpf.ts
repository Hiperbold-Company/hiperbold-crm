/**
 * CPF normalization + hashing helpers.
 *
 * `cpf_hash` é um HMAC-SHA256 (hex) do CPF de 11 dígitos, com a chave do SERVIDOR (`CPF_ENCRYPTION_KEY`, a
 * mesma da impressão do cupom em `lib/billing/asaas/cupom.ts`). Serve para busca exata e deduplicação sem expor
 * o CPF. Um SHA-256 puro não servia: o espaço de CPFs válidos é pequeno (~10^9) e o hash se desfaz por força
 * bruta em minutos por quem tenha acesso à coluna ou à resposta da API. Sem a chave, `hashCpf` devolve `null` e
 * quem chama NÃO grava o CPF (falha fechada). A migração dos hashes antigos é
 * `hiperbold/scripts/recalcular-cpf-hash.mts`.
 *
 * ⚠️ As duas colunas são um PAR (#2522, upstream): `contacts_cpf_consistency` exige
 * `(cpf_encrypted IS NULL) = (cpf_hash IS NULL)`. Use `camposCpfParaGravar`, nunca `hashCpf` sozinho.
 */
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";

export function normalizeCpf(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** Prefixo de domínio do HMAC: a mesma chave em outro uso (cupom) nunca produz o mesmo valor. */
const DOMINIO_DO_HASH_DE_CPF = "hiperbold:cpf:hash:v1:";

/** O servidor tem a chave que sustenta o `cpf_hash`? */
export function chaveDoCpfConfigurada(chave: string | undefined = process.env.CPF_ENCRYPTION_KEY): boolean {
  return (chave ?? "").trim() !== "";
}

/**
 * HMAC-SHA256 (hex) do CPF normalizado, para busca exata via `cpf_hash`. `null` quando o servidor não tem a
 * chave: quem chama não grava o CPF nem monta busca por ele.
 */
export function hashCpf(
  raw: string,
  chave: string | undefined = process.env.CPF_ENCRYPTION_KEY,
): string | null {
  const segredo = (chave ?? "").trim();
  if (segredo === "") return null;
  return createHmac("sha256", `${DOMINIO_DO_HASH_DE_CPF}${segredo}`).update(normalizeCpf(raw)).digest("hex");
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
 * É o único caminho de cifra do CPF: a RPC `encrypt_cpf` nunca existiu no schema e
 * foi retirada do código (a captação, a API de contatos e a importação usam esta).
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

/**
 * The CPF columns for an insert/patch row — BOTH or NEITHER (#2522).
 *
 * `contacts_cpf_consistency` is `(cpf_encrypted IS NULL) = (cpf_hash IS NULL)`:
 * writing `cpf_hash` while encryption is unavailable made the database refuse
 * the WHOLE row (CSV import, POST /api/v1/contacts and edit alike). Saving the
 * contact without the CPF is the degradation documented in the issue; losing
 * CPF search for that one row is the price, losing the row never was.
 *
 * Returns `{}` when the CPF cannot be encrypted, so spreading the result into
 * the row touches nothing.
 */
export async function camposCpfParaGravar(
  _supabase: SupabaseClient,
  raw: string,
): Promise<{ cpf_hash?: string; cpf_encrypted?: string }> {
  // Hiperbold: o hash é o HMAC com a chave do servidor e a cifra é a da
  // instalação (`fn_encrypt_oauth`, só `service_role` — por isso o admin, e não
  // o cliente de quem chama). Sem um dos dois, nenhum: a linha grava sem CPF.
  const hash = hashCpf(raw);
  if (!hash) return {};
  const enc = await cifrarCpfDaInstalacao(createAdminClient(), normalizeCpf(raw));
  if (!enc) return {};
  return { cpf_hash: hash, cpf_encrypted: enc };
}
