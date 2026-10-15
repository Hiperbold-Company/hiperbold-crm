"use server";

import { headers } from "next/headers";

import { enviarVerificacaoDeEmail } from "@/lib/auth/enviar-verificacao-email";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { compraPeloClienteDisponivel } from "@/lib/onboarding/precisa-pagar";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ReenviarVerificacaoResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "auth_required"
        /** Já confirmado (a faixa some no próximo carregamento). */
        | "ja_confirmado"
        /** Menos de 1 minuto desde o último envio. */
        | "muito_cedo"
        /** 5 envios nas últimas 24 horas. */
        | "limite_diario"
        | "send_failed";
    };

/**
 * "Reenviar" do e-mail de confirmação (faixa do CRM e página de link vencido).
 *
 * Só para quem está logado (`getUser()`, validado no servidor): o destinatário é SEMPRE o e-mail da própria
 * conta, nunca um endereço vindo da tela. Tetos: 1 por minuto e 5 por dia por usuária(o)
 * (`lib/auth/enviar-verificacao-email.ts`). O token novo troca o anterior.
 */
export async function reenviarVerificacaoEmail(): Promise<ReenviarVerificacaoResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "auth_required" };

  // A verificação de e-mail do CRM só existe com a compra pelo cliente ligada (caminho "paga primeiro"):
  // instalação própria não abre pedido de verificação nem manda o e-mail.
  if (!(await compraPeloClienteDisponivel(createAdminClient()))) return { ok: false, error: "send_failed" };

  const hdrs = await headers();
  const r = await enviarVerificacaoDeEmail({
    userId: user.id,
    via: "reenvio",
    idioma: normalizarIdioma((user.user_metadata?.locale as string | undefined) ?? null),
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  });
  if (r.ok) return { ok: true };
  switch (r.motivo) {
    case "ja_verificado":
      return { ok: false, error: "ja_confirmado" };
    case "muito_cedo":
      return { ok: false, error: "muito_cedo" };
    case "limite_diario":
      return { ok: false, error: "limite_diario" };
    default:
      return { ok: false, error: "send_failed" };
  }
}
