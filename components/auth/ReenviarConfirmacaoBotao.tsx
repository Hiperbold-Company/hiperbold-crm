"use client";

import { Button } from "@/components/ui/button";
import { useReenviarVerificacao } from "@/hooks/auth/useReenviarVerificacao";
import { useT } from "@/hooks/i18n/useT";

/** "Reenviar o link" da página de link vencido (`/auth/verificar-email/resultado`). Só para quem está logado. */
export function ReenviarConfirmacaoBotao() {
  const t = useT();
  const { pendente, aviso, reenviar } = useReenviarVerificacao();
  return (
    <div className="space-y-2">
      <Button type="button" className="w-full" onClick={reenviar} disabled={pendente}>
        {pendente ? t("Enviando...") : t("Enviar um link novo")}
      </Button>
      {aviso && (
        <p role="status" className={`text-sm ${aviso.tom === "erro" ? "text-destructive" : "text-muted-foreground"}`}>
          {aviso.texto}
        </p>
      )}
    </div>
  );
}
