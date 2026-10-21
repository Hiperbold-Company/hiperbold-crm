import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/contacts/export — baixa contatos em CSV (UTF-8 com BOM, vírgula).
 *
 * Corpo, um dos dois:
 *   { ids: [uuid, …] }       a seleção da tela
 *   { filtro: {…}, esperado?: N }   "todos do filtro", resolvido no servidor pela MESMA régua da lista;
 *                            com `esperado`, se o conjunto mudou desde que a pessoa viu → 409
 *
 * Por que POST e não GET: a seleção pode ter milhares de ids, que não cabem numa URL. A
 * guarda de suporte (`requireSupportWrite`) vale mesmo assim: um acompanhamento
 * administrativo somente-leitura não leva a base de contatos para fora.
 *
 * Papel: `manager` ou acima, só por sessão de navegador (a rota não está em `public-paths`: Bearer
 * é barrado no proxy). Não havia exportação de contatos antes desta; o piso é o de quem já
 * exporta a auditoria (`audit/export`). Teto de chamadas por usuário (rate limit).
 *
 * O arquivo nunca leva CPF (nem cifrado): as colunas de CPF não são lidas. Contato
 * anonimizado (LGPD) não sai. Teto de 20.000 linhas, com mensagem clara. Audit
 * `contacts.exported` com a contagem e o resumo do filtro — sem dado pessoal.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ApiError } from "@/lib/api/types";
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { exigirPermissao } from "@/lib/permissoes/servidor";
import { resolverAlvoDeLote } from "@/lib/contacts/alvo-de-lote";
import { montarCsvDeContatos, type ContatoParaCsv } from "@/lib/contacts/exportar-csv";
import { resumoDoFiltroParaAuditoria } from "@/lib/contacts/filtros";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  contactsExportSchema,
  TETO_DA_EXPORTACAO,
  validateRequest,
} from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, name, display_name, email, phone_number, tags, source, created_at, last_activity_at, custom_fields, leads:crm_leads!crm_leads_contact_id_fkey(pipeline_id, stage_id)";
const BLOCO_DE_IDS = 100;
/** Chamadas por usuário por janela: cada uma leva dado pessoal de até 20.000 contatos para fora. */
const CHAMADAS_POR_JANELA = 6;
const JANELA_EM_SEGUNDOS = 60;
const LEITURAS_EM_PARALELO = 5;

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await exigirPermissao("contatos.exportar", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const organizationId = authz.org.orgId;
  const timezone = authz.org.timezone ?? null;

  const limite = await checkRateLimit(`contacts:export:${authz.user.id}`, CHAMADAS_POR_JANELA, JANELA_EM_SEGUNDOS);
  if (!limite.allowed) {
    return fail("rate_limited", t("Muitas exportações em pouco tempo. Tente de novo em instantes."), 429, {
      requestId,
      headers: { "Retry-After": String(JANELA_EM_SEGUNDOS) },
    });
  }

  let corpo;
  try {
    corpo = await validateRequest(contactsExportSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();
  const ctx = { organizationId, requestId, timezone };

  try {
    // Os dois modos passam pela MESMA resolução do lote: o filtro vira ids no servidor (com o teto e
    // a conferência de `esperado`) e só então se lê cada contato. Anonimizado e lápide ficam de fora.
    const alvo = await resolverAlvoDeLote(supabase, corpo, ctx, TETO_DA_EXPORTACAO, t);
    if (!alvo.ok) return fail(alvo.code, alvo.message, alvo.status, { requestId });

    const fatias: string[][] = [];
    for (let i = 0; i < alvo.ids.length; i += BLOCO_DE_IDS) fatias.push(alvo.ids.slice(i, i + BLOCO_DE_IDS));
    const contatos: Array<ContatoParaCsv & { id: string }> = [];
    for (let i = 0; i < fatias.length; i += LEITURAS_EM_PARALELO) {
      const lidas = await Promise.all(
        fatias.slice(i, i + LEITURAS_EM_PARALELO).map(async (fatia) => {
          const { data, error } = await supabase
            .from("contacts")
            .select(COLUNAS)
            .eq("organization_id", organizationId)
            .is("is_merged_into", null)
            .eq("is_anonymized", false)
            .in("id", fatia);
          if (error) throw new ApiError(500, "internal_error", undefined, requestId, error.message);
          return (data ?? []) as unknown as Array<ContatoParaCsv & { id: string }>;
        }),
      );
      for (const l of lidas) contatos.push(...l);
    }

    if (contatos.length === 0) {
      return fail("not_found", t("Nenhum contato para exportar."), 404, { requestId });
    }

    const [funis, etapas] = await Promise.all([
      supabase.from("crm_pipelines").select("id, name, settings").eq("organization_id", organizationId),
      supabase.from("crm_stages").select("id, name").eq("organization_id", organizationId),
    ]);
    if (funis.error || etapas.error) {
      throw new ApiError(500, "internal_error", undefined, requestId, (funis.error ?? etapas.error)!.message);
    }
    const rotulosDeCampo = new Map<string, string>();
    for (const f of funis.data ?? []) {
      const declarados = (f.settings as { fields?: Array<{ key?: unknown; label?: unknown }> } | null)?.fields;
      for (const c of declarados ?? []) {
        if (typeof c.key === "string" && typeof c.label === "string" && !rotulosDeCampo.has(c.key)) {
          rotulosDeCampo.set(c.key, c.label);
        }
      }
    }

    const csv = montarCsvDeContatos(contatos, {
      timezone,
      funis: new Map((funis.data ?? []).map((f) => [f.id as string, f.name as string])),
      etapas: new Map((etapas.data ?? []).map((e) => [e.id as string, e.name as string])),
      rotulosDeCampo,
    });

    await audit({
      action: "contacts.exported",
      actorUserId: authz.user.id,
      organizationId,
      resourceType: "contact",
      requestId,
      metadata: {
        modo: alvo.modo,
        linhas: contatos.length,
        ...("filtro" in corpo ? { filtro: resumoDoFiltroParaAuditoria(corpo.filtro) } : { pedidos: corpo.ids.length }),
      },
    });

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        // Dado pessoal da organização: nunca em cache de navegador ou de proxy.
        "Cache-Control": "no-store, private",
        "Content-Disposition": `attachment; filename="contatos-${new Date().toISOString().slice(0, 10)}.csv"`,
        "X-Request-Id": requestId,
        "X-Contatos-Exportados": String(contatos.length),
      },
    });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }
}
