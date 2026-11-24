import { redesignNaRequisicao } from "@/lib/redesign/chave";
import { marcaDoSistema } from "@/lib/redesign/sistema";
import Link from "next/link";
import { PaginaDoSistema } from "@/components/redesign/PaginaDoSistema";
import { marcaDaSaida } from "@/lib/branding/saida";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export default async function ForbiddenPage() {
  // Rota fora da árvore de `app/app/layout.tsx` — sem o `IdiomaProvider` de lá, então
  // resolve o idioma direto, como `admin/forbidden/page.tsx`. Pode chegar aqui
  // sem sessão (link direto, robô), por isso `user` é opcional.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = await idiomaDoVisitante((user?.user_metadata?.locale as string | undefined) ?? null);

  const ligado = await redesignNaRequisicao();
  const rd = marcaDoSistema(ligado);
  const t = (texto: string) => traduzir(texto, idioma);

  if (ligado) {
    return (
      <IdiomaProvider locale={idioma}>
        <PaginaDoSistema
          codigo="403"
          tom="aviso"
          titulo={t("Você não tem acesso a esta tela")}
          linhas={[
            t("Esta parte do sistema é liberada só para alguns papéis da equipe."),
            t("Se precisa dela, fale com quem administra a sua empresa."),
          ]}
          principal={{ tipo: "link", href: "/app/inicio", rotulo: t("Voltar ao Início") }}
          secundaria={{ tipo: "voltar", rotulo: t("Voltar à página anterior") }}
          marca={await marcaDaSaida(null)}
          idioma={idioma}
        />
      </IdiomaProvider>
    );
  }

  return (
    <IdiomaProvider locale={idioma}>
      <main className="flex min-h-screen items-center justify-center p-8" data-rd-sistema={rd("pagina")}>
        <Card className="w-full max-w-md p-8 text-center" data-rd-sistema={rd("cartao")}>
          <h1 className="text-2xl font-semibold" data-rd-sistema={rd("titulo")}>{traduzir("403 — Sem permissão", idioma)}</h1>
          <p className="mt-2 text-sm text-muted-foreground" data-rd-sistema={rd("texto")}>
            {traduzir("Você não tem acesso a essa área.", idioma)}
          </p>
          <div className="mt-6 flex justify-center gap-2" data-rd-sistema={rd("acoes")}>
            <Button asChild variant="outline">
              <Link href="/">{traduzir("Voltar", idioma)}</Link>
            </Button>
            <Button asChild>
              <Link href="/app/inbox">{traduzir("Voltar pra Inbox", idioma)}</Link>
            </Button>
          </div>
        </Card>
      </main>
    </IdiomaProvider>
  );
}
