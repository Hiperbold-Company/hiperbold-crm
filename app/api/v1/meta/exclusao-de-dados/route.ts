/**
 * POST /api/v1/meta/exclusao-de-dados — callback de exclusão de dados da Meta
 * (Instagram e Messenger). Público no proxy: quem chama é a Meta, sem sessão.
 *
 * Autenticação = o `signed_request` (HMAC-SHA256 com um segredo desta
 * instalação). Qual segredo conferiu diz de qual app veio. O pedido é gravado
 * em `meta_data_deletion_requests` e auditado; a resposta é o formato que a
 * Meta exige: `{ url, confirmation_code }`, com a URL pública de status
 * (`/exclusao-de-dados?codigo=<c>`, página da tela).
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { configMetaSocial } from "@/lib/channels/meta-social/config";
import type { PlataformaMetaSocial } from "@/lib/channels/meta-social/constantes";
import { lerSignedRequest, registrarPedidoDeExclusao } from "@/lib/channels/meta-social/exclusao";
import { env } from "@/lib/env";
import { lerCorpoDaRequisicao } from "@/lib/http/corpo-com-limite";
import { ipDoClienteParaInet } from "@/lib/http/ip-do-cliente";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const corpoSchema = z.object({ signed_request: z.string().min(10).max(4096) });

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const ip = ipDoClienteParaInet(req.headers) ?? "sem-ip";
  const rl = await checkRateLimit(`meta_exclusao_ip:${ip}`, 30, 60);
  if (!rl.allowed) return fail("rate_limited", "Too many requests.", 429, { requestId, headers: { "Retry-After": "60" } });

  const corpo = await lerCorpoDaRequisicao(req, 16 * 1024);
  if (!corpo.ok) return fail("payload_too_large", "request body too large", 413, { requestId });
  const tipo = req.headers.get("content-type") ?? "";
  let bruto: unknown;
  if (tipo.includes("application/json")) {
    try {
      bruto = JSON.parse(corpo.texto);
    } catch {
      bruto = null;
    }
  } else {
    bruto = Object.fromEntries(new URLSearchParams(corpo.texto));
  }
  const lido = corpoSchema.safeParse(bruto);
  if (!lido.success) return fail("validation_error", "signed_request ausente", 400, { requestId });

  const cfg = await configMetaSocial();
  const candidatos: { plataforma: PlataformaMetaSocial; segredo: string }[] = [
    ...(cfg.messenger ? [{ plataforma: "messenger" as const, segredo: cfg.messenger.appSecret }] : []),
    ...(cfg.instagram ? [{ plataforma: "instagram" as const, segredo: cfg.instagram.appSecret }] : []),
  ];
  const pedido = lerSignedRequest(lido.data.signed_request, candidatos.map((c) => c.segredo));
  if (!pedido) return fail("unauthorized", "invalid_signature", 401, { requestId });
  const plataforma = candidatos[pedido.segredo]!.plataforma;

  let codigo: string;
  try {
    codigo = await registrarPedidoDeExclusao(createAdminClient(), {
      plataforma,
      userId: pedido.userId,
      emitidoEm: pedido.emitidoEm,
    });
  } catch {
    return fail("internal_error", "Não foi possível registrar o pedido.", 500, { requestId });
  }
  await audit({
    action: "meta.data_deletion_requested",
    resourceType: "meta_data_deletion_request",
    requestId,
    metadata: { plataforma, confirmation_code: codigo },
  });

  const base = new URL(env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").origin;
  const resposta = NextResponse.json(
    { url: `${base}/exclusao-de-dados?codigo=${codigo}`, confirmation_code: codigo },
    { status: 200 },
  );
  resposta.headers.set("X-Request-Id", requestId);
  return resposta;
}
