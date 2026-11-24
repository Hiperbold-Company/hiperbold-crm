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

/**
 * `/500` — irmã de `/403` e `/503`, e faltava.
 *
 * `lib/auth/public-paths.ts` já isenta esta rota de auth desde sempre: o
 * sistema contava com a página. Sem ela, quem caísse aqui (proxy, link de
 * runbook, redirect de borda) via "página não encontrada" — a mensagem errada
 * sobre o que aconteceu.
 *
 * Distinta de `app/error.tsx`, que trata exceção em runtime dentro do React.
 * Esta é a página estática, alcançável por URL.
 */
export default async function InternalErrorPage() {
  // Rota fora da árvore de `app/app/layout.tsx` — sem o `IdiomaProvider` de lá, então
  // resolve o idioma direto, como `admin/forbidden/page.tsx`. Quem cai aqui
  // pode até ser o próprio Supabase falhando, por isso `user` é opcional e a
  // ausência de sessão não impede a página de renderizar.
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
          codigo="500"
          tom="erro"
          titulo={t("Algo deu errado do nosso lado")}
          linhas={[
            t("Não é nada que você fez. Já registramos o ocorrido."),
            t("Tente de novo em instantes."),
          ]}
          // Voltar, e não recarregar: quem chega aqui por redirecionamento
          // recarregaria a própria /500. A 503 recarrega porque é rewrite
          // (proxy.ts) e mantém a URL da tela que falhou.
          principal={{ tipo: "voltar", rotulo: t("Tentar de novo") }}
          secundaria={{ tipo: "link", href: "/app/inicio", rotulo: t("Ir para o Início") }}
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
          <h1 className="text-2xl font-semibold" data-rd-sistema={rd("titulo")}>{traduzir("500 — Erro interno", idioma)}</h1>
          <p className="mt-2 text-sm text-muted-foreground" data-rd-sistema={rd("texto")}>
            {traduzir(
              "Algo quebrou do nosso lado. Já registramos o ocorrido; tente de novo em instantes.",
              idioma,
            )}
          </p>
          <div className="mt-6 flex justify-center gap-2" data-rd-sistema={rd("acoes")}>
            <Button asChild>
              <Link href="/">{traduzir("Voltar", idioma)}</Link>
            </Button>
          </div>
        </Card>
      </main>
    </IdiomaProvider>
  );
}
