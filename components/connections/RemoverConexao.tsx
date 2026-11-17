"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * "Remover conexão" em DOIS cliques, como nos cartões de QR e da oficial: o primeiro só pede
 * confirmação, o segundo chama a rota. Remover desliga a entrada de mensagens do número.
 *
 * A rota vem de quem monta, porque cada canal remove pelo seu caminho (a instância apaga também
 * o WhatsApp no servidor; a oficial desfaz o webhook na Meta). Quem barra é sempre a rota.
 */
export function RemoverConexao({
  rota,
  aoRemover,
  testId = "btn-remover-conexao",
}: {
  rota: string;
  aoRemover: () => void | Promise<unknown>;
  testId?: string;
}) {
  const t = useT();
  const [confirmando, setConfirmando] = useState(false);
  const [removendo, setRemovendo] = useState(false);

  async function remover() {
    if (!confirmando) {
      setConfirmando(true);
      return;
    }
    setConfirmando(false);
    setRemovendo(true);
    try {
      const r = await apiClient.delete<{ data?: { instancia_restou?: boolean } } | undefined>(rota);
      if (r?.data?.instancia_restou) {
        toast.warning(t("Conexão removida, mas o WhatsApp não foi apagado no servidor. Avise quem cuida do servidor."));
      } else {
        toast.success(t("Conexão removida."));
      }
      await aoRemover();
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível remover."));
    } finally {
      setRemovendo(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="text-destructive hover:text-destructive"
      disabled={removendo}
      onClick={() => void remover()}
      data-testid={testId}
    >
      {confirmando ? t("Clique de novo para remover") : t("Remover conexão")}
    </Button>
  );
}
