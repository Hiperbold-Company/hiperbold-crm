/**
 * "Confirme seu e-mail": a faixa no topo do CRM enquanto o endereço da conta não foi confirmado pelo link
 * do CRM (`lib/auth/verificacao-email.ts`). Substitui a confirmação do Supabase, que deixa de barrar o
 * cadastro: a pessoa entra e usa o produto, e a faixa só lembra.
 *
 * NUNCA bloqueia nada: não é modal, não tira a pessoa de lugar nenhum e some sozinha no primeiro
 * carregamento depois do clique no link. Não aparece em acesso de suporte (quem olha é a equipe, não o dono
 * da conta) nem para conta que já era verificada (ver a regra em `emailVerificado`).
 *
 * Client pelo mesmo motivo de `ConexaoCaidaBanner`: fica dentro do `IdiomaProvider` do layout de `/app`.
 */
"use client";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useReenviarVerificacao } from "@/hooks/auth/useReenviarVerificacao";
import { useT } from "@/hooks/i18n/useT";

export function EmailNaoConfirmadoBanner() {
  const t = useT();
  const { user } = useAuth();
  const { pendente, aviso, reenviar } = useReenviarVerificacao();

  if (user.email_verificado !== false || user.support || !user.email) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="email-nao-confirmado"
      className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-amber-300 bg-amber-100/95 px-4 py-2 text-sm text-amber-950 backdrop-blur dark:border-amber-800/60 dark:bg-amber-950/70 dark:text-amber-50"
    >
      <span>
        {t("Confirme seu e-mail: enviamos um link para")}{" "}
        <strong className="font-semibold">{user.email}</strong>.
      </span>
      <span className="flex flex-wrap items-center gap-3">
        {aviso && (
          <span className={aviso.tom === "erro" ? "font-medium" : undefined} data-testid="email-nao-confirmado-aviso">
            {aviso.texto}
          </span>
        )}
        <button
          type="button"
          onClick={reenviar}
          disabled={pendente}
          className="rounded-md border border-amber-400 bg-white/70 px-3 py-1 font-medium text-amber-950 hover:bg-white disabled:opacity-60 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-50 dark:hover:bg-amber-900/70"
        >
          {pendente ? t("Enviando...") : t("Reenviar")}
        </button>
      </span>
    </div>
  );
}
