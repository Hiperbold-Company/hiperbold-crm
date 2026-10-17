import { NextResponse, type NextRequest } from "next/server";

import { audit, hashEmail } from "@/lib/audit";
import { authRateLimited } from "@/lib/auth/rate-limit";
import { consumirToken, lerToken } from "@/lib/auth/verificacao-email";
import { env } from "@/lib/env";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { respostaDePonte } from "@/lib/auth/ponte-de-volta";
import { marcaDaSaida } from "@/lib/branding/saida";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Tentativas por IP e hora. Link de e-mail legítimo é aberto 1 ou 2 vezes; o teto barra quem chuta tokens. */
const LIMITE_POR_IP = { ip: 30, windowSec: 3600 } as const;
// Por CONTA: o token é `<user_id>.<segredo>` e o user_id se lê antes de qualquer conferência, então
// quem varia o IP (o teto acima é por origem) ainda pode tentar segredos contra UMA conta. Balde próprio,
// com o teto por IP folgado para não contar a mesma tentativa duas vezes.
const LIMITE_POR_CONTA = { ip: 1000, id: 30, windowSec: 3600 } as const;

/**
 * GET /auth/verificar-email?token=<user_id>.<segredo> — abre o link do e-mail "Confirme seu e-mail".
 *
 * Pública (ver `lib/auth/public-paths.ts`): quem clica pode estar deslogado ou noutro navegador. A
 * identidade vem do segredo de uso único, conferido por hash em tempo constante
 * (`lib/auth/verificacao-email.ts`); a sessão não entra. Sempre redireciona para a página de desfecho
 * (`/auth/verificar-email/resultado?s=ok|invalido|expirado|limite`), que nunca vê o token. O desfecho de
 * "inválido" é o mesmo para token errado, já usado, trocado por um reenvio ou de conta sem pedido.
 *
 * ─── Só carimba com a SESSÃO DA PRÓPRIA CONTA neste navegador (D-204) ───────────────────────────────────────────
 *
 * O link prova que alguém leu o e-mail, não que essa pessoa é quem criou a conta com a senha. Com a confirmação
 * automática do provedor ligada, quem cadastrou o e-mail alheio entrou na conta e a vítima, sem a senha, só tem o
 * link: carimbar por ele deixaria a conta na mão do atacante "verificada" e apagaria a faixa que avisa o dono. Sem
 * sessão da MESMA conta, o link não é consumido (continua valendo): a pessoa é mandada ao login com o aviso, e quem
 * não tem a senha segue por "Esqueci minha senha", que retoma a conta (`lib/auth/reassumir-conta.ts`).
 *
 * O cookie de sessão é `SameSite=Strict` e não viaja na navegação que vem do cliente de e-mail (issue #1646): a
 * primeira passada sem sessão volta por uma PONTE same-origin (`p=1`), e só a segunda, já com o cookie, decide.
 */
export async function GET(request: NextRequest) {
  // Sempre a URL configurada, nunca o Host da requisição (mesmo motivo de /auth/confirm).
  const para = (s: string) => {
    const r = NextResponse.redirect(new URL(`/auth/verificar-email/resultado?s=${s}`, env.NEXT_PUBLIC_APP_URL));
    r.headers.set("Cache-Control", "no-store");
    return r;
  };

  if (await authRateLimited("verificar_email", null, LIMITE_POR_IP)) return para("limite");

  const token = request.nextUrl.searchParams.get("token");
  const lido = lerToken(token);
  if (lido && (await authRateLimited("verificar_email_conta", lido.userId, LIMITE_POR_CONTA))) {
    return para("limite");
  }
  const requestId = request.headers.get("x-request-id");

  // Sessão da própria conta? `getUser()` valida o JWT no provedor. Token mal formado nem chega aqui com `lido`.
  if (lido) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || user.id.toLowerCase() !== lido.userId) {
      if (!user && request.nextUrl.searchParams.get("p") !== "1") {
        const marca = await marcaDaSaida(null);
        // `lido` já foi validado (UUID + 43 caracteres base64url): nada de fora entra no destino.
        return respostaDePonte(
          `/auth/verificar-email?token=${encodeURIComponent(token ?? "")}&p=1`,
          marca.nome,
          "Confirmando seu e-mail…",
        );
      }
      const r = NextResponse.redirect(new URL("/login?error=verificar_email_entre", env.NEXT_PUBLIC_APP_URL));
      r.headers.set("Cache-Control", "no-store");
      return r;
    }
  }

  const consumo = await consumirToken({ admin: createAdminClient(), token });

  if (!consumo.ok) {
    return para(consumo.motivo === "expirado" ? "expirado" : "invalido");
  }

  const hdrs = request.headers;
  await audit({
    action: "auth.email_verified",
    actorUserId: consumo.userId,
    metadata: {
      // O endereço nunca vai em claro; o hash só liga a linha à de "enviado".
      email_hash: consumo.email ? hashEmail(consumo.email) : null,
    },
    requestId,
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent"),
  });
  return para("ok");
}
