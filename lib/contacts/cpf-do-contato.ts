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

/** Contatos por consulta ao ler os cifrados de uma exportação (o `in` vai na URL do PostgREST). */
const BLOCO_DE_CPFS = 100;
/** Decifragens em voo ao mesmo tempo: uma exportação de milhares não abre milhares de chamadas. */
const DECIFRAGENS_EM_PARALELO = 10;

/**
 * Os CPFs em claro (só dígitos) de vários contatos da organização, para a EXPORTAÇÃO — o mesmo caminho de
 * `decifrarCpfDoContato` (cliente de serviço + `fn_decrypt_oauth`), em lote: lê os cifrados em blocos e decifra
 * com paralelismo limitado. Contato sem CPF, anonimizado ou cujo cifrado o banco não abre fica FORA do mapa (a
 * coluna sai vazia; um CPF que não abre não derruba o arquivo).
 *
 * Como em `decifrarCpfDoContato`, aqui não há decisão de acesso: quem chama confere o papel antes e audita.
 */
export async function cpfsDecifradosDosContatos(
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const saida = new Map<string, string>();
  if (ids.length === 0) return saida;
  const admin = createAdminClient();
  const cifrados: Array<{ id: string; cifrado: string }> = [];
  for (let i = 0; i < ids.length; i += BLOCO_DE_CPFS) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, cpf_encrypted")
      .eq("organization_id", organizationId)
      .eq("is_anonymized", false)
      .in("id", ids.slice(i, i + BLOCO_DE_CPFS))
      .not("cpf_encrypted", "is", null);
    if (error) continue;
    for (const linha of (data ?? []) as Array<{ id: string; cpf_encrypted: string | null }>) {
      if (linha.cpf_encrypted) cifrados.push({ id: linha.id, cifrado: linha.cpf_encrypted });
    }
  }
  for (let i = 0; i < cifrados.length; i += DECIFRAGENS_EM_PARALELO) {
    await Promise.all(
      cifrados.slice(i, i + DECIFRAGENS_EM_PARALELO).map(async ({ id, cifrado }) => {
        const normalizado = cifrado.startsWith("\\x") ? cifrado : `\\x${cifrado}`;
        const dec = await admin.rpc("fn_decrypt_oauth", { ciphertext: normalizado });
        if (!dec.error && typeof dec.data === "string" && dec.data !== "") saida.set(id, dec.data);
      }),
    );
  }
  return saida;
}
