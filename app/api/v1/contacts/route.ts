import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/contacts — list (handler em ./_handler.ts)
 * POST /api/v1/contacts — create (handler em ./_handler.ts)
 *
 * Thin wrapper: auth + Zod + ok/fail. Lógica em listContactsHandler/createContactHandler.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import type { Actor } from "@/lib/api/handlers/types";
import { autorizarAdministracao } from "@/lib/api/auth-dual-admin";
import { recusaDoPlanoSemApi } from "@/lib/api/plano-da-api";
import { requireRole } from "@/lib/auth/require-role";
import { extractBearer, validateBearerToken, ensureRole, ensureScope, McpAuthError } from "@/lib/mcp/auth";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import {
  contactCreateSchemaDoPais,
  contactListQuerySchema,
  validateRequest,
  type ContactCreate,
} from "@/lib/schemas";
import { perfilDaOrganizacao } from "@/lib/legal/perfil-do-pais";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { exigirVisibilidadeDoToken, tokenSemVisaoDeDonoNaOrganizacao } from "@/lib/mcp/visibilidade-do-token";
import type { Role } from "@/lib/auth/types";
import { recusaDoFiltroPorCampoRestrito } from "@/lib/campos/filtro-restrito";
import { temCamposPersonalizados } from "@/lib/campos/resposta-recortada";
import { chavesRestritasDaOrganizacao } from "@/lib/campos/chaves-restritas";
import { leitorVeCamposRestritos, recortarLinha, type LeitorDosCampos } from "@/lib/campos/recorte-por-papel";
import { campoDoFiltro, temFiltroDeData } from "@/lib/contacts/filtros";
import { fusoDaOrganizacao } from "@/lib/contacts/fuso-da-organizacao";
import { filtraPorNegocio } from "@/lib/contacts/consulta";

import { listContactsHandler, createContactHandler } from "./_handler";

export const dynamic = "force-dynamic";

/**
 * Resolução de identidade para GET /api/v1/contacts — dois modos, uma fonte
 * de verdade cada:
 *
 *  a) Sessão de navegador (cookie) → `requireRole("viewer", …)`, o MESMO gate
 *     usado no resto de `/api/v1/*` (rank efetivo do banco + MFA de sessão).
 *  b) `Authorization: Bearer dsk_…` → `validateBearerToken()` (`lib/mcp/auth.ts`),
 *     o autenticador de `api_tokens` que o MCP server já usa. `organization_id`
 *     vem da LINHA DO TOKEN no banco — nunca de query/body do cliente — então
 *     não existe caminho para um Bearer de uma org ler contatos de outra.
 *
 * Erro de token (ausente/inválido/revogado/expirado) fecha em 401; token válido
 * sem o scope `mcp:read` (ou role abaixo de `viewer`) fecha em 403. Nenhum dos
 * dois ramos loga o header ou o plaintext do token.
 *
 * ⚠️ NÃO BASTA implementar isto aqui: o `proxy.ts` global roda ANTES de
 * qualquer route handler e só reconhece cookie de sessão — sem uma entrada em
 * `lib/auth/public-paths.ts` para `/api/v1/contacts`, todo Bearer recebe 401
 * do proxy antes de chegar neste arquivo. Ver o comentário lá.
 */
type ContactsAuth =
  | {
      ok: true;
      organizationId: string;
      actor: Actor;
      supabase: SupabaseClient;
      idioma?: Idioma;
      /** Fuso da organização, quando a sessão já o trouxe (o Bearer o lê só se o filtro pedir). */
      timezone?: string | null;
      /** Chamada por token (cliente admin, sem a RLS): carrega o papel da chave para a regra D-148. */
      token?: { role: Role };
      /** 1015: quem vai ler os campos personalizados (o papel da sessão, o da chave, ou a IA). */
      leitor: LeitorDosCampos | null;
    }
  | { ok: false; response: Response };

