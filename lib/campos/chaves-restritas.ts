/**
 * As chaves dos campos NÃO PÚBLICOS de uma organização, para o recorte de
 * `lib/campos/recorte-por-papel.ts`. São DUAS fontes, unidas:
 *  - `custom_field_definitions.publico = false` (migration 1015);
 *  - os itens `publico: false` de `settings.fields` de TODOS os funis da organização (arquivados
 *    inclusive) — a organização que ainda não adotou as definições marca o campo só no funil, e
 *    sem esta metade o valor dela saía para todo mundo.
 *
 * Filtra `organization_id` explicitamente: o cliente pode ser o de service role. A falha de leitura
 * (de QUALQUER uma das duas fontes) VOLTA declarada (`ok: false`), e quem chama decide — a tela
 * responde 500 em vez de entregar o valor ao papel errado; a automação e o follow-up tiram todos os
 * campos personalizados do texto.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { chavesRestritasDosCampos } from "@/lib/campos/recorte-por-papel";
import { logger } from "@/lib/logger";

export type ChavesRestritas = { ok: true; chaves: Set<string> } | { ok: false };

type Erro = { code?: string; message: string };

/** Junta as duas fontes já lidas. */
function unir(definicoes: unknown[] | null, funis: unknown[] | null): Set<string> {
  const chaves = new Set<string>();
  for (const linha of (definicoes ?? []) as Array<{ key?: unknown }>) {
    if (typeof linha?.key === "string") chaves.add(linha.key.toLowerCase());
  }
  for (const funil of (funis ?? []) as Array<{ settings?: unknown; fields?: unknown }>) {
    const fields =
      funil && "fields" in funil ? funil.fields : (funil?.settings as { fields?: unknown } | null | undefined)?.fields;
    for (const k of chavesRestritasDosCampos(fields)) chaves.add(k);
  }
  return chaves;
}

function avisar(organizationId: string, requestId: string | undefined, error: Erro): void {
  logger.warn("[campos] não li as chaves restritas da organização", {
    organizationId,
    requestId,
    code: error.code,
    erro: error.message,
  });
}

export async function chavesRestritasDaOrganizacao(
  supabase: SupabaseClient,
  organizationId: string,
  requestId?: string,
): Promise<ChavesRestritas> {
  let definicoes: unknown[] | null = null;
  let funis: unknown[] | null = null;
  let error: Erro | null = null;
  try {
    const [d, f] = await Promise.all([
      supabase.from("custom_field_definitions").select("key").eq("organization_id", organizationId).eq("publico", false),
      supabase.from("crm_pipelines").select("settings").eq("organization_id", organizationId),
    ]);
    if (d.error) error = d.error;
    else if (f.error) error = f.error;
    definicoes = d.data as unknown[] | null;
    funis = f.data as unknown[] | null;
  } catch (e) {
    // Cliente sem a tabela ou fora do ar: a mesma falha declarada, nunca um throw no caminho do leitor.
    error = { message: e instanceof Error ? e.message : String(e) };
  }
  if (error) {
    avisar(organizationId, requestId, error);
    return { ok: false };
  }
  return { ok: true, chaves: unir(definicoes, funis) };
}

/** O MESMO, por `pg` puro (worker do follow-up, turno local). */
export async function chavesRestritasDaOrganizacaoPg(
  pool: Pick<pg.Pool, "query">,
  organizationId: string,
  requestId?: string,
): Promise<ChavesRestritas> {
  try {
    const [d, f] = await Promise.all([
      pool.query<{ key: string }>(
        `select key from custom_field_definitions where organization_id = $1 and publico = false`,
        [organizationId],
      ),
      pool.query<{ fields: unknown }>(
        `select settings->'fields' as fields from crm_pipelines where organization_id = $1`,
        [organizationId],
      ),
    ]);
    return { ok: true, chaves: unir(d.rows, f.rows) };
  } catch (e) {
    avisar(organizationId, requestId, { message: e instanceof Error ? e.message : String(e) });
    return { ok: false };
  }
}
