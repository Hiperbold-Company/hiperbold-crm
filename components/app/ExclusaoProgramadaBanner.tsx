/**
 * "Seus dados serão excluídos em dd/mm/aaaa": a faixa no topo do CRM enquanto a organização tem a exclusão dos
 * dados programada (migration 0959): assinatura cancelada ou suspensa que ainda dá para reativar, ou exclusão
 * programada pelo operador. A data vem do servidor (`org_exclusoes_programadas`). Não bloqueia nada e não
 * aparece em acesso de suporte (quem olha é a equipe, não o dono da conta).
 *
 * Client pelo mesmo motivo de `ConexaoCaidaBanner`: fica dentro do `IdiomaProvider` do layout de `/app`.
 */
"use client";

import Link from "next/link";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";

export function ExclusaoProgramadaBanner({ excluirEm, nomeDoCrm }: { excluirEm: string | null; nomeDoCrm: string }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { user } = useAuth();

  if (!excluirEm || user.support) return null;
  const data = new Date(excluirEm).toLocaleDateString(tagDoIdioma, { timeZone: "America/Sao_Paulo" });

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="exclusao-programada"
      className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-error/40 bg-surface bg-linear-to-b from-error-bg to-error-bg px-4 py-2 text-sm text-error-fg"
    >
      <span>
        {t("Seus dados no {crm} serão excluídos em {data}. Exporte o que precisar em Configurações ou reative a assinatura para manter tudo.")
          .replace("{crm}", nomeDoCrm)
          .replace("{data}", data)}
      </span>
      <Link
        href="/app/settings/plano"
        className="rounded-md border border-error/30 bg-surface hover:bg-surface-elevated px-3 py-1 font-medium text-error-fg"
      >
        {t("Ver meu plano")}
      </Link>
    </div>
  );
}
