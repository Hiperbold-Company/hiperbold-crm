/**
 * Os mesmos fatos de `carregar-fatos.ts`, lidos por `pg` puro — o adaptador
 * dos invariantes (sem PostgREST) e do turno local. Filtra `organization_id`
 * em toda consulta, como a versão service-role.
 */
import type pg from "pg";

import { negocioDaExecucao, type FatosDaAutomacao, type NegocioDosFatos } from "./fatos";

function objeto(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export async function carregarFatosDaAutomacaoPg(
  pool: Pick<pg.Pool, "query">,
  orgId: string,
  contactId: string,
  vars: Record<string, unknown>,
): Promise<FatosDaAutomacao> {
  const { rows: contatos } = await pool.query(
    `select id, name, email, phone_number, birthdate::text as birthdate, tags, custom_fields
       from contacts where organization_id = $1 and id = $2`,
    [orgId, contactId],
  );
  const { rows: negocios } = await pool.query(
    `select id, title, pipeline_id, stage_id, status, value_cents, owner_user_id, source, tags,
            expected_close_date::text as expected_close_date, custom_fields
       from crm_leads where organization_id = $1 and contact_id = $2
      order by updated_at desc limit 200`,
    [orgId, contactId],
  );
  const lista: NegocioDosFatos[] = (negocios as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    title: String(r.title ?? ""),
    pipeline_id: String(r.pipeline_id),
    stage_id: String(r.stage_id),
    status: String(r.status),
    value_cents: r.value_cents === null || r.value_cents === undefined ? null : Number(r.value_cents),
    owner_user_id: (r.owner_user_id as string | null) ?? null,
    source: String(r.source ?? ""),
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    expected_close_date: (r.expected_close_date as string | null) ?? null,
    custom_fields: objeto(r.custom_fields),
  }));
  const id = negocioDaExecucao(vars);
  const c = (contatos as Array<Record<string, unknown>>)[0];
  return {
    contato: c
      ? {
          id: String(c.id),
          name: (c.name as string | null) ?? null,
          email: (c.email as string | null) ?? null,
          phone_number: (c.phone_number as string | null) ?? null,
          birthdate: (c.birthdate as string | null) ?? null,
          tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
          custom_fields: objeto(c.custom_fields),
        }
      : null,
    negocio: (id ? lista.find((n) => n.id === id) : undefined) ?? lista.find((n) => n.status === "open") ?? null,
    negocios: lista.map((n) => ({ id: n.id, pipeline_id: n.pipeline_id, stage_id: n.stage_id, status: n.status })),
    vars,
  };
}
