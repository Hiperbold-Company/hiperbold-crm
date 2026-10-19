/**
 * GET /api/v1/contacts/filter-options — o que os filtros avançados da tela de
 * Contatos oferecem: funis com suas etapas e os campos personalizados filtráveis.
 *
 * Existe porque `GET /api/v1/pipelines` exige `manager` e a tela de Contatos abre
 * para qualquer papel. Aqui basta `viewer`, e a RLS decide o que ele enxerga.
 *
 * Campos: os DECLARADOS nos funis (`crm_pipelines.settings.fields`, com rótulo) mais
 * as chaves que aparecem nos dados (uma amostra dos contatos e dos negócios mais
 * recentes), porque a importação grava `utm_source`, `cargo` etc. sem declarar. A
 * chave precisa casar com `CHAVE_DE_CAMPO_FILTRAVEL`: ela vira caminho JSON na
 * consulta. Chave que lembra CPF nunca é oferecida.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { chaveSensivelDeCampo } from "@/lib/contacts/campos-sensiveis";
import { CHAVE_DE_CAMPO_FILTRAVEL } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const AMOSTRA = 300;

interface CampoOferecido {
  key: string;
  label: string;
}

function chavesDe(linhas: Array<{ custom_fields: Record<string, unknown> | null }> | null): Set<string> {
  const chaves = new Set<string>();
  for (const l of linhas ?? []) {
    for (const k of Object.keys(l.custom_fields ?? {})) chaves.add(k);
  }
  return chaves;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const supabase = await createClient();

  const [funis, etapas, contatos, negocios] = await Promise.all([
    supabase
      .from("crm_pipelines")
      .select("id, name, position, settings")
      .eq("organization_id", orgId)
      .eq("is_archived", false)
      .order("position", { ascending: true }),
    supabase
      .from("crm_stages")
      .select("id, pipeline_id, name, position")
      .eq("organization_id", orgId)
      .eq("is_archived", false)
      .order("position", { ascending: true }),
    supabase
      .from("contacts")
      .select("custom_fields")
      .eq("organization_id", orgId)
      .is("is_merged_into", null)
      .order("updated_at", { ascending: false })
      .limit(AMOSTRA),
    supabase
      .from("crm_leads")
      .select("custom_fields")
      .eq("organization_id", orgId)
      .order("updated_at", { ascending: false })
      .limit(AMOSTRA),
  ]);
  const erro = funis.error ?? etapas.error ?? contatos.error ?? negocios.error;
  if (erro) return fail("internal_error", "Não foi possível carregar as opções de filtro.", 500, { requestId });

  const rotulos = new Map<string, string>();
  for (const funil of funis.data ?? []) {
    const declarados = (funil.settings as { fields?: Array<{ key?: unknown; label?: unknown }> } | null)?.fields;
    for (const c of declarados ?? []) {
      if (typeof c.key === "string" && typeof c.label === "string" && !rotulos.has(c.key)) {
        rotulos.set(c.key, c.label);
      }
    }
  }

  const montar = (presentes: Set<string>): CampoOferecido[] => {
    const todas = new Set<string>([...rotulos.keys(), ...presentes]);
    return [...todas]
      .filter((k) => CHAVE_DE_CAMPO_FILTRAVEL.test(k) && !chaveSensivelDeCampo(k))
      .map((key) => ({ key, label: rotulos.get(key) ?? key }))
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  };

  return ok(
    {
      funis: (funis.data ?? []).map((f) => ({
        id: f.id as string,
        name: f.name as string,
        etapas: (etapas.data ?? [])
          .filter((e) => e.pipeline_id === f.id)
          .map((e) => ({ id: e.id as string, name: e.name as string })),
      })),
      campos: {
        contato: montar(chavesDe(contatos.data as never)),
        negocio: montar(chavesDe(negocios.data as never)),
      },
    },
    { requestId },
  );
}
