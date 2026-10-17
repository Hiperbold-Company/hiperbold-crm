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
 * definiu). `generate_secret: true` no POST faz o servidor gerar o segredo HMAC e
 * devolvê-lo uma única vez (fora do recibo de `Idempotency-Key`). Girar depois:
 * `POST /api/v1/webhook-sources/[id]/rotate-secret`.
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
import { criarComChaveOpcional } from "@/lib/api/criacao-idempotente";
import {
  ASSINATURA_DA_ENTRADA,
  criarEntradaAutomatica,
  listarEntradasAutomaticas,
  novoSegredoDeEntrada,
  type DepsDaOperacao,
} from "@/lib/operacao/entradas-automaticas";
import { createWebhookSourceSchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

/** Tag do endpoint no recibo de idempotência. */
const ENDPOINT = "/api/v1/webhook-sources";

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
  // degradar pra plaintext. `generate_secret` pede ao SERVIDOR que gere o segredo:
  // o texto claro volta uma vez, na resposta da criação, e fica FORA do recibo de
  // idempotência (replay não o reentrega).
  const admin = createAdminClient();
  const cifrar = (texto: string) => encryptWebhookSecret(admin, texto);
  let secretEncrypted: string | null = null;
  let segredoGerado: string | null = null;
  try {
    if (parsed.data.generate_secret) {
      const novo = await novoSegredoDeEntrada(requestId, cifrar);
      secretEncrypted = novo.cifrado;
      segredoGerado = novo.claro;
    } else if (parsed.data.secret) {
      secretEncrypted = await cifrar(parsed.data.secret);
      if (secretEncrypted === null) {
        return fail(
          "encryption_unavailable",
          t("Não foi possível guardar o segredo com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave. Enquanto isso, você pode criar a fonte sem segredo."),
          422,
          { requestId },
        );
      }
    }
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }

  const deps: DepsDaOperacao = {
    supabase: authz.supabase,
    leitorDeTokens: admin,
    organizationId: authz.organizationId,
    actor: authz.actor,
    requestId,
  };

  // O recibo de idempotência é uma linha de banco que vive 24h: nem o segredo digitado nem o `path_token`
  // (a chave da URL de captação) moram nele. O segredo digitado entra no hash só como marcador; o
  // `path_token` sai do recibo e é recolocado na resposta ao vivo e, no replay, lido pelo servidor.
  const { secret: segredoDigitado, ...pedidoSemSegredo } = parsed.data;
  const corpoDoRecibo = segredoDigitado ? { ...pedidoSemSegredo, has_secret: true } : pedidoSemSegredo;
  let pathToken: string | null = null;

  try {
    const resposta = await criarComChaveOpcional(req, authz, {
      requestId,
      endpoint: ENDPOINT,
      // O segredo GERADO não faz parte do pedido (muda a cada tentativa): o pedido é `generate_secret: true`.
      corpo: corpoDoRecibo,
      t,
      executar: async () => {
        const { path_token, ...fonte } = await criarEntradaAutomatica(deps, {
          name: parsed.data.name,
          default_pipeline_id: parsed.data.default_pipeline_id,
          default_stage_id: parsed.data.default_stage_id,
          redirect_to: parsed.data.redirect_to ?? null,
          field_map: parsed.data.field_map,
          secret_encrypted: secretEncrypted,
        });
        pathToken = path_token;
        return fonte;
      },
      aoExecutar: (fonte) => ({
        ...fonte,
        path_token: pathToken,
        ...(segredoGerado === null
          ? {}
          : { secret: segredoGerado, secret_shown_once: true, signature: ASSINATURA_DA_ENTRADA }),
      }),
      aoReproduzir: async (fonte) => {
        const { data } = await admin
          .from("webhook_sources")
          .select("path_token")
          .eq("id", fonte.id)
          .eq("organization_id", authz.organizationId)
          .maybeSingle();
        return { ...fonte, path_token: (data as { path_token?: string } | null)?.path_token ?? null };
      },
    });
    // Resposta com segredo em claro nunca fica em cache de navegador, proxy ou CDN.
    if (segredoGerado !== null && resposta.ok) resposta.headers.set("Cache-Control", "no-store");
    return resposta;
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
