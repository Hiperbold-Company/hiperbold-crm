"use client";

import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { fraseDaFaixa } from "@/lib/cobranca/faixa";

/**
 * A faixa de teste grátis em `/app` (spec da cobrança §9): só para o admin da
 * empresa, só com a cobrança ligada, nos últimos 7 dias. É porta, não trava:
 * leva ao painel do plano.
 */
export function FaixaDoTesteGratis({ dias }: { dias: number }) {
  const t = useT();
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-2 border-b border-info/30 bg-info-bg px-4 py-2 text-sm text-info-fg"
    >
      <span>{t(fraseDaFaixa(dias)).replace("{n}", String(dias))}</span>
      <Link href="/app/settings/billing" className="font-medium underline">
        {t("Ver o plano")}
      </Link>
    </div>
  );
}
