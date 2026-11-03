/**
 * GET /api/v1/channels/meta-social/conectar?plataforma=instagram|messenger
 *
 * Começa o OAuth: confere papel (administrador ou gerente, desde 03/11/2026), a verificação em duas etapas e o
 * limite do plano, emite o `state` assinado e o cookie de vínculo, e manda o
 * navegador ao consentimento da Meta. Todo desfecho é REDIRECT para a tela de
 * conexões (`aba=sociais&meta_social=erro&motivo=<código>`), nunca JSON: quem
 * chega aqui é um clique num link.
 *
 * O limite do plano é conferido ANTES de sair para a Meta: voltar de lá para
 * ouvir "seu plano não comporta" é a pior hora de saber. A exceção é a
 * RECONEXÃO — a organização que já tem conta desta rede pode estar só
 * renovando a dela, que não ocupa vaga nova; o callback e o gatilho do banco
 * recusam a conta NOVA que estourar o limite.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { podeCriar } from "@/lib/billing/planos/pode-criar";
import { configMetaSocial } from "@/lib/channels/meta-social/config";
import {
  CAMINHO_DO_CALLBACK_META_SOCIAL,
  PLATAFORMAS_META_SOCIAL,
  caminhoDoCallback,
} from "@/lib/channels/meta-social/constantes";
import {
  NOME_DO_VINCULO_META_SOCIAL,
  VALIDADE_DO_VINCULO_S,
  assinarVinculoMetaSocial,
  emitirEstadoMetaSocial,
} from "@/lib/channels/meta-social/estado";
import type { MotivoDaVolta } from "@/lib/channels/meta-social/motivos";
import { urlDeConsentimento } from "@/lib/channels/meta-social/oauth";
import { temContaDaPlataforma } from "@/lib/channels/meta-social/store";
import { destinoDaVolta, redirectUriDe } from "@/lib/channels/meta-social/volta";
import { env } from "@/lib/env";
import { authenticatedSessionId, requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export const dynamic = "force-dynamic";

const consulta = z.object({ plataforma: z.enum(PLATAFORMAS_META_SOCIAL) });

const erro = (motivo: MotivoDaVolta) =>
  NextResponse.redirect(destinoDaVolta({ meta_social: "erro", motivo }));

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const support = await requireSupportWrite();
  if (support) return support;
  const auth = await requireRole("manager", { requestId, resource: "social_connections" });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return erro("mfa_required");

  const lido = consulta.safeParse({ plataforma: req.nextUrl.searchParams.get("plataforma") });
  if (!lido.success) return erro("plataforma_invalida");
  const { plataforma } = lido.data;

  const cfg = await configMetaSocial();
  const app = plataforma === "instagram" ? cfg.instagram : cfg.messenger;
  if (!app) return erro("nao_configurado");

  const admin = createAdminClient();
  if (!(await temContaDaPlataforma(admin, auth.org.orgId, plataforma))) {
    const plano = await podeCriar(admin, auth.org.orgId, "conexoes");
    if (!plano.pode) return erro("limite_do_plano");
  }

  const nonce = randomBytes(16).toString("hex");
  let state: string;
  try {
    state = emitirEstadoMetaSocial(
      {
        plataforma,
        organizationId: auth.org.orgId,
        userId: auth.user.id,
        authSessionId: await authenticatedSessionId(),
      },
      { segredo: env.INTERNAL_SECRET, agora: new Date(), nonce },
    );
  } catch {
    return erro("segredo_indisponivel");
  }

  await audit({
    action: "channel.meta_social_connect_started",
    organizationId: auth.org.orgId,
    actorUserId: auth.user.id,
    resourceType: "channel_session",
    requestId,
    metadata: { plataforma },
  });

  const resposta = NextResponse.redirect(
    urlDeConsentimento(plataforma, app, redirectUriDe(caminhoDoCallback(plataforma)), state),
  );
  resposta.headers.set("X-Request-Id", requestId);
  resposta.cookies.set(NOME_DO_VINCULO_META_SOCIAL, assinarVinculoMetaSocial(nonce, env.INTERNAL_SECRET), {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK_META_SOCIAL,
    maxAge: VALIDADE_DO_VINCULO_S,
  });
  return resposta;
}
