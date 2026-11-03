import type { Metadata } from "next";

import { Card } from "@/components/ui/card";
import { emailDeSuporte, marcaDaSaida } from "@/lib/branding/saida";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Exclusão de dados" };

/**
 * Página de status da exclusão de dados da conexão de Instagram e Messenger.
 *
 * A Meta chama o nosso callback de exclusão quando a pessoa remove o app nas
 * configurações do Instagram ou do Facebook, e manda essa pessoa para cá com
 * `?codigo=` (o número do pedido que o callback devolveu). Quem chega não tem
 * sessão nossa, nem pode ter: a rota é pública (`lib/auth/public-paths.ts`) e
 * não lê nada da sessão nem do banco além da marca e do e-mail de suporte da
 * instalação, que já aparecem sem login na tela de entrar.
 *
 * O código só é ecoado na tela, como texto, e só se tiver a forma de um código
 * (letras, números, hífen e sublinhado, até 64): um link com lixo na query não
 * vira texto arbitrário na página.
 */
const FORMA_DO_CODIGO = /^[A-Za-z0-9_-]{1,64}$/;

export default async function ExclusaoDeDadosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parametros = await searchParams;
  const bruto = Array.isArray(parametros.codigo) ? parametros.codigo[0] : parametros.codigo;
  const codigo = bruto && FORMA_DO_CODIGO.test(bruto) ? bruto : null;

  const [marca, suporte, idioma] = await Promise.all([
    marcaDaSaida(null),
    emailDeSuporte(),
    idiomaDoVisitante(null),
  ]);
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-lg space-y-4 p-8 text-sm leading-relaxed">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{marca.nome}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Exclusão de dados")}</h1>
        <p>
          {t(
            "Recebemos o pedido de exclusão dos dados ligados à sua conta do Instagram ou do Facebook.",
          )}
        </p>
        {codigo && (
          <p>
            {t("Código do pedido:")}{" "}
            <code className="rounded-md bg-muted px-1.5 py-0.5" data-testid="codigo-do-pedido">
              {codigo}
            </code>
          </p>
        )}
        <p>{t("A exclusão é concluída em até 15 dias.")}</p>
        {suporte ? (
          <p>
            {t("Dúvidas sobre o pedido? Escreva para")}{" "}
            <a className="underline underline-offset-2" href={`mailto:${suporte}`}>
              {suporte}
            </a>
            {codigo ? ` ${t("e informe o código do pedido.")}` : "."}
          </p>
        ) : (
          <p className="text-muted-foreground">
            {t("Dúvidas sobre o pedido? Fale com a empresa com quem você conversou pelo Instagram ou pelo Facebook.")}
          </p>
        )}
      </Card>
    </main>
  );
}