async function resolveContactsAuth(req: NextRequest, requestId: string): Promise<ContactsAuth> {
  const authHeader = req.headers.get("authorization");

  if (extractBearer(authHeader)) {
    let auth;
    try {
      auth = await validateBearerToken(authHeader);
    } catch (err) {
      if (err instanceof McpAuthError) {
        return {
          ok: false,
          response: fail(
            err.codigo ?? (err.httpStatus === 401 ? "unauthenticated" : "forbidden"),
            err.message,
            err.httpStatus,
            { requestId },
          ),
        };
      }
      throw err;
    }

    try {
      ensureScope(auth.scopes, "mcp:read");
      ensureRole(auth.role, "viewer");
    } catch (err) {
      if (err instanceof McpAuthError) {
        return {
          ok: false,
          response: fail("forbidden_role", err.message, err.httpStatus, { requestId }),
        };
      }
      throw err;
    }

    // Plano sem API (D-227): a mesma trava de `resolveAuthDual`, depois de escopo e papel.
    const semApi = await recusaDoPlanoSemApi(auth.organizationId, requestId);
    if (semApi) return { ok: false, response: semApi };

    // organization_id vem do TOKEN (fonte confiável), nunca do cliente.
    return {
      ok: true,
      organizationId: auth.organizationId,
      actor: auth.actor,
      supabase: createAdminClient(),
      token: { role: auth.role },
      leitor: auth.actor.type === "ai_agent" ? "ia" : auth.role,
    };
  }

  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return { ok: false, response: authz.response };
  return {
    ok: true,
    organizationId: authz.org.orgId,
    actor: { type: "user", id: authz.user.id },
    supabase: await createClient(),
    idioma: authz.user.idioma,
    timezone: authz.org.timezone ?? null,
    leitor: authz.org.role,
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = await resolveContactsAuth(req, requestId);
  if (!auth.ok) return auth.response;
  const { organizationId, actor, supabase, idioma } = auth;
  const t = (texto: string) => traduzir(texto, idioma ?? "pt-BR");

  const url = new URL(req.url);
  // Os filtros têm os MESMOS nomes na URL da tela e aqui (`filtrosDeContatosSchema`).
  const entradas = Object.fromEntries([...url.searchParams.entries()].filter(([, v]) => v !== ""));
  // `getAll` (#1274): a etiqueta repetida na URL (`?tag=a&tag=b`) chega como lista; o
  // `fromEntries` acima guardaria só a última.
  const etiquetas = url.searchParams.getAll("tag").filter((v) => v !== "");
  const qsParsed = contactListQuerySchema.safeParse(
    etiquetas.length > 1 ? { ...entradas, tag: etiquetas } : entradas,
  );
  if (!qsParsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: qsParsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  // Funil, etapa e campo que olha o NEGÓCIO (escopos "negocio" e "qualquer") filtram por `crm_leads`, que tem dono por atendente. A sessão
  // passa pela RLS; o token roda com o cliente admin e, em empresa no modo "só os meus", uma chave
  // abaixo de gerente não pode usar o negócio como filtro (descobriria quem tem negócio de quem).
  // Mesma regra D-148 de `lib/api/auth-dual.ts`.
  // Os UTMs também saem de `crm_leads`: a mesma regra vale para quem os pede por token.
  //
  // Sem filtro de negócio a lista segue (contato não tem dono), mas a conversa anexada a cada
  // contato (id e prévia da última mensagem) TEM: nesse mesmo caso a chave recebe os contatos
  // sem o campo `conversa`, no formato de um contato que nunca conversou.
  let semConversa = false;
  if (auth.token) {
    try {
      if (filtraPorNegocio(qsParsed.data) || qsParsed.data.com_utm) {
        await exigirVisibilidadeDoToken(supabase, organizationId, auth.token.role);
      } else {
        semConversa = await tokenSemVisaoDeDonoNaOrganizacao(supabase, organizationId, auth.token.role);
      }
    } catch (err) {
      if (err instanceof McpAuthError) {
        return fail("forbidden_role", err.message, err.httpStatus, { requestId });
      }
      throw err;
    }
  }

  // 1015: filtro por campo não público é oráculo do valor — só administrador.
  const recusaDoCampo = await recusaDoFiltroPorCampoRestrito(
    supabase,
    organizationId,
    campoDoFiltro(qsParsed.data),
    auth.leitor,
    requestId,
  );
  if (recusaDoCampo) return recusaDoCampo;

  try {
    const timezone = temFiltroDeData(qsParsed.data)
      ? (auth.timezone ?? (await fusoDaOrganizacao(supabase, organizationId)))
      : null;
    const lista = await listContactsHandler(
      supabase,
      {
        organization_id: organizationId,
        actor,
        requestId,
        idioma,
      },
      qsParsed.data,
      undefined,
      { timezone },
    );
    const { cursor, has_more } = lista;
    const contacts = semConversa
      ? lista.contacts.map(({ conversa: _conversa, ...contato }) => contato)
      : lista.contacts;
    // 1015: a lista segue o MESMO recorte da ficha (`[id]`): campo não público só para administrador.
    if (!leitorVeCamposRestritos(auth.leitor) && contacts.some(temCamposPersonalizados)) {
      const restritas = await chavesRestritasDaOrganizacao(supabase, organizationId, requestId);
      if (!restritas.ok) return falhaInterna("internal_error", "chaves restritas ilegíveis", { requestId });
      return ok(
        contacts.map((c) => recortarLinha(c, restritas.chaves, auth.leitor)),
        { requestId, meta: { cursor, has_more } },
      );
    }
    return ok(contacts, { requestId, meta: { cursor, has_more } });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // spec 13 §4: escrita é agent+ (viewer é read-only). Sessão OU token (`role:agent`+, `mcp:write`).
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "contacts",
    role: "agent",
    escrita: true,
  });
  if (!authz.ok) return authz.response;
  const supabase = authz.supabase;
  const activeOrg = { orgId: authz.organizationId };

  // O documento do titular é validado pela régua do PAÍS da organização (issue
  // #1033): quem decide é a coluna `organizations.country`, nunca o corpo da
  // requisição — mesma doutrina da moeda em `lib/catalogo/moeda-da-org.ts`.
  const perfil = await perfilDaOrganizacao(supabase, activeOrg.orgId);

  let input;
  try {
    input = await validateRequest(contactCreateSchemaDoPais(perfil), req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const result = await createContactHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: authz.actor,
        requestId,
        idioma: authz.idioma,
      },
      input as ContactCreate,
    );
    return ok(result, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
