"use client";
import { useState, useTransition } from "react";

import { reenviarVerificacaoEmail } from "@/app/actions/auth/reenviarVerificacaoEmail";

/**
 * O "Reenviar" do e-mail de confirmação, na tela de aceite do convite (D-204). Esta página é pública e fica fora do
 * `IdiomaProvider`, então os textos chegam já traduzidos pela página (nenhum `useT` aqui).
 */
export function ReenviarVerificacaoNoConvite({
  label,
  pendingLabel,
  okLabel,
  erroLabel,
}: {
  label: string;
  pendingLabel: string;
  okLabel: string;
  erroLabel: string;
}) {
  const [pendente, iniciar] = useTransition();
  const [aviso, setAviso] = useState<{ ok: boolean } | null>(null);
  return (
    <div className="mt-4 space-y-3">
      {aviso && (
        <p role="status" className="text-sm">
          {aviso.ok ? okLabel : erroLabel}
        </p>
      )}
      <button
        type="button"
        disabled={pendente}
        onClick={() =>
          iniciar(async () => {
            const r = await reenviarVerificacaoEmail();
            setAviso({ ok: r.ok || r.error === "ja_confirmado" });
          })
        }
        className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-60"
      >
        {pendente ? pendingLabel : label}
      </button>
    </div>
  );
}
