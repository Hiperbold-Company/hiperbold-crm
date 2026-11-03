/**
 * POST /api/v1/meta/exclusao-de-dados — callback de exclusão de dados da Meta
 * (Instagram e Messenger). Público no proxy: quem chama é a Meta, sem sessão.
 *
 * Autenticação = o `signed_request` (HMAC-SHA256 com o App Secret do app da
 * Meta desta instalação, emitido há menos de 24h). O pedido é gravado em `meta_data_deletion_requests` (um aberto por
 * rede e pessoa: a reentrega devolve o mesmo código, sem trilha nova) e
 * CUMPRIDO na hora: as conexões autorizadas por essa pessoa são arquivadas
 * (`lib/channels/meta-social/exclusao.ts`). A resposta é o formato que a Meta
 * exige: `{ url, confirmation_code }`, com a URL pública de status
 * (`/exclusao-de-dados?codigo=<c>`, página da tela).
 *
 * Se o cumprimento falhar (banco), o pedido fica aberto e a resposta ainda
 * leva o código: a Meta já o tem, e a reentrega dela cumpre depois.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { configMetaSocial } from "@/lib/channels/meta-social/config";
import type { PlataformaMetaSocial } from "@/lib/channels/meta-social/constantes";
import {
  executarPedidoDeExclusao,
  lerSignedRequest,
  registrarPedidoDeExclusao,
  type PedidoRegistrado,
} from "@/lib/channels/meta-social/exclusao";
import { env } from "@/lib/env";
import { lerCorpoDaRequisicao } from "@/lib/http/corpo-com-limite";
import { ipDoClienteParaInet } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
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
  // Um app só (o da Meta) desde o login unificado do Instagram (0988): o pedido
  // é gravado como `messenger` (a coluna só aceita as duas redes) e cumprido
  // nas DUAS redes (`executarPedidoDeExclusao`).
  const candidatos: { plataforma: PlataformaMetaSocial; segredo: string }[] = cfg.messenger
    ? [{ plataforma: "messenger", segredo: cfg.messenger.appSecret }]
    : [];
  const pedido = lerSignedRequest(lido.data.signed_request, candidatos.map((c) => c.segredo));
  if (!pedido) return fail("unauthorized", "invalid_signature", 401, { requestId });
  const plataforma = candidatos[pedido.segredo]!.plataforma;

  const admin = createAdminClient();
  let pedidoRegistrado: PedidoRegistrado;
  try {
    pedidoRegistrado = await registrarPedidoDeExclusao(admin, {
      plataforma,
      userId: pedido.userId,
      emitidoEm: pedido.emitidoEm,
    });
  } catch {
    return fail("internal_error", "Não foi possível registrar o pedido.", 500, { requestId });
  }
  const codigo = pedidoRegistrado.codigo;
  if (pedidoRegistrado.novo) {
    await audit({
      action: "meta.data_deletion_requested",
      resourceType: "meta_data_deletion_request",
      resourceId: pedidoRegistrado.id,
      requestId,
      metadata: { plataforma, confirmation_code: codigo },
    });
  }

  if (!pedidoRegistrado.concluido) {
    try {
      const r = await executarPedidoDeExclusao(
        admin,
        { id: pedidoRegistrado.id, plataforma, userId: pedido.userId },
        { requestId },
      );
      await audit({
        action: "meta.data_deletion_executed",
        resourceType: "meta_data_deletion_request",
        resourceId: pedidoRegistrado.id,
        requestId,
        metadata: { plataforma, confirmation_code: codigo, conexoes_arquivadas: r.arquivadas.length },
      });
    } catch (err) {
      logger.error("[meta.exclusao] pedido registrado e não cumprido; a reentrega tenta de novo", {
        request_id: requestId,
        detalhe: err instanceof Error ? err.message.slice(0, 200) : "erro",
      });
    }
  }

  const base = new URL(env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").origin;
  const resposta = NextResponse.json(
    { url: `${base}/exclusao-de-dados?codigo=${codigo}`, confirmation_code: codigo },
    { status: 200 },
  );
  resposta.headers.set("X-Request-Id", requestId);
  return resposta;
}
