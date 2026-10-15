import Link from "next/link";

import { ReenviarConfirmacaoBotao } from "@/components/auth/ReenviarConfirmacaoBotao";
import { Button } from "@/components/ui/button";
import { emailVerificado } from "@/lib/auth/verificacao-email";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Confirmação de e-mail" };
export const dynamic = "force-dynamic";

type Desfecho = "ok" | "expirado" | "limite" | "invalido";

function desfechoDe(bruto: string | undefined): Desfecho {
  return bruto === "ok" || bruto === "expirado" || bruto === "limite" ? bruto : "invalido";
}

/**
 * Onde cai quem abre o link do e-mail "Confirme seu e-mail" (`/auth/verificar-email`, que redireciona para
 * cá). Pública: a pessoa pode estar noutro navegador. Nunca vê o token. Link inválido, usado ou vencido:
 * explica e, se ela estiver logada, oferece "enviar um link novo" (com os tetos de 1 por minuto e 5 por dia).
 * Se a conta já está confirmada (a segunda abertura do mesmo link, ou um antivírus que abriu o link antes),
 * diz isso em vez de acusar erro.
 */
export default async function ResultadoDaVerificacaoPage({
  searchParams,
}: {
  searchParams: Promise<{ s?: string }>;
}) {
  const { s } = await searchParams;
  const desfecho = desfechoDe(s);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = await idiomaDoVisitante((user?.user_metadata?.locale as string | undefined) ?? null);
  const t = (texto: string) => traduzir(texto, idioma);

  const jaConfirmada = Boolean(user) && emailVerificado(user?.app_metadata);
  const confirmado = desfecho === "ok" || jaConfirmada;

  if (confirmado) {
    return (
      <div className="space-y-6 text-center" data-testid="verificacao-ok">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">{t("E-mail confirmado")}</h1>
          <p className="text-sm text-muted-foreground">{t("Obrigado. Seu endereço está confirmado.")}</p>
        </div>
        <Button asChild className="w-full">
          <Link href="/app">{t("Ir para o CRM")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 text-center" data-testid="verificacao-falhou">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          {desfecho === "expirado"
            ? t("Este link venceu")
            : desfecho === "limite"
              ? t("Muitas tentativas")
              : t("Este link não vale mais")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {desfecho === "limite"
            ? t("Aguarde um pouco e abra o link de novo.")
            : t("Ele pode já ter sido usado, ter vencido ou ter sido trocado por um link mais novo.")}
        </p>
      </div>
      {desfecho !== "limite" &&
        (user ? (
          <ReenviarConfirmacaoBotao />
        ) : (
          <Button asChild className="w-full">
            <Link href="/login?next=/app">{t("Entrar para pedir um link novo")}</Link>
          </Button>
        ))}
    </div>
  );
}
