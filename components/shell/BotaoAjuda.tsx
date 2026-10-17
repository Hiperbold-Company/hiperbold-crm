"use client";
import { usePathname } from "next/navigation";
import { Question } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { urlDaAjuda } from "@/lib/ajuda/artigos";

/**
 * Abre a central de ajuda, em nova aba, no artigo da tela atual.
 *
 * `base` é o endereço da central desta instalação (`HELP_CENTER_URL`, lido no
 * servidor e passado de cima). Sem ele o botão não existe: o produto é
 * white-label e nenhum endereço de revendedor mora no código.
 */
export function BotaoAjuda({ base }: { base: string | null }) {
  const t = useT();
  const rota = usePathname();
  const href = urlDaAjuda(base, rota);
  if (!href) return null;

  return (
    <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
      <a href={href} target="_blank" rel="noopener noreferrer" aria-label={t("Ajuda")}>
        <Question size={16} aria-hidden />
        <span className="hidden md:inline">{t("Ajuda")}</span>
      </a>
    </Button>
  );
}
