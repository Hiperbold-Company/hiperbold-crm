/**
 * GET /api/v1/channels/meta-social/posts?channel_session_id=<uuid>[&link=<url>]
 *
 * Os posts de uma conta do Instagram conectada, para escolher "em qual post"
 * uma automação de comentário vale.
 *  - sem `link`: `{ data: { posts: [{ media_id, permalink, legenda_curta, miniatura, tipo, publicado_em }] } }`
 *    (os 24 mais recentes);
 *  - com `link` (instagram.com/p|reel|reels|tv/<código>): `{ data: { media_id } }`.
 *
 * Gerente+ (a mesma régua de editar automações). A organização vem da sessão,
 * nunca do pedido: a conta é lida filtrada por ela, e conta de outra
 * organização responde 404 como se não existisse. Só leitura: não audita.
 * Cada pedido chama a Meta, então há um teto por organização.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { listarPostsRecentes, resolverPostPorLink } from "@/lib/channels/meta-social/posts";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Pedidos por organização por minuto (cada um é uma ou mais chamadas à Meta). */
const TETO_POR_MINUTO = 30;

const consulta = z.strictObject({
  channel_session_id: z.uuid(),
  link: z.string().trim().min(1).max(2048).optional(),
});

const ERROS: Record<string, { status: number; mensagem: string }> = {
  conta_indisponivel: { status: 404, mensagem: "Conta do Instagram não encontrada ou desconectada." },
  link_invalido: { status: 400, mensagem: "Cole o link de um post ou reel do Instagram (instagram.com/p/… ou /reel/…)." },
  post_nao_encontrado: { status: 404, mensagem: "Não achamos esse post entre os recentes desta conta." },
  meta_falhou: { status: 502, mensagem: "O Instagram não respondeu. Tente de novo em instantes." },
};

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "social_connections" });
  if (!auth.ok) return auth.response;

  const lido = consulta.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!lido.success) return fail("validation_error", "Conta ou link inválido.", 400, { requestId, headers });

  const limite = await checkRateLimit(`meta-social-posts:${auth.org.orgId}`, TETO_POR_MINUTO, 60);
  if (!limite.allowed)
    return fail("rate_limited", "Aguarde um minuto antes de tentar novamente.", 429, {
      requestId,
      headers: { ...headers, "Retry-After": "60" },
    });

  const admin = createAdminClient();
  const base = { organizationId: auth.org.orgId, channelSessionId: lido.data.channel_session_id };
  try {
    const r = lido.data.link
      ? await resolverPostPorLink(admin, { ...base, link: lido.data.link })
      : await listarPostsRecentes(admin, base);
    if ("erro" in r) {
      const e = ERROS[r.erro]!;
      return fail(r.erro, e.mensagem, e.status, { requestId, headers });
    }
    return ok(r, { requestId, headers });
  } catch {
    return fail("internal_error", "Não foi possível ler os posts da conta.", 500, { requestId, headers });
  }
}
