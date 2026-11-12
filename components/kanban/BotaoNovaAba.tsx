"use client";
import { useT } from "@/hooks/i18n/useT";
import { ArrowSquareOut } from "@/lib/ui/icons";

/** O botão quadrado só com o ícone: mesma conversa, numa nova aba. */
export function BotaoNovaAba({
  href,
  onClick,
  disabled,
}: {
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  const rotulo = t("Abrir conversa em nova aba");
  const classe =
    "flex w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-text-muted transition-colors hover:border-primary/40 hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-70";
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={rotulo}
        title={rotulo}
        className={classe}
      >
        <ArrowSquareOut size={16} weight="regular" aria-hidden />
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={rotulo}
      title={rotulo}
      className={classe}
    >
      <ArrowSquareOut size={16} weight="regular" aria-hidden />
    </button>
  );
}
