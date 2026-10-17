/**
 * Tudo o que toca `contacts.cpf_hash` e `contacts.cpf_encrypted` a partir de um pedido de usuário (D-216).
 *
 * As duas colunas NÃO são legíveis nem graváveis pelos papéis `authenticated`/`anon` (migration 0967): o hash é
 * chave de busca interna e o cifrado só abre no servidor. Então o cliente com a sessão do usuário nunca as nomeia.
 * Quem precisa saber "este contato tem CPF?", achar contato pelo hash ou gravar o CPF passa por aqui, com o cliente
 * de serviço e `organization_id` EXPLÍCITO em toda consulta — a organização vem da sessão/token já resolvidos pelo
 * chamador, nunca do corpo.
 *
 * A autorização continua onde estava: a leitura/escrita das outras colunas passa pelo cliente do usuário (RLS). Estas
 * funções só rodam depois dela, sobre um contato que a RLS já mostrou ao usuário.
 */
import { cifrarCpfDaInstalacao, normalizeCpf } from "@/lib/contacts/cpf";
import { createAdminClient } from "@/lib/supabase/admin";

export interface ErroDeCpf {
  code: string | null;
  message: string;
}

/** Quais destes contatos (da organização) têm CPF gravado. Consulta única; não devolve o hash. */
export async function idsComCpf(
  organizationId: string,
  ids: string[],
): Promise<{ ids: Set<string>; error: ErroDeCpf | null }> {
  if (ids.length === 0) return { ids: new Set(), error: null };
  const { data, error } = await createAdminClient()
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .in("id", ids)
    .not("cpf_hash", "is", null);
  if (error) return { ids: new Set(), error: { code: error.code ?? null, message: error.message } };
  return { ids: new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id)), error: null };
}

/** Contatos da organização cujo `cpf_hash` é este (o índice único admite no máximo um ativo, mas não confiamos nisso). */
export async function idsPorHashDeCpf(
  organizationId: string,
  hash: string,
): Promise<{ ids: string[]; error: ErroDeCpf | null }> {
  const { data, error } = await createAdminClient()
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("cpf_hash", hash)
    .limit(5);
  if (error) return { ids: [], error: { code: error.code ?? null, message: error.message } };
  return { ids: ((data ?? []) as Array<{ id: string }>).map((r) => r.id), error: null };
}

/**
 * Cifra o CPF com a chave da instalação (`fn_encrypt_oauth`, só `service_role`), no servidor. `null` quando o banco
 * não consegue cifrar (chave mestra ausente): quem chama NÃO grava o CPF nesse caso, nem só o hash, porque a
 * constraint `contacts_cpf_consistency` exige `cpf_hash` e `cpf_encrypted` juntos ou nenhum.
 */
export async function cifrarCpfDoContato(cpf: string): Promise<string | null> {
  return cifrarCpfDaInstalacao(createAdminClient(), normalizeCpf(cpf));
}

/** Código do `ErroDeCpf` quando nenhuma linha foi gravada: contato inexistente, de outra organização ou anonimizado. */
export const CPF_SEM_LINHA = "cpf_contato_nao_gravavel";

/**
 * Grava o par `cpf_hash` + `cpf_encrypted` num contato. Devolve o erro do banco (ex.: 23505 do índice
 * `uniq_contacts_org_cpf` quando outro contato da organização já tem o CPF) ou `null`.
 *
 * Só grava em contato NÃO anonimizado: a anonimização (LGPD) é irreversível e limpa o CPF, e um CPF novo não pode
 * reaparecer num contato anonimizado por corrida entre o PATCH e o pedido de anonimização. Se nenhuma linha foi
 * alterada, devolve `CPF_SEM_LINHA` (o chamador responde 409), em vez de dar o CPF por gravado.
 *
 * Os dois vão juntos porque a constraint `contacts_cpf_consistency` exige `cpf_hash` e `cpf_encrypted` ou nenhum dos dois.
 */
export async function gravarCpfDoContatoPorUsuario(
  organizationId: string,
  contactId: string,
  cpf: { hash: string; cifrado: string },
): Promise<ErroDeCpf | null> {
  const { data, error } = await createAdminClient()
    .from("contacts")
    .update({ cpf_hash: cpf.hash, cpf_encrypted: cpf.cifrado })
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .eq("is_anonymized", false)
    .select("id");
  if (error) return { code: error.code ?? null, message: error.message };
  if (!data || data.length === 0) {
    return { code: CPF_SEM_LINHA, message: "contato não encontrado ou anonimizado: o CPF não foi gravado" };
  }
  return null;
}

/**
 * O CPF em claro (só dígitos) de um contato, decifrado no servidor com `fn_decrypt_oauth` (só `service_role`).
 * `null` quando o contato não tem CPF, está anonimizado ou o banco não consegue decifrar (chave ausente/trocada).
 * Quem chama decide ANTES se o ator pode abrir o CPF (papel mínimo) e audita; aqui não há decisão de acesso.
 */
export async function decifrarCpfDoContato(organizationId: string, contactId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("contacts")
    .select("cpf_encrypted")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .eq("is_anonymized", false)
    .maybeSingle();
  const cifrado = (data as { cpf_encrypted?: string | null } | null)?.cpf_encrypted;
  if (error || !cifrado) return null;
  const normalizado = cifrado.startsWith("\\x") ? cifrado : `\\x${cifrado}`;
  const dec = await admin.rpc("fn_decrypt_oauth", { ciphertext: normalizado });
  if (dec.error || typeof dec.data !== "string" || dec.data === "") return null;
  return dec.data;
}
