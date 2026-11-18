"use client";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { Warning } from "@/lib/ui/icons";

export interface ErroComRetryProps {
  /** Título curto. Padrão: "Não foi possível carregar". */
  titulo?: string;
  /** Frase para leigo. Padrão: "Algo deu errado do nosso lado. Tente de novo em instantes." */
  descricao?: string;
  /** Refaz a busca que falhou. Sem ele, o botão não aparece. */
  onRetry?: () => void;
  /** Enquanto refaz, o botão fica desabilitado. */
  tentando?: boolean;
}

/** Estado de erro único das telas que buscam dados no cliente. */
export function ErroComRetry({ titulo, descricao, onRetry, tentando }: ErroComRetryProps) {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center py-12 text-center"
      data-testid="erro-com-retry"
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-error-fg">
        <Warning size={24} weight="duotone" aria-hidden />
      </div>
      <h3 className="text-base font-semibold">{titulo ?? t("Não foi possível carregar")}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {descricao ?? t("Algo deu errado do nosso lado. Tente de novo em instantes.")}
      </p>
      {onRetry ? (
        <Button type="button" variant="outline" className="mt-4" onClick={onRetry} disabled={tentando}>
          {t("Tentar novamente")}
        </Button>
      ) : null}
    </div>
  );
}
