import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/webhook-sources — lista as entradas automáticas de contatos da org ativa.
 * POST /api/v1/webhook-sources — cria uma (gera path_token no server).
 *
 * `path_token` NÃO é segredo forte (é a identidade pública da URL, como o
 * webhook_path_token do WAHA) — diferente de api_tokens, ele volta no corpo de
 * GET/POST para a UI montar a URL de captação.
 *
 * `secret` é write-only na leitura: GET devolve só `has_secret` (padrão
 * api-tokens — o plaintext aparece apenas na resposta do POST/PATCH que o
 * definiu).
 *
 * ⚠️ A REGRA VIVE EM `lib/operacao/entradas-automaticas.ts`, compartilhada com o
 * agente de IA (BRIEFING §3, Decisão 4). Aqui só há transporte e a cifragem do
 * segredo, que depende do admin client e por isso fica na borda.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { ok, fail } from "@/lib/api/wrappers";
import { autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import {
  criarEntradaAutomatica,
  listarEntradasAutomaticas,
  type DepsDaOperacao,
} from "@/lib/operacao/entradas-automaticas";
import { createWebhookSourceSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // Sessão OU token (`role:manager`+, `mcp:read`) — a org do token vem da linha dele.
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "webhook_sources",
    role: "manager",
    escrita: false,
  });
  if (!authz.ok) return authz.response;

  try {
    const entradas = await listarEntradasAutomaticas({
      supabase: authz.supabase,
      // D-128: o token não é legível pela sessão; o servidor o lê depois de conferido o papel (manager).
      leitorDeTokens: createAdminClient(),
      organizationId: authz.organizationId,
      actor: authz.actor,
      requestId,
    });
    return ok(entradas, { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "webhook_sources",
    role: "manager",
    escrita: true,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createWebhookSourceSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // Secret nunca é armazenado em claro (migration 0041): cifra via admin RPC
  // (grant service_role). Sem a chave de cifra configurada, recusa em vez de
  // degradar pra plaintext.
  let secretEncrypted: string | null = null;
  if (parsed.data.secret) {
    secretEncrypted = await encryptWebhookSecret(createAdminClient(), parsed.data.secret);
    if (secretEncrypted === null) {
      return fail(
        "encryption_unavailable",
        t("Não foi possível guardar o segredo com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave. Enquanto isso, você pode criar a fonte sem segredo."),
        422,
        { requestId },
      );
    }
  }

  const deps: DepsDaOperacao = {
    supabase: authz.supabase,
    leitorDeTokens: createAdminClient(),
    organizationId: authz.organizationId,
    actor: authz.actor,
    requestId,
  };

  try {
    const criada = await criarEntradaAutomatica(deps, {
      name: parsed.data.name,
      default_pipeline_id: parsed.data.default_pipeline_id,
      default_stage_id: parsed.data.default_stage_id,
      redirect_to: parsed.data.redirect_to ?? null,
      field_map: parsed.data.field_map,
      secret_encrypted: secretEncrypted,
    });
    return ok(criada, { requestId, status: 201 });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
