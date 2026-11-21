import { redesignLigado } from "@/lib/redesign/chave";
import { marcaDoSistema } from "@/lib/redesign/sistema";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

// Manutenção é justamente o cenário em que o Supabase pode estar fora do ar —
// esta página não pode depender dele para saber em que idioma falar. Sem
// sessão para consultar, fica no idioma padrão da instalação.
const idioma = IDIOMA_PADRAO;

export default function ServiceUnavailablePage() {
  const rd = marcaDoSistema(redesignLigado());

  return (
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
  );
}
