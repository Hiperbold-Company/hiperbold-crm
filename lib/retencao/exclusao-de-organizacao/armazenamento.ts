/**
 * Apaga do Storage os arquivos de UMA organização (migration 0959). O Storage não se apaga por SQL (a linha
 * em `storage.objects` some e o arquivo fica no disco), então o servidor faz pela API, ANTES de o banco apagar
 * a organização: depois dela ninguém sabe mais de quem era cada pasta.
 *
 * Todo bucket do produto guarda os arquivos sob `<organization_id>/...`. A varredura lista os buckets que
 * existem e entra SÓ na pasta cujo nome é exatamente o id da organização: nunca um prefixo parcial, nunca outra
 * organização. Falha em listar ou remover devolve `ok: false` e quem chama NÃO exclui a organização nessa
 * rodada (arquivo órfão depois da exclusão não teria mais dono para ser achado); a próxima rodada tenta de novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Se a listagem dos buckets falhar, estes são os que o produto cria (migrations 0014, 0017, 0055, 0155, 0390, 0441). */
export const BUCKETS_CONHECIDOS = [
  "whatsapp-media",
  "ai-policy",
  "lgpd-exports",
  "skill-assets",
  "brand-logos",
  "catalog-photos",
  "org-sounds",
] as const;

const PAGINA = 100;
const LIMITE_DE_PASSOS = 10_000;

export type ResultadoDoArmazenamento = { ok: true; apagados: number } | { ok: false; apagados: number; motivo: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Entrada {
  name: string;
  id: string | null;
}

/** Os caminhos de arquivo (não de pasta) sob `prefixo`, recursivamente. Lança quando a API recusa. */
async function arquivosSob(admin: SupabaseClient, bucket: string, prefixo: string): Promise<string[]> {
  const achados: string[] = [];
  const pastas: string[] = [prefixo];
  let passos = 0;
  while (pastas.length > 0) {
    const pasta = pastas.pop() as string;
    for (let offset = 0; ; offset += PAGINA) {
      if (++passos > LIMITE_DE_PASSOS) throw new Error("storage_varredura_longa_demais");
      const { data, error } = await admin.storage.from(bucket).list(pasta, { limit: PAGINA, offset });
      if (error) throw new Error(`storage_listar:${error.message}`);
      const entradas = (data ?? []) as Entrada[];
      for (const e of entradas) {
        // Pasta vem sem `id`; arquivo vem com.
        if (e.id === null || e.id === undefined) pastas.push(`${pasta}/${e.name}`);
        else achados.push(`${pasta}/${e.name}`);
      }
      if (entradas.length < PAGINA) break;
    }
  }
  return achados;
}

export async function apagarArquivosDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ResultadoDoArmazenamento> {
  // Defesa: o prefixo TEM de ser um uuid inteiro. Vazio ou parcial varreria o bucket de todo mundo.
  if (!UUID.test(organizationId)) return { ok: false, apagados: 0, motivo: "organizacao_invalida" };

  let apagados = 0;
  try {
    let buckets: string[] = [...BUCKETS_CONHECIDOS];
    const listados = await admin.storage.listBuckets();
    if (!listados.error && Array.isArray(listados.data)) {
      buckets = Array.from(new Set([...buckets, ...listados.data.map((b: { id: string }) => b.id)]));
    }
    for (const bucket of buckets) {
      const caminhos = await arquivosSob(admin, bucket, organizationId);
      for (let i = 0; i < caminhos.length; i += PAGINA) {
        const lote = caminhos.slice(i, i + PAGINA);
        // Cinto e suspensório: nada fora da pasta da própria organização entra no `remove`.
        if (!lote.every((c) => c.startsWith(`${organizationId}/`))) {
          return { ok: false, apagados, motivo: "caminho_fora_da_organizacao" };
        }
        const { error } = await admin.storage.from(bucket).remove(lote);
        if (error) return { ok: false, apagados, motivo: `storage_remover:${bucket}` };
        apagados += lote.length;
      }
    }
    return { ok: true, apagados };
  } catch (erro) {
    return { ok: false, apagados, motivo: erro instanceof Error ? erro.message.slice(0, 120) : "erro" };
  }
}
