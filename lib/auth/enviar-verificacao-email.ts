/**
 * O envio do e-mail "Confirme seu e-mail" (verificação do CRM, ver `lib/auth/verificacao-email.ts`).
 *
 * Duas portas: o cadastro (`app/actions/auth/signUp.ts`, `via: "cadastro"`) e o "Reenviar" da faixa
 * (`app/actions/auth/reenviarVerificacaoEmail.ts`, `via: "reenvio"`, com os tetos de 1 por minuto e 5 por dia).
 *
 * Envio DIRETO pelo roteador (SMTP ou Resend), e não pela fila `billing_emails_enviados`: a fila exige
 * organização, e a conta ainda não tem uma no cadastro. A falha de envio nunca lança nem derruba o cadastro:
 * o pedido já está gravado e a faixa oferece "Reenviar". Endereço e token nunca vão para log nem auditoria
 * (só o hash do endereço, como o resto de `auth.*`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit, hashEmail } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { marcaDaSaida, type MarcaDeSaida } from "@/lib/branding/saida";
import { sendEmail } from "@/lib/email/roteador";
import { buildConfirmarEmailEmail } from "@/lib/email/templates/confirmar-email";
import { env } from "@/lib/env";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { emitirPedido, gravarPedido, VALIDADE_DO_LINK_EM_DIAS } from "./verificacao-email";

/** Os tetos do "Reenviar" (decisão do dono do produto, 15/10/2026). */
export const LIMITES_DO_REENVIO = {
  porMinuto: { max: 1, janelaSeg: 60 },
  porDia: { max: 5, janelaSeg: 86_400 },
} as const;

export type MotivoDaFalhaDoEnvio =
  | "ja_verificado"
  | "muito_cedo"
  | "limite_diario"
  | "usuario_nao_encontrado"
  | "gravacao_falhou"
  | "sem_endereco"
  | "email_nao_configurado"
  | "envio_falhou";

export type ResultadoDoEnvio = { ok: true } | { ok: false; motivo: MotivoDaFalhaDoEnvio };

export interface DepsDoEnvioDaVerificacao {
  admin: SupabaseClient;
  enviar: typeof sendEmail;
  marca: (organizationId: string | null) => Promise<MarcaDeSaida>;
  appUrl: string;
  agora?: () => Date;
  limitar: typeof checkRateLimit;
  auditar: typeof audit;
}

function depsReais(): DepsDoEnvioDaVerificacao {
  return {
    admin: createAdminClient(),
    enviar: sendEmail,
    marca: marcaDaSaida,
    appUrl: env.NEXT_PUBLIC_APP_URL.replace(/\/$/, ""),
    limitar: checkRateLimit,
    auditar: audit,
  };
}

export async function enviarVerificacaoDeEmail(
  p: {
    userId: string;
    via: "cadastro" | "reenvio";
    idioma?: Idioma;
    /** Outras chaves de `app_metadata` gravadas junto do pedido (o aceite dos Termos no cadastro). */
    junto?: Record<string, unknown>;
    requestId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
  deps: DepsDoEnvioDaVerificacao = depsReais(),
): Promise<ResultadoDoEnvio> {
  const agora = deps.agora?.() ?? new Date();

  // Os tetos só valem para o reenvio: o cadastro já tem o teto próprio por IP. Minuto primeiro: um pedido
  // barrado por estar cedo demais não gasta uma das cinco do dia.
  if (p.via === "reenvio") {
    const minuto = await deps.limitar(
      `auth:verificar_email:min:${p.userId}`,
      LIMITES_DO_REENVIO.porMinuto.max,
      LIMITES_DO_REENVIO.porMinuto.janelaSeg,
    );
    if (!minuto.allowed) return { ok: false, motivo: "muito_cedo" };
    const dia = await deps.limitar(
      `auth:verificar_email:dia:${p.userId}`,
      LIMITES_DO_REENVIO.porDia.max,
      LIMITES_DO_REENVIO.porDia.janelaSeg,
    );
    if (!dia.allowed) return { ok: false, motivo: "limite_diario" };
  }

  const pedido = await emitirPedido({
    admin: deps.admin,
    userId: p.userId,
    agora,
    junto: p.junto,
    // O mesmo "1 por minuto", agora durável: mora no pedido e vale mesmo se o contador do limitador reiniciar.
    ...(p.via === "reenvio"
      ? {
          intervaloMinimoMs: LIMITES_DO_REENVIO.porMinuto.janelaSeg * 1000,
          somenteSePendente: true,
          // O pedido novo só substitui o antigo depois de o e-mail sair (ver abaixo).
          semGravar: true,
        }
      : {}),
  });
  if (!pedido.ok) return { ok: false, motivo: pedido.motivo };
  if (!pedido.email) return { ok: false, motivo: "sem_endereco" };

  const marca = await deps.marca(null);
  const url = `${deps.appUrl}/auth/verificar-email?token=${encodeURIComponent(pedido.token)}`;
  const mensagem = buildConfirmarEmailEmail({
    marca,
    idioma: p.idioma ?? IDIOMA_PADRAO,
    empresa: marca.nome,
    url,
    dias: VALIDADE_DO_LINK_EM_DIAS,
  });

  const r = await deps.enviar({
    to: pedido.email,
    subject: mensagem.subject,
    html: mensagem.html,
    text: mensagem.text,
    tags: [{ name: "email", value: "confirmar-email" }],
  });
  if (!r.ok) {
    logger.warn("[verificar-email] envio falhou", { via: p.via, erro: r.error ?? "send_failed" });
    return { ok: false, motivo: r.error === "not_configured" ? "email_nao_configurado" : "envio_falhou" };
  }

  // Reenvio: o e-mail saiu, agora sim o hash novo toma o lugar do antigo. Se o envio tivesse falhado, o link
  // que a pessoa já tem na caixa continuaria valendo.
  if (p.via === "reenvio") {
    const gravado = await gravarPedido({
      admin: deps.admin,
      userId: p.userId,
      hash: pedido.hash,
      expiraEm: pedido.expiraEm,
      agora,
    });
    if (!gravado.ok) {
      logger.warn("[verificar-email] gravar o pedido depois do envio falhou", { motivo: gravado.motivo });
      return { ok: false, motivo: gravado.motivo };
    }
  }

  await deps.auditar({
    action: "auth.email_verification_sent",
    actorUserId: p.userId,
    metadata: { email_hash: hashEmail(pedido.email), via: p.via },
    requestId: p.requestId ?? null,
    ip: p.ip ?? null,
    userAgent: p.userAgent ?? null,
  });
  return { ok: true };
}
