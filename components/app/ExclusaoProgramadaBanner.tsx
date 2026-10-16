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
      className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-red-300 bg-red-100/95 px-4 py-2 text-sm text-red-950 backdrop-blur dark:border-red-800/60 dark:bg-red-950/70 dark:text-red-50"
    >
      <span>
        {t("Seus dados no {crm} serão excluídos em {data}. Exporte o que precisar em Configurações ou reative a assinatura para manter tudo.")
          .replace("{crm}", nomeDoCrm)
          .replace("{data}", data)}
      </span>
      <Link
        href="/app/settings/plano"
        className="rounded-md border border-red-400 bg-white/70 px-3 py-1 font-medium text-red-950 hover:bg-white dark:border-red-700 dark:bg-red-900/40 dark:text-red-50 dark:hover:bg-red-900/70"
      >
        {t("Ver meu plano")}
      </Link>
    </div>
  );
}
