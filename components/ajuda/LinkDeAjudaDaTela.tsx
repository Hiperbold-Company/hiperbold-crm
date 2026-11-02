"use client";
import { usePathname } from "next/navigation";
import { ArrowSquareOut } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { artigoProprio, urlNaCentral } from "@/lib/ajuda/artigos";
import { useBaseDaCentralDeAjuda } from "@/lib/ajuda/contexto";

/**
 * Linha curta "Dúvidas? Veja como usar esta tela na central de ajuda", posta
 * abaixo do título da tela.
 *
 * Aparece só quando a instalação tem central (`HELP_CENTER_URL`) E a tela tem
 * artigo PRÓPRIO: nunca aponta para a página genérica do produto, porque
 * "veja como usar esta tela" levando a um índice seria promessa quebrada.
 *
 * `caminho` força um artigo (uma aba, uma seção); sem ele vale a rota atual.
 * `rotulo` troca o texto do link (o "Dúvidas?" da frente continua).
 */
interface Props {
  caminho?: string | null;
  rotulo?: string;
  semPrefixo?: boolean;
  className?: string;
}

export function LinkDeAjudaDaTela(props: Props) {
  // Sem central configurada nem a rota se lê: a instalação white-label sem
  // `HELP_CENTER_URL` não paga nada por este componente estar na tela.
  const base = useBaseDaCentralDeAjuda();
  if (!base) return null;
  return props.caminho === undefined ? (
    <LinkPelaRota {...props} base={base} />
  ) : (
    <Linha {...props} base={base} alvo={props.caminho} />
  );
}

function LinkPelaRota(props: Props & { base: string }) {
  const rota = usePathname();
  return <Linha {...props} alvo={artigoProprio(rota)} />;
}

function Linha({
  base,
  alvo,
  rotulo,
  semPrefixo = false,
  className,
}: Props & { base: string; alvo: string | null }) {
  const t = useT();
  const href = urlNaCentral(base, alvo);
  if (!href) return null;

  return (
    <p className={cn("text-sm text-muted-foreground", className)} data-ajuda-da-tela="">
      {!semPrefixo && <>{t("Dúvidas?")} </>}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
      >
        {rotulo ?? t("Veja como usar esta tela na central de ajuda")}
        <ArrowSquareOut size={14} aria-hidden />
        <span className="sr-only">{t("(abre em nova aba)")}</span>
      </a>
    </p>
  );
}
