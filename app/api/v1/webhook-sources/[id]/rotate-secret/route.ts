import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/webhook-sources/[id]/rotate-secret — gira o segredo HMAC de uma entrada automática.
 *
 * O servidor gera outro segredo (256 bits), grava CIFRADO (`fn_encrypt_oauth`, como a criação e a
 * edição) e devolve o texto claro UMA vez, nesta resposta. Depois disso nenhuma leitura o mostra
 * (`GET` devolve só `has_secret`) e o audit registra o fato da troca, nunca o valor.
 *
 * ⚠️ O segredo antigo para de valer NA HORA: quem assina com ele (formulário, servidor do cliente)
 * passa a receber 401 `invalid_signature` até ser atualizado. É por isso que a resposta traz o
 * cabeçalho e o algoritmo da assinatura — o texto claro e o jeito de usá-lo vão juntos.
 *
 * Sessão OU token `dsk_…` (`role:manager`+ e `mcp:write`), o mesmo piso de editar a entrada. Entrada
 * de outra organização responde 404. Sem corpo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { autorizarAdministracao } from "@/lib/api/auth-dual-admin";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { ASSINATURA_DA_ENTRADA, girarSegredoDaEntrada, type DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
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

  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const admin = createAdminClient();
  const deps: DepsDaOperacao = {
    supabase: authz.supabase,
    leitorDeTokens: admin,
    organizationId: authz.organizationId,
    actor: authz.actor,
    requestId,
  };
  try {
    const { fonte, segredo } = await girarSegredoDaEntrada(deps, id, (texto) =>
      encryptWebhookSecret(admin, texto),
    );
    return ok(
      {
        ...fonte,
        secret: segredo,
        secret_shown_once: true,
        signature: ASSINATURA_DA_ENTRADA,
      },
      { requestId, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
