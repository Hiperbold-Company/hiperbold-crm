"use client";

/**
 * O campo "por que você está cancelando?" (migration 0957): um dos cinco motivos do vocabulário fechado, obrigatório,
 * e um texto livre opcional (até 1000 caracteres). Usado no diálogo de cancelar a assinatura. O motivo escolhido
 * é o que o pedido de reembolso reaproveita depois, então o pedido de reembolso não pergunta de novo.
 */
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import {
  MOTIVOS_DE_CANCELAMENTO,
  ROTULO_DO_MOTIVO,
  TAMANHO_MAXIMO_DO_DETALHE,
  type MotivoDeCancelamento,
} from "@/lib/billing/reembolso/motivos";

export function CampoDeMotivo({
  motivo,
  aoMudarMotivo,
  detalhe,
  aoMudarDetalhe,
  desabilitado,
}: {
  motivo: MotivoDeCancelamento | "";
  aoMudarMotivo: (m: MotivoDeCancelamento | "") => void;
  detalhe: string;
  aoMudarDetalhe: (d: string) => void;
  desabilitado?: boolean;
}) {
  const t = useT();
  return (
    <div className="space-y-3 text-left">
      <div className="space-y-1.5">
        <Label htmlFor="motivo-do-cancelamento">{t("Por que você está cancelando?")}</Label>
        <select
          id="motivo-do-cancelamento"
          data-testid="motivo-do-cancelamento"
          className="flex h-10 w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm text-text focus-visible:outline-hidden focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-55"
          value={motivo}
          disabled={desabilitado}
          required
          onChange={(e) => aoMudarMotivo(e.target.value as MotivoDeCancelamento | "")}
        >
          <option value="">{t("Escolha um motivo")}</option>
          {MOTIVOS_DE_CANCELAMENTO.map((m) => (
            <option key={m} value={m}>
              {t(ROTULO_DO_MOTIVO[m])}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="detalhe-do-cancelamento">{t("Quer contar mais? (opcional)")}</Label>
        <Textarea
          id="detalhe-do-cancelamento"
          data-testid="detalhe-do-cancelamento"
          rows={3}
          maxLength={TAMANHO_MAXIMO_DO_DETALHE}
          value={detalhe}
          disabled={desabilitado}
          onChange={(e) => aoMudarDetalhe(e.target.value)}
        />
      </div>
    </div>
  );
}
