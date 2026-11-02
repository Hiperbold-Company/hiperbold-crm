/**
 * GET|POST /api/v1/webhooks/meta-social — webhook do Instagram e do Messenger
 * pela conexão oficial da Meta. UM endereço para a instalação inteira (é o que
 * se cadastra no painel do app), não por sessão.
 *
 * GET: handshake (`hub.challenge` em TEXTO PURO, com o verify token da
 * instalação — o mesmo do WhatsApp oficial, `appDaMeta()`).
 *
 * POST: limite de taxa e teto do corpo → assinatura ANTES de parsear (qualquer
 * segredo da instalação) → leitura → para cada evento, a sessão de
 * `(plataforma pelo object, entry.id)` entre as não arquivadas. É a LINHA DO
 * BANCO que diz a organização; conta desconhecida é ignorada com 200.
 *
 * 200 sempre que a assinatura confere: a Meta reentrega o que não recebe 2xx, e
 * recusar o que ignoramos viraria reentrega em backoff por horas.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { verificationChallenge } from "@/lib/channels/meta/webhook";
import { configMetaSocial } from "@/lib/channels/meta-social/config";
import { ingerirEventoMetaSocial, sessaoPelaConta, type SessaoMetaSocial } from "@/lib/channels/meta-social/ingest";
import {
  assinaturaMetaSocialConfere,
  envelopeMetaSocial,
  lerEventosMetaSocial,
} from "@/lib/channels/meta-social/webhook";
import { lerCorpoDaRequisicao } from "@/lib/http/corpo-com-limite";
import { ipDoClienteParaInet } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TETO_CORPO_BYTES = 1024 * 1024;
/** Por IP: a Meta entrega em rajadas, mas de poucos IPs; folga larga. */
const LIMITE_POR_IP_POR_MIN = 600;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { verifyToken } = await configMetaSocial();
  const challenge = verificationChallenge(req.nextUrl.searchParams, verifyToken ?? "");
  if (challenge === null) return new NextResponse("forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const ip = ipDoClienteParaInet(req.headers);
  if (ip) {
    const rl = await checkRateLimit(`meta_social_webhook_ip:${ip}`, LIMITE_POR_IP_POR_MIN, 60);
    if (!rl.allowed) {
      return fail("rate_limited", "Too many requests.", 429, { requestId, headers: { "Retry-After": "60" } });
    }
  }

  const corpo = await lerCorpoDaRequisicao(req, TETO_CORPO_BYTES);
  if (!corpo.ok) return fail("payload_too_large", "request body too large", 413, { requestId });

  const cfg = await configMetaSocial();
  if (!assinaturaMetaSocialConfere(corpo.texto, req.headers.get("x-hub-signature-256"), cfg.segredos)) {
    return fail("unauthorized", "invalid_signature", 401, { requestId });
  }

  let json: unknown;
  try {
    json = JSON.parse(corpo.texto);
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }
  const envelope = envelopeMetaSocial.safeParse(json);
  if (!envelope.success) {
    return fail("validation_failed", "payload fora do contrato do canal", 400, { requestId });
  }

  const eventos = lerEventosMetaSocial(envelope.data);
  const admin = createAdminClient();
  const sessoes = new Map<string, SessaoMetaSocial | null>();
  const desfechos: string[] = [];

  for (const e of eventos) {
    const chave = `${e.plataforma}:${e.contaId}`;
    try {
      if (!sessoes.has(chave)) sessoes.set(chave, await sessaoPelaConta(admin, e.plataforma, e.contaId));
      const sessao = sessoes.get(chave) ?? null;
      if (!sessao) {
        desfechos.push("ignored:conta_desconhecida");
        continue;
      }
      const r = await ingerirEventoMetaSocial(admin, sessao, e, { appIdsProprios: cfg.appIds });
      desfechos.push(r.reason ? `${r.status}:${r.reason}` : r.status);
    } catch (err) {
      desfechos.push("failed");
      logger.error("[meta-social.webhook] evento não ingerido", {
        request_id: requestId,
        plataforma: e.plataforma,
        detalhe: err instanceof Error ? err.message.slice(0, 200) : "erro",
      });
    }
  }

  const resposta = NextResponse.json({ received: eventos.length, outcomes: desfechos }, { status: 200 });
  resposta.headers.set("X-Request-Id", requestId);
  return resposta;
}
