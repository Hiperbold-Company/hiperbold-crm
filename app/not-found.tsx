import { redesignNaRequisicao } from "@/lib/redesign/chave";
import { marcaDoSistema } from "@/lib/redesign/sistema";
import Link from "next/link";
import { PaginaDoSistema } from "@/components/redesign/PaginaDoSistema";
import { marcaDaSaida } from "@/lib/branding/saida";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export default async function NotFound() {
  // Rota fora da árvore de `app/app/layout.tsx` — sem `IdiomaProvider`, então
  // resolve o idioma direto, como `admin/forbidden/page.tsx`. Pode chegar aqui
  // sem sessão (link quebrado, robô), por isso `user` é opcional.
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
          codigo="404"
          tom="info"
          titulo={t("Não achamos esta página")}
          linhas={[
            t("O link pode estar errado ou a página mudou de lugar."),
            t("Confira o endereço ou siga para o Início."),
          ]}
          principal={{ tipo: "link", href: "/app/inicio", rotulo: t("Ir para o Início") }}
          secundaria={{ tipo: "voltar", rotulo: t("Voltar à página anterior") }}
          marca={await marcaDaSaida(null)}
          idioma={idioma}
        />
      </IdiomaProvider>
    );
  }

  // O IdiomaProvider entrega o idioma ao <html lang>: sem ele, quem lê em
  // inglês recebia o documento marcado como pt-BR (leitor de tela, tradutor).
  return (
    <IdiomaProvider locale={idioma}>
    <main className="flex min-h-screen items-center justify-center p-8" data-rd-sistema={rd("pagina")}>
      <Card className="w-full max-w-md p-8 text-center" data-rd-sistema={rd("cartao")}>
        <h1 className="text-2xl font-semibold" data-rd-sistema={rd("titulo")}>
          {traduzir("404 — Página não encontrada", idioma)}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground" data-rd-sistema={rd("texto")}>
          {traduzir("Verifique o link ou volte pra inbox.", idioma)}
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
