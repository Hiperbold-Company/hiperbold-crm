"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { copyToClipboard } from "@/lib/clipboard";
import { useMarcaDoSistema } from "@/lib/redesign/sistema";
import { relatarErroDoNavegador } from "@/lib/erros/relatar-erro-do-navegador";

export interface SegmentErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  segment?: string;
}

export function SegmentError({ error, reset, segment }: SegmentErrorProps) {
  const t = useT();
  const rd = useMarcaDoSistema();
  const [eventId, setEventId] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const id = Sentry.captureException(error, {
      tags: segment ? { segment } : undefined,
    });
    setEventId(id);
    // Com o Sentry desligado (`SENTRY_DSN=off`), este é o único rastro do erro.
    relatarErroDoNavegador(error, segment);
  }, [error, segment]);

  const displayId = eventId ?? error.digest ?? "—";

  function copyId() {
    void copyToClipboard(displayId).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    });
  }

  return (
    <main className="flex min-h-[60vh] items-center justify-center p-8" data-rd-sistema={rd("pagina")}>
      <Card className="w-full max-w-md p-8 text-center" data-rd-sistema={rd("cartao")}>
        <h1 className="text-xl font-semibold" data-rd-sistema={rd("titulo")}>{t("Algo deu errado")}</h1>
        <p className="mt-2 text-sm text-muted-foreground" data-rd-sistema={rd("texto")}>
          {t("Tente novamente em instantes. Se persistir, contate o suporte com o ID abaixo.")}
        </p>
        <div className="mt-4 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs" data-rd-sistema={rd("erro-id")}>
          ID: {displayId}
        </div>
        <div className="mt-4 flex justify-center gap-2" data-rd-sistema={rd("acoes")}>
          <Button type="button" variant="outline" onClick={copyId}>
            {copied ? t("Copiado!") : t("Copiar ID")}
          </Button>
          <Button type="button" onClick={() => reset()}>
            {t("Tentar de novo")}
          </Button>
        </div>
      </Card>
    </main>
  );
}
