"use client";

import { useState, useTransition } from "react";

import { reenviarVerificacaoEmail, type ReenviarVerificacaoResult } from "@/app/actions/auth/reenviarVerificacaoEmail";
import { useT } from "@/hooks/i18n/useT";

export type AvisoDoReenvio = { tom: "ok" | "erro"; texto: string };

/**
 * O "Reenviar e-mail de confirmação" com o desfecho já em texto, para a faixa do CRM
 * (`EmailNaoConfirmadoBanner`) e para a página de link vencido dividirem as mesmas mensagens.
 */
export function useReenviarVerificacao() {
  const t = useT();
  const [pendente, iniciar] = useTransition();
  const [aviso, setAviso] = useState<AvisoDoReenvio | null>(null);

  const reenviar = () => {
    setAviso(null);
    iniciar(async () => {
      const r: ReenviarVerificacaoResult = await reenviarVerificacaoEmail();
      if (r.ok) {
        setAviso({ tom: "ok", texto: t("Link reenviado. Confira sua caixa de entrada.") });
      } else if (r.error === "muito_cedo") {
        setAviso({ tom: "erro", texto: t("Aguarde 1 minuto para pedir outro link.") });
      } else if (r.error === "limite_diario") {
        setAviso({ tom: "erro", texto: t("Você chegou ao limite de 5 reenvios por dia. Tente amanhã.") });
      } else if (r.error === "ja_confirmado") {
        setAviso({ tom: "ok", texto: t("Seu e-mail já está confirmado.") });
      } else {
        setAviso({ tom: "erro", texto: t("Não foi possível reenviar agora. Tente de novo em instantes.") });
      }
    });
  };

  return { pendente, aviso, reenviar };
}
