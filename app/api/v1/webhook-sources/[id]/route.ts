import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/webhook-sources/[id] — atualiza campos (inclui is_active — switch da UI).
 * DELETE /api/v1/webhook-sources/[id] — remove a fonte.
 *
 * Sessão OU token `dsk_…` (`role:manager`+ e `mcp:write`). A regra vive em
 * `lib/operacao/entradas-automaticas.ts`, compartilhada com a rota de criação e
 * com as tools MCP; aqui há transporte e a cifragem do segredo, que depende do
 * admin client e por isso fica na borda.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { ok, fail, falhaInterna, noContent } from "@/lib/api/wrappers";
import { respostaDeRecusa } from "@/lib/api/recusa";
import {
  atualizarEntradaAutomatica,
  excluirEntradaAutomatica,
  type DepsDaOperacao,
  type EdicaoDeEntradaAutomatica,
} from "@/lib/operacao/entradas-automaticas";
import { updateWebhookSourceSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { opcaoSemAssinatura } from "@/lib/webhooks/assinatura-autorizacao";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

/**
 * A frase de cada opção que exige assinatura (#2316).
 *
 * Literal e no arquivo, e não montada com `opcao`: a chave do dicionário de i18n
 * é o TEXTO em português. Uma frase interpolada existiria só neste ponto do
 * código e a varredura de tradução não a veria — a tela em espanhol mostraria
 * português, e `i18n-espanhol-cobre-a-tela` só acusaria se alguém compusesse a
 * string em JSX.
 */
const FRASE_DA_OPCAO_SEM_ASSINATURA = {
  ai: "Configure a assinatura da fonte antes de autorizar IA. Para remover a assinatura, desligue primeiro a autorização de IA.",
  update_lead:
    "Configure a assinatura da fonte antes de deixar a integração atualizar o card. Para remover a assinatura, desligue primeiro a atualização pelo external_id.",
  reuse_lead:
    "Configure a assinatura da fonte antes de reaproveitar o card aberto do contato. Para remover a assinatura, desligue primeiro o reaproveitamento do card aberto.",
} as const;

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "webhook_sources",
    role: "manager",
    escrita: true,
    permissao: "automacoes.gerenciar",
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = updateWebhookSourceSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // Conferência do upstream (#2316, #3101) antes da regra de `atualizarEntradaAutomatica`: vale para a
  // sessão e para o token `dsk_`. Lida pelo cliente da porta, presa à organização dela.
  const { data: existing, error: fetchErr } = await authz.supabase
    .from("webhook_sources")
    .select("id, authorize_ai_on_capture, update_existing_lead_on_capture, reuse_open_lead_on_capture, secret_encrypted")
    .eq("id", id)
    .eq("organization_id", authz.organizationId)
    .maybeSingle();
  if (fetchErr) return falhaInterna("internal_error", fetchErr, { requestId });
  if (!existing) return fail("not_found", t("Fonte não encontrada."), 404, { requestId });

  // As opções que dependem de prova de origem (#2316, #3101) recusam pelo mesmo
  // lugar — e cada uma com a própria frase: uma mensagem só para todas faria
  // quem ligou a atualização de card ler "autorizar IA" e procurar o problema
  // na tela errada.
  const opcaoQuePedeAssinatura = opcaoSemAssinatura(existing, parsed.data);
  if (opcaoQuePedeAssinatura) {
    return fail(
      "signature_required",
      t(FRASE_DA_OPCAO_SEM_ASSINATURA[opcaoQuePedeAssinatura]),
      422,
      { requestId },
    );
  }

  // secret plaintext do input vira secret_encrypted (migration 0041); a coluna
  // em claro não existe mais. `secret: null` remove o segredo da fonte.
  const { secret: patchedSecret, ...restPatch } = parsed.data;
  const edicao: EdicaoDeEntradaAutomatica = { ...restPatch };
  if (patchedSecret !== undefined) {
    if (patchedSecret === null) {
      edicao.secret_encrypted = null;
    } else {
      const enc = await encryptWebhookSecret(createAdminClient(), patchedSecret);
      if (enc === null) {
        return fail(
          "encryption_unavailable",
          t("Não foi possível guardar o segredo com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave."),
          422,
          { requestId },
        );
      }
      edicao.secret_encrypted = enc;
    }
  }

  const deps: DepsDaOperacao = {
    supabase: authz.supabase,
    // D-128: `path_token` não é legível pela sessão; o servidor o lê (o corpo de sucesso segue o mesmo).
    leitorDeTokens: createAdminClient(),
    organizationId: authz.organizationId,
    actor: authz.actor,
    requestId,
  };
  try {
    const atualizada = await atualizarEntradaAutomatica(deps, id, edicao);
    return ok(atualizada, { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "webhook_sources",
    role: "manager",
    escrita: true,
    permissao: "automacoes.gerenciar",
  });
  if (!authz.ok) return authz.response;

  const deps: DepsDaOperacao = {
    supabase: authz.supabase,
    leitorDeTokens: createAdminClient(),
    organizationId: authz.organizationId,
    actor: authz.actor,
    requestId,
  };
  try {
    await excluirEntradaAutomatica(deps, id);
    return noContent(requestId);
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
