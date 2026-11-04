/**
 * /team/accept-invite/[token] — public route (added to PUBLIC_PATHS).
 *
 * Behavior matrix:
 *  - Invalid/expired token         → render error
 *  - Unauthenticated user          → render CTA → /login?next=...
 *  - Authenticated, email mismatch → render mismatch + sign-out CTA
 *  - Authenticated, email match, verificação de e-mail do CRM em aberto
 *                                  → pede para confirmar o e-mail antes (D-204),
 *                                    salvo link do e-mail do convite (`?v=` válido)
 *  - Authenticated, email match    → form posts to Server Action which inserts
 *                                    membership and redirects to /app/inbox
 */
import Link from "next/link";

import { provaDoEmailConfere, verifyInviteToken } from "@/lib/auth/invite-token";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { AcceptInviteForm } from "./AcceptInviteForm";
import { ReenviarVerificacaoNoConvite } from "./ReenviarVerificacaoNoConvite";
import { emailVerificado } from "@/lib/auth/verificacao-email";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import type { Idioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { rotuloDoPapel } from "@/lib/auth/types";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ v?: string | string[] }>;
}

export default async function AcceptInvitePage({ params, searchParams }: PageProps) {
  const { token } = await params;
  const { v } = await searchParams;
  const vBruto = typeof v === "string" ? v : null;

  // Rota pública, fora da árvore de `app/app/layout.tsx` — sem o `IdiomaProvider` de lá,
  // então resolve o idioma direto, como `admin/forbidden/page.tsx`. Buscado
  // ANTES do teto de tentativas e da validação do token porque toda ramificação
  // abaixo (inclusive as de erro) precisa do mesmo idioma — quem ainda não tem
  // conta cai no ramo sem `user` e usa o `Accept-Language` do navegador antes
  // do padrão (`idiomaDoVisitante`).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = await idiomaDoVisitante(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);

  // O gargalo de enumeração é AQUI, não no aceite: a rota é pública e cada
  // GET testa um token. Sem teto, varrer o espaço de tokens sai de graça
  // (issue #64). Barrar antes de verificar mantém a resposta indistinguível
  // entre token válido e inválido para quem está varrendo.
  if (await authRateLimited("invite_accept", null, AUTH_LIMITS.invite_accept)) {
    return (
      <Shell idioma={idioma}>
        <h1 className="text-xl font-semibold">{t("Muitas tentativas")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Aguarde alguns minutos e abra o link do convite de novo.")}
        </p>
      </Shell>
    );
  }

  const payload = verifyInviteToken(token);

  if (!payload) {
    return (
      <Shell idioma={idioma}>
        <h1 className="text-xl font-semibold">{t("Convite inválido ou expirado")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            "Este link não é válido ou já passou da janela de 24h. Peça um novo convite ao admin do tenant.",
          )}
        </p>
      </Shell>
    );
  }

  // `v` é a prova de que o link veio pela caixa de entrada do convidado (o e-mail do convite o leva, o `accept_url` da
  // tela do admin não). Só segue adiante quando confere com ESTE convite; o servidor confere de novo no aceite.
  const prova = provaDoEmailConfere(payload, vBruto) ? vBruto : null;

  if (!user) {
    const next = encodeURIComponent(`/team/accept-invite/${token}${prova ? `?v=${prova}` : ""}`);
    return (
      <Shell idioma={idioma}>
        <h1 className="text-xl font-semibold">{t("Você foi convidado")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Use o e-mail")} <strong>{payload.email}</strong>{" "}
          {t(
            "para entrar na equipe que convidou você. Se ainda não tem conta, crie a sua. Se já tem, entre com ela.",
          )}
        </p>
        <div className="mt-4 flex flex-col items-stretch gap-3">
          {/*
            Criar conta é o caminho de quem ainda não tem conta.
            As duas saídas levam o token: sem ele,
            a conta nova caía no provisionamento comum e ganhava uma empresa
            própria em vez de entrar nesta equipe.
          */}
          <Link
            href={`/signup?invite=${encodeURIComponent(token)}${prova ? `&v=${encodeURIComponent(prova)}` : ""}`}
            className="inline-block rounded-md bg-primary px-4 py-2 text-center text-sm font-medium text-primary-foreground"
          >
            {t("Criar minha conta")}
          </Link>
          <Link
            href={`/login?next=${next}`}
            className="text-center text-sm underline underline-offset-4"
          >
            {t("Já tenho conta? Entrar")}
          </Link>
        </div>
      </Shell>
    );
  }

  const userEmail = (user.email ?? "").trim().toLowerCase();
  if (userEmail !== payload.email.trim().toLowerCase()) {
    return (
      <Shell idioma={idioma}>
        <h1 className="text-xl font-semibold">{t("Email não corresponde")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Você está logado como")} <strong>{user.email}</strong>,{" "}
          {t("mas o convite foi enviado para")} <strong>{payload.email}</strong>.{" "}
          {t("Saia e faça login com o email correto.")}
        </p>
        <form action="/api/auth/signout" method="post" className="mt-4">
          <button
            type="submit"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            {t("Sair")}
          </button>
        </form>
      </Shell>
    );
  }

  // D-204: o link do convite não prova a posse do e-mail (quem convida o vê e ele pode ser reencaminhado). Conta com a
  // verificação do CRM em aberto confirma o endereço primeiro; o mesmo link serve depois. A exceção é o link que
  // chegou POR E-MAIL (com `v` válido): ele é a prova, e o aceite carimba o endereço.
  if (!emailVerificado(user.app_metadata) && !prova) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">{t("Confirme seu e-mail para aceitar o convite")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Enviamos um link de confirmação para")} <strong>{user.email}</strong>.{" "}
          {t("Abra o link do e-mail e depois volte a este convite para ativar seu acesso.")}
        </p>
        <ReenviarVerificacaoNoConvite
          label={t("Reenviar e-mail de confirmação")}
          pendingLabel={t("Enviando...")}
          okLabel={t("Link reenviado. Confira sua caixa de entrada.")}
          erroLabel={t("Não foi possível reenviar agora. Tente de novo em instantes.")}
        />
      </Shell>
    );
  }

  return (
    <Shell idioma={idioma}>
      <h1 className="text-xl font-semibold">{t("Aceitar convite")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("Você foi convidado para entrar como")} <strong>{t(rotuloDoPapel(payload.role))}</strong>.{" "}
        {t("Confirme abaixo para ativar seu acesso.")}
      </p>
      <AcceptInviteForm token={token} prova={prova} label={t("Aceitar convite")} pendingLabel={t("Confirmando…")} failureLabel={t("Não foi possível aceitar este convite. Ele pode ter vencido ou seu acesso foi revogado. Peça um novo link ao administrador.")} planLimitLabel={t("A empresa que te convidou atingiu o limite de pessoas do plano. Avise quem te convidou.")} />
    </Shell>
  );
}

// Toda ramificação passa por aqui, então é aqui que o idioma chega ao
// `IdiomaProvider` — o único que acerta o `lang` do documento (ver
// `admin/forbidden/page.tsx`). Sem ele, o convite em espanhol saía com
// `lang="pt-BR"`, na primeira tela que o convidado vê.
function Shell({ idioma, children }: { idioma: Idioma; children: React.ReactNode }) {
  return (
    <IdiomaProvider locale={idioma}>
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-md rounded-lg border bg-card p-8 shadow-sm">{children}</div>
      </div>
    </IdiomaProvider>
  );
}
