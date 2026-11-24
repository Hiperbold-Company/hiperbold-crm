"use client";
import { useMemo, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useLoseLead } from "@/hooks/kanban/useUpdateLead";
import { useMotivosDePerdaDoFunil } from "@/hooks/kanban/useMotivosDePerdaDoFunil";
import { rotuloDoMotivoDePerda } from "@/lib/schemas/leads";
import { OUTRO, opcoesDeMotivoDePerda } from "@/lib/leads/motivos-de-perda-do-funil";

interface LoseLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipelineId: string;
  /**
   * Modo CARD: perde UM negócio pela rota individual (`/leads/{id}/lose`).
   * Ausente no modo lote.
   */
  leadId?: string;
  /**
   * Modo LOTE (#2484 F2): recebe o motivo escolhido e quem chamou decide a
   * escrita — a `leads/bulk` que já sabe decidir o motivo da perda (#917). O
   * diálogo é o MESMO do card: uma segunda janela de motivo seria a mesma
   * pergunta com duas respostas possíveis, e o funil passaria a ter duas listas.
   */
  onConfirm?: (lostReason: string, detalhe?: string) => void | Promise<void>;
  /**
   * Modo LOTE: quem chamou informa se a escrita em lote está em voo. Este
   * diálogo não conhece a mutação de lote (`useBulkAction`) — então não pode
   * perguntar `isPending` a ela; sem este sinal o botão "Confirmar" ficaria
   * clicável durante a escrita e um segundo clique dobraria o lote.
   */
  submitting?: boolean;
  /** Depois de a perda gravar — para quem mora fora do quadro (ex.: painel da conversa) recarregar o que mostra. */
  onPerdido?: () => void;
  /** Motivos do funil quando o quadro não está em cache (painel da conversa); sem isto, lê do cache do quadro. */
  motivos?: string[];
  /** Modo LOTE: quantos negócios a confirmação alcança — muda só o texto da janela. */
  quantidade?: number;
}

const MAX_LEN = 500;

export function LoseLeadDialog({
  open,
  onOpenChange,
  leadId,
  pipelineId,
  onConfirm,
  submitting = false,
  quantidade,
  onPerdido,
  motivos,
}: LoseLeadDialogProps) {
  const t = useT();
  const [reasonCode, setReasonCode] = useState<string>("");
  const [otherText, setOtherText] = useState("");
  const mutation = useLoseLead(pipelineId);
  // O diálogo vale para os DOIS modos: a escrita individual (card) ou a do
  // chamador (lote). "em voo" é a mutação individual OU o sinal externo.
  const emVoo = mutation.isPending || submitting;

  // O funil deste card manda na lista: o que ele tem cadastrado substitui o
  // padrão do produto — ver lib/leads/motivos-de-perda-do-funil.ts.
  const doQuadro = useMotivosDePerdaDoFunil(pipelineId);
  const cadastrados = motivos ?? doQuadro;
  const opcoes = useMemo(() => opcoesDeMotivoDePerda(cadastrados), [cadastrados]);

  const textoOutro = otherText.trim();
  // "OUTRO" GRAVA SEMPRE `other` — o código canônico que o trigger aceita em
  // qualquer funil. O texto do detalhe NÃO é o motivo: ele vai à parte
  // (`detalhe`), para a timeline da perda, e nunca passa pelo vocabulário
  // (`fn_validate_lost_reason_required`), que recusa texto fora de
  // canônico ∪ `settings.lost_reasons`. Tratar o detalhe como motivo fazia
  // "Outro" + texto bater em "não está na lista deste funil" (CBEXS).
  const finalReason = reasonCode;
  const detalhe = reasonCode === OUTRO && textoOutro.length > 0 ? textoOutro : undefined;
  const disabled =
    !reasonCode ||
    finalReason.length === 0 ||
    finalReason.length > MAX_LEN ||
    (detalhe?.length ?? 0) > MAX_LEN ||
    emVoo;

  const handleSubmit = async () => {
    if (disabled) return;
    try {
      // Modo LOTE (#2484 F2): o motivo vai para quem chamou, que escreve pela
      // `leads/bulk`. Modo CARD: a rota individual. Sem `leadId` NEM `onConfirm`
      // não há escrita nenhuma a fazer — o `disabled` já cobre o caso de uso,
      // e este guarda evita um clique pendurado em arranjo inválido.
      if (onConfirm) {
        await onConfirm(finalReason, detalhe);
      } else if (leadId) {
        await mutation.mutateAsync({
          leadId,
          lostReason: finalReason,
          lostReasonDetail: detalhe,
        });
      } else {
        return;
      }
      setReasonCode("");
      setOtherText("");
      onOpenChange(false);
      onPerdido?.();
    } catch {
      // error already toasted
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Marcar como perdido")}</DialogTitle>
          <DialogDescription>
            {quantidade && quantidade > 1
              ? `${t("O mesmo motivo vale para os")} ${quantidade} ${t("negócios selecionados.")} `
              : null}
            {t("Informe o motivo. Essa informação ajuda a melhorar o funil.")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Label>{t("Motivo")}</Label>
          <div className="grid grid-cols-1 gap-1.5">
            {opcoes.map((opcao) => (
              <label
                key={opcao.valor}
                className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent"
              >
                <input
                  type="radio"
                  name="lost-reason"
                  value={opcao.valor}
                  checked={reasonCode === opcao.valor}
                  onChange={(e) => setReasonCode(e.target.value)}
                />
                <span>{opcao.doFunil ? opcao.valor : t(rotuloDoMotivoDePerda(opcao.valor))}</span>
              </label>
            ))}
          </div>
          {reasonCode === OUTRO && (
            <div className="grid gap-1.5">
              <Label htmlFor="lost-reason-other">
                {t("Detalhe (opcional)")}
              </Label>
              <Textarea
                id="lost-reason-other"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder={t("Ex: Cliente desistiu por X motivo")}
                maxLength={MAX_LEN}
                rows={3}
              />
              <div className="text-right text-2xs text-muted-foreground tabular-nums">
                {otherText.length}/{MAX_LEN}
              </div>
              {/*
                O detalhe é registrado na linha do tempo do negócio; o relatório
                de perdas continua contando como "Outro motivo".
              */}
              <p className="text-xs text-muted-foreground">
                {t("O detalhe fica na linha do tempo do negócio. Nos relatórios, a perda conta como “Outro motivo”.")}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={emVoo}
          >
            {t("Cancelar")}
          </Button>
          <Button onClick={handleSubmit} disabled={disabled}>
            {emVoo ? t("Salvando...") : t("Confirmar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
