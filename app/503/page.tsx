import { redesignNaRequisicao } from "@/lib/redesign/chave";
import { marcaDoSistema } from "@/lib/redesign/sistema";
import Link from "next/link";
import { PaginaDoSistema } from "@/components/redesign/PaginaDoSistema";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { marcaDaSaida } from "@/lib/branding/saida";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { traduzir } from "@/lib/i18n/dicionario";

export default async function ServiceUnavailablePage() {
  // Manutenção é justamente o cenário em que o Supabase pode estar fora do ar —
  // esta página não pode depender dele para saber em que idioma falar. Sem
  // sessão para consultar, `idiomaDoVisitante(null)` lê só o Accept-Language
  // do navegador (cabeçalho da requisição, nenhuma rede).
  const idioma = await idiomaDoVisitante(null);
  const ligado = await redesignNaRequisicao();
  const rd = marcaDoSistema(ligado);
  const t = (texto: string) => traduzir(texto, idioma);

  if (ligado) {
    return (
      <IdiomaProvider locale={idioma}>
        <PaginaDoSistema
          codigo="503"
          tom="aviso"
          icone="pausa"
          titulo={t("Estamos em manutenção")}
          linhas={[
            t("Estamos atualizando o sistema. Seus dados estão seguros."),
            t("Voltamos em alguns minutos."),
          ]}
          principal={{ tipo: "recarregar", rotulo: t("Atualizar a página") }}
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
        <h1 className="text-2xl font-semibold" data-rd-sistema={rd("titulo")}>{traduzir("503 — Em manutenção", idioma)}</h1>
        <p className="mt-2 text-sm text-muted-foreground" data-rd-sistema={rd("texto")}>
          {traduzir("Voltamos em alguns minutos.", idioma)}
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
