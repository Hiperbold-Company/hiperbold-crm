import { recusaSeEmailNaoVerificado } from "@/lib/auth/exigir-email-verificado";
import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/settings/api-tokens — list tokens for the active org (no plaintext).
 * POST /api/v1/settings/api-tokens — create token. Plaintext returned UMA VEZ.
 *
 * Token format: `dsk_<8-hex-prefix>_<32-byte-random-base64url>`.
 * Stored as: prefix + sha256(plaintext) bytea — no reversible storage.
 *
 * ## Quem escreve em `api_tokens` (migration 0962)
 *
 * SÓ o servidor. `authenticated` e `anon` não têm privilégio nenhum na tabela:
 * antes, o admin de plataforma `support_readonly` e o admin de tenant em sessão
 * aal1 inseriam, direto pelo PostgREST, um token `role:admin` + `mcp:write` sem
 * passar por este gate. Agora a escrita e a leitura passam por aqui, com o
 * cliente de serviço DEPOIS de `requireRole("admin")` (que recusa sessão aal1 de
 * quem tem fator, 403 `mfa_required`), e por isso cada consulta filtra
 * `organization_id` na mão: a organização é a da sessão, `created_by` é quem
 * está na sessão, e nenhum dos dois vem do corpo.
 *
 * Teto de papel: a chave nunca declara um `role:` acima do papel ATUAL de quem
 * a cria na organização (o autenticador, `lib/mcp/auth.ts`, já recusa a chave
 * cujo criador não alcança o papel; aqui ela nem nasce).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail, falhaInterna } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { papelAcimaDoCriador } from "@/lib/auth/teto-de-papel-da-chave";
import { createApiTokenSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const SELECT_COLS =
  "id, name, prefix, scopes, last_used_at, expires_at, revoked_at, created_at";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "api_tokens" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const { data, error } = await createAdminClient()
    .from("api_tokens")
    .select(SELECT_COLS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });
  if (error) return falhaInterna("internal_error", error, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "api_tokens" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  // D-204: com o e-mail da conta ainda por confirmar, a chave sobreviveria à retomada da conta pela dona real.
  const naoVerificado = await recusaSeEmailNaoVerificado({
    userId: authUser.id,
    frase: t("Confirme seu e-mail para criar chaves de API."),
    requestId,
  });
  if (naoVerificado) return naoVerificado;

  let input;
  try {
    input = await validateRequest(createApiTokenSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const acima = papelAcimaDoCriador(input.scopes, activeOrg.role);
  if (acima) {
    return fail(
      "forbidden_role",
      t("Uma chave não pode ter um papel acima do seu na organização."),
      403,
      { requestId, details: { role: acima } },
    );
  }

  const prefix = `dsk_${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${prefix}_${secret}`;
  const tokenHash = createHash("sha256").update(plaintext).digest();

  const expiresAt = input.expires_in_days
    ? new Date(Date.now() + input.expires_in_days * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const { data: created, error: insErr } = await createAdminClient()
    .from("api_tokens")
    .insert({
      organization_id: activeOrg.orgId,
      created_by: authUser.id,
      name: input.name,
      prefix,
      // bytea: pass as `\x<hex>` literal so PostgREST encodes correctly.
      token_hash: `\\x${tokenHash.toString("hex")}`,
      scopes: input.scopes,
      expires_at: expiresAt,
    })
    .select(SELECT_COLS)
    .single();

  if (insErr) {
    // O teto de tokens ATIVOS por organização é do BANCO (migration 0415): quem
    // conta é o gatilho `trg_teto_de_tokens_ativos`, e a mensagem — com o limite
    // e o caminho para liberar espaço (revogar um token) — vem de lá, porque é
    // ele quem sabe o número. Sem este ramo a pessoa veria "internal_error" no
    // lugar da instrução que o erro já traz, e o toast da tela propagaria o 500.
    if (insErr.code === "PT409") {
      return fail("api_token_teto_atingido", insErr.message, 409, { requestId });
    }
    return falhaInterna("internal_error", insErr, { requestId });
  }

  await audit({
    action: "token.created",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "api_token",
    resourceId: created.id,
    requestId,
    metadata: { name: input.name, prefix, scopes: input.scopes, expires_at: expiresAt },
  });

  return ok(
    {
      ...created,
      plaintext,
      _warning: t("Salve este token agora — ele não será mostrado novamente."),
    },
    { status: 201, requestId },
  );
}
