"use client";

/**
 * "Solicitar reembolso" (migration 0957, decisões do dono do produto de 15/10/2026). Só existe depois de cancelar
 * a assinatura, só para o pagamento MAIS RECENTE e só enquanto ele tem até 7 dias (garantia / direito de
 * arrependimento do CDC): quem decide se este botão aparece é `estadoDoReembolso`
 * (`lib/billing/reembolso/regras.ts`), no servidor, ao desenhar a página. A ação `solicitarReembolso` confere tudo
 * de novo no banco.
 *
 * O motivo NÃO é perguntado aqui: é o do cancelamento. O diálogo só mostra qual pagamento será reembolsado e
 * deixa uma observação opcional. A frase de erro vem pronta da ação (nunca o texto cru do Postgres) e vai direto
 * ao toast, sem passar por `t()`, no mesmo padrão de `_botao-cancelar-assinatura.tsx`.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { solicitarReembolso } from "@/app/actions/settings/reembolso";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { TAMANHO_MAXIMO_DO_DETALHE } from "@/lib/billing/reembolso/motivos";
import { formatCentsBRL } from "@/lib/money";

export interface PagamentoParaReembolso {
  paymentId: string;
  amountCents: number;
  /** ISO. */
  paidAt: string;
  /** O nome do plano, ou `null` quando o pagamento é de um pacote de tokens. */
  plano: string | null;
}

export function BotaoSolicitarReembolso({ pagamento }: { pagamento: PagamentoParaReembolso }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [detalhe, setDetalhe] = useState("");
  const [pendente, iniciar] = useTransition();

  const pagoEm = new Date(pagamento.paidAt).toLocaleDateString(tagDoIdioma, { timeZone: "America/Sao_Paulo" });
  const descricao = pagamento.plano ?? t("Pacote de tokens");

  function confirmar() {
    iniciar(async () => {
      const r = await solicitarReembolso({
        paymentId: pagamento.paymentId,
        ...(detalhe.trim() ? { detalhe: detalhe.trim() } : {}),
      });
      if (r.tipo === "erro") {
        toast.error(r.mensagem);
        return;
      }
      toast.success(t("Pedido de reembolso enviado."));
      setAberto(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        data-testid="solicitar-reembolso"
        variant="outline"
        size="sm"
        disabled={pendente}
        onClick={() => setAberto(true)}
      >
        {t("Solicitar reembolso")}
      </Button>

      <AlertDialog open={aberto} onOpenChange={setAberto}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Solicitar reembolso")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Você está dentro do prazo de arrependimento de 7 dias: o reembolso é integral.")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 text-left text-sm">
            <div className="rounded-md border border-border p-3" data-testid="reembolso-pagamento">
              <p className="font-medium">{descricao}</p>
              <p className="text-muted-foreground">
                {formatCentsBRL(pagamento.amountCents)} · {t("pago em")} {pagoEm}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="observacao-do-reembolso">{t("Quer deixar uma observação? (opcional)")}</Label>
              <Textarea
                id="observacao-do-reembolso"
                data-testid="observacao-do-reembolso"
                rows={3}
                maxLength={TAMANHO_MAXIMO_DO_DETALHE}
                value={detalhe}
                disabled={pendente}
                onChange={(e) => setDetalhe(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Respondemos em até 3 dias úteis. Assim que o estorno for concluído, avisamos por e-mail.")}
            </p>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendente}>{t("Voltar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirmar-solicitar-reembolso"
              disabled={pendente}
              onClick={(e) => {
                e.preventDefault();
                confirmar();
              }}
            >
              {t("Enviar pedido")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
