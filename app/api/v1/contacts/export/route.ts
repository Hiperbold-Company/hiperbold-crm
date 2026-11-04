import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/contacts/export — baixa contatos em CSV (UTF-8 com BOM, vírgula). Hiperbold: seleção e filtros
 *   da tela de Contatos (CBEXS).
 * GET  /api/v1/contacts/export?formato=csv|vcf — a base de contatos DE VOLTA, do upstream (issue #2759):
 *   backup, migração e portabilidade (LGPD art. 18, V). Documentação completa junto do `GET`, abaixo.
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
import {
  csvDosContatos,
  nomeDoArquivo,
  vcardsDosContatos,
  type ContatoParaExportar,
  type FormatoDeExport,
} from "@/lib/contacts/exportar";
import { montarCsvDeContatos, type ContatoParaCsv } from "@/lib/contacts/exportar-csv";
import { resumoDoFiltroParaAuditoria } from "@/lib/contacts/filtros";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import {
  contactListQuerySchema,
  contactsExportSchema,
  TETO_DA_EXPORTACAO,
  validateRequest,
} from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import type { Contact } from "@/lib/types/contacts";

import { listContactsHandler } from "../_handler";

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

/** A página da lista é esta: é o teto do `limit` do `contactListQuerySchema`. */
const TAMANHO_DA_PAGINA = 100;
/** Mesmo teto do export de auditoria — cabe na memória do processo que serve o CRM. */
const TETO_DO_EXPORT = 10_000;
const FORMATOS: readonly FormatoDeExport[] = ["csv", "vcf"];

/**
 * O CPF em claro de quem tem cifra, um por contato.
 *
 * A RPC `decrypt_cpf` (migration 0597) valida org + papel por dentro e audita
 * cada chamada; falha aqui degrada para coluna VAZIA, como o próprio get do
 * contato faz — CPF que não sai não pode derrubar o arquivo inteiro.
 */
async function decifraCpfs(
  supabase: Awaited<ReturnType<typeof createClient>>,
  contatos: readonly Contact[],
  destino: Map<string, string>,
): Promise<void> {
  for (const contato of contatos) {
    if (!contato.cpf_hash) continue;
    const { data, error } = await supabase.rpc("decrypt_cpf", { p_contact_id: contato.id });
    if (error) {
      logger.warn("[contacts.export] decrypt_cpf RPC indisponível", { detail: error.message });
      continue;
    }
    if (typeof data === "string" && data !== "") destino.set(contato.id, data);
  }
}

/**
 * GET /api/v1/contacts/export — a base de contatos DE VOLTA para quem opera
 * (issue #2759).
 *
 * A tela de Contatos só importava: `POST /api/v1/contacts/import` existia desde
 * o PR #313 e não tinha porta de saída, então backup, migração entre
 * instalações e pedido de portabilidade (LGPD art. 18, V; GDPR art. 20) se
 * atendiam com SSH + psql — o terminal que o produto existe para eliminar.
 * Excluir já era possível (fila de redação/anonimização de `target_kind=
 * 'contact'`), devolver os dados ao titular, não.
 *
 * ─── O fluxo é o do export que já existe ────────────────────────────────────
 *
 * Mesma forma de `app/api/v1/audit/export/route.ts`:
 *
 *   - papel ANTES de qualquer leitura (`requireRole`, aqui `manager` — ver
 *     abaixo), Zod na query, paginação em BLOCOS porque o PostgREST corta
 *     resposta em `max_rows` (a lição da #2561: `.limit(10_000)` devolvia
 *     1.000 linhas caladas e o arquivo saía pela metade);
 *   - `Content-Type` próprio + `Content-Disposition: attachment;
 *     filename="contatos-YYYY-MM-DD.csv|vcf"` — o mesmo envelope do export de
 *     auditoria, com o prefixo do recurso.
 *
 * Nem um formato a mais: CSV é o que a própria tela importa (`lib/contacts/
 * csv.ts`), vCard é o que o celular importa e o produto já lê (#2712).
 *
 * ─── Papel ──────────────────────────────────────────────────────────────────
 *
 * `manager`, o mesmo do export de auditoria: exportar a base inteira é
 * vazamento de base, não rotina de atendimento (`agent` importa porque
 * cadastro é rotina; levar a base embora não é). O `decrypt_cpf` também exige
 * `manager`, então as duas portas batem e ninguém toma 403 no meio do arquivo.
 *
 * ─── LGPD ───────────────────────────────────────────────────────────────────
 *
 * O audit registra QUEM, QUANDO e QUANTOS registros saíram — nunca o termo de
 * busca nem o conteúdo (mesma régua do export de conversa em PDF, #1982). O
 * CPF viaja só para quem tem papel, decifrado pela RPC que já audita cada
 * chamada própria.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // Hiperbold: a mesma permissão por perfil do POST (`contatos.exportar`), não só o papel.
  const authz = await exigirPermissao("contatos.exportar", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const url = new URL(req.url);
  // 422 em formato desconhecido, igual ao export de conversa: silenciar o
  // pedido errado aqui é como quem integra descobre que a URL mudou.
  const bruto = (url.searchParams.get("formato") ?? "csv").toLowerCase();
  if (!FORMATOS.includes(bruto as FormatoDeExport)) {
    return fail(
      "validation_failed",
      t("Formato não suportado: use ?formato=csv ou ?formato=vcf."),
      422,
      { requestId },
    );
  }
  const formato = bruto as FormatoDeExport;

  const filtros = contactListQuerySchema.safeParse({
    search: url.searchParams.get("search") ?? undefined,
    // `getAll` (#1274): a repetição na URL sóe viva por aqui, como na lista.
    tag: url.searchParams.getAll("tag"),
    modo: url.searchParams.get("modo") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    pessoais: url.searchParams.get("pessoais") ?? undefined,
    blocked: url.searchParams.get("blocked") ?? undefined,
    order_by: url.searchParams.get("order_by") ?? undefined,
    order_dir: url.searchParams.get("order_dir") ?? undefined,
    limit: String(TAMANHO_DA_PAGINA),
  });
  if (!filtros.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: filtros.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const supabase = await createClient();
  // O MESMO handler da tela: é ele que garante que exportar é exportar o que a
  // lista mostra — escopo da org ATIVA, `kind='person'`, lápide de fusão, piso
  // de busca, etiquetas em E/OU. Reescrever o WHERE aqui seria uma SEGUNDA
  // resposta para a mesma pergunta, pronta para divergir da primeira.
  const ctx = {
    organization_id: authz.org.orgId,
    actor: { type: "user" as const, id: authz.user.id },
    requestId,
    idioma: authz.user.idioma,
  };

  const lidos: Contact[] = [];
  const cpfs = new Map<string, string>();
  let cursor: string | undefined;
  let truncado = false;

  try {
    for (;;) {
      const { contacts, cursor: proximo, has_more } = await listContactsHandler(
        supabase,
        ctx,
        { ...filtros.data, cursor },
      );
      if (contacts.length === 0) break;
      lidos.push(...contacts);
      if (formato === "csv") await decifraCpfs(supabase, contacts, cpfs);
      if (lidos.length >= TETO_DO_EXPORT) {
        truncado = has_more || lidos.length > TETO_DO_EXPORT;
        break;
      }
      if (!has_more || !proximo) break;
      cursor = proximo;
    }
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }

  const contatos: ContatoParaExportar[] = lidos.slice(0, TETO_DO_EXPORT).map((c) => ({
    name: c.name,
    display_name: c.display_name,
    email: c.email,
    phone_number: c.phone_number,
    cpf: cpfs.get(c.id) ?? null,
    birthdate: c.birthdate,
    tags: c.tags,
  }));

  const corpo = formato === "csv" ? csvDosContatos(contatos) : vcardsDosContatos(contatos);

  await audit({
    action: "contacts.exported",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "contact",
    resourceId: null,
    requestId,
    metadata: {
      actor_type: "user",
      formato,
      total: contatos.length,
      truncado,
      // O FILTRO, nunca o TEXTO do filtro: termo de busca é dado de quem foi
      // buscado, e o audit de export existe para provar que saiu QUANTO, não
      // para guardar quem a pessoa estava procurando.
      filtros: {
        busca: filtros.data.search !== undefined,
        etiquetas: filtros.data.tag?.length ?? 0,
        origem: filtros.data.source ?? null,
        pessoais: filtros.data.pessoais,
      },
    },
  });

  return new Response(corpo, {
    status: 200,
    headers: {
      "Content-Type": formato === "csv" ? "text/csv; charset=utf-8" : "text/vcard; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nomeDoArquivo(formato)}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
      ...(truncado ? { "X-Export-Truncado": "true" } : {}),
    },
  });
}
