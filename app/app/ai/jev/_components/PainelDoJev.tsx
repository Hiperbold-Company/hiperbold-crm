"use client";

import { useT } from "@/hooks/i18n/useT";

import { CartaoDoJev, useDadosDoJev } from "../../providers/_components/CartaoDoJev";

/** A página do Jev: o cartão de sempre, com título, sem o resto do painel de Provedores. */
export function PainelDoJev() {
  const t = useT();
  const jev = useDadosDoJev();

  return (
    <div className="mx-auto w-full max-w-3xl p-6" data-testid="painel-do-jev">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Decisões rápidas (Jev)")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {t("Classificações rápidas de mensagens com o Jev, da TypeSafe. Precisa ser ligado e aceito por um administrador.")}
        </p>
      </header>
      <CartaoDoJev dados={jev.dados} erro={jev.erro} recarregar={jev.recarregar} />
    </div>
  );
}
