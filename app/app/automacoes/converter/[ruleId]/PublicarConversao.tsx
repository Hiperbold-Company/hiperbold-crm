"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { randomId } from "@/lib/random-id";

/** Publicar a conversão: a automação nova liga e a regra antiga desliga, juntas (lote 5). */
export function PublicarConversao({ ruleId }: { ruleId: string }) {
  const t = useT();
  const router = useRouter();
  const [chave] = useState(() => randomId());
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const publicar = async () => {
    setErro(null);
    setEnviando(true);
    try {
      const resp = await fetch(`/api/v1/automacoes/converter-regra/${ruleId}`, {
        method: "POST",
        headers: { "Idempotency-Key": chave },
      });
      const corpo = (await resp.json().catch(() => null)) as {
        data?: { pointer_id: string };
        error?: { message?: string };
      } | null;
      if (!resp.ok || !corpo?.data) {
        setErro(corpo?.error?.message ?? t("Não consegui publicar a automação. Tente de novo."));
        return;
      }
      router.push(`/app/automacoes/${corpo.data.pointer_id}`);
    } catch {
      setErro(t("Não consegui publicar a automação. Tente de novo."));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Card className="border-warning-200 space-y-3 p-4" data-testid="aviso-da-conversao">
      <p className="text-sm font-medium">{t("Ao publicar, a regra antiga é desligada")}</p>
      <p className="text-sm text-text-muted">
        {t(
          "A automação nova passa a fazer o mesmo trabalho. As duas nunca ficam ligadas ao mesmo tempo.",
        )}
      </p>
      {erro && (
        <p role="alert" className="text-sm text-error-fg">
          {erro}
        </p>
      )}
      <Button onClick={publicar} disabled={enviando} data-testid="publicar-conversao">
        {enviando ? t("Publicando…") : t("Publicar automação nova")}
      </Button>
    </Card>
  );
}
