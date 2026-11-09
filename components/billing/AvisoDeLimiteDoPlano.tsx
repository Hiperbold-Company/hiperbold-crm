"use client";

import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";

/** Para onde o aviso manda quem pode mudar de plano (a tela de assinar). */
const CAMINHO_PARA_ASSINAR = "/app/settings/plano/assinar";

/**
 * O motivo de um botão de criar desabilitado pelo teto do plano (agentes de IA, automações; D-227), com o
 * caminho para mudar de plano. Mesmo desenho de `AvisoDeLimiteDeConexoes`: o texto vem pronto do servidor
 * (já com o número e o idioma), aqui só se acrescenta o link.
 */
export function AvisoDeLimiteDoPlano({
  motivo,
  testId = "aviso-limite-do-plano",
  className = "mt-1.5 text-xs text-destructive",
}: {
  motivo: string | null | undefined;
  testId?: string;
  className?: string;
}) {
  const t = useT();
  if (!motivo) return null;
  return (
    <p className={className} data-testid={testId}>
      {motivo}{" "}
      <Link href={CAMINHO_PARA_ASSINAR} className="font-medium underline underline-offset-2">
        {t("Ver planos")}
      </Link>
    </p>
  );
}
