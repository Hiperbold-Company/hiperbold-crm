"use client";

/**
 * O passo "Plano" quando já existe um pedido de assinatura: o Pix gerado que ainda não foi pago, o
 * cartão que o Asaas ainda não confirmou, ou o pagamento confirmado cujo contrato está sendo
 * ativado.
 *
 * Esta tela NÃO avança sozinha por palpite: acompanha o PEDIDO (`usePollDoPedido`, a cada 5s por
 * até 10 min, o mesmo da tela de compra) e, ao ver `pago`, pede ao servidor o próximo passo —
 * `/onboarding` só deixa seguir quando o contrato já está ativo (`precisaPagarAntesDeConfigurar`).
 * Se o contrato ainda não virou (o webhook marca o pedido e o contrato em sequência), repete a
 * cada 3s até virar. Cartão e Pix caem no mesmo caminho: quem confirma é o Asaas.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { trocarFormaDePagamento } from "@/app/actions/settings/compraDoPlano";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { situacaoDoPedido } from "@/lib/onboarding/situacao-do-pedido";

import { urlDeRedirecionamentoEhSegura } from "@/app/app/settings/plano/_logica-compra";
import { usePollDoPedido } from "@/app/app/settings/plano/_use-poll-pedido";

const INTERVALO_DE_NOVA_TENTATIVA_MS = 3_000;

export function AguardandoPagamento({
  pedidoId,
  statusInicial,
  metodo,
  urlDaCobranca,
}: {
  pedidoId: string;
  statusInicial: string;
  metodo: "CREDIT_CARD" | "PIX";
  urlDaCobranca: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const estado = usePollDoPedido(pedidoId, statusInicial);
  const status = estado.status ?? statusInicial;
  const situacao = situacaoDoPedido(status);
  const urlSegura = urlDaCobranca && urlDeRedirecionamentoEhSegura(urlDaCobranca) ? urlDaCobranca : null;
  const [confirmando, setConfirmando] = useState(false);
  const [trocando, iniciarTroca] = useTransition();
  const [erroDaTroca, setErroDaTroca] = useState<string | null>(null);

  /**
   * Saída de quem ficou preso aqui (Pix que não vai pagar, cartão que não concluiu): cancela o pedido aberto,
   * sem cobrança paga, e a página volta ao formulário. Se o pagamento já entrou, o servidor recusa e a frase
   * "em confirmação" aparece no lugar.
   */
  function trocar() {
    iniciarTroca(async () => {
      const r = await trocarFormaDePagamento();
      if (r.tipo === "erro") {
        setErroDaTroca(r.mensagem);
        setConfirmando(false);
        return;
      }
      setErroDaTroca(null);
      setConfirmando(false);
      router.refresh();
    });
  }

  useEffect(() => {
    if (situacao !== "confirmado") return;
    router.replace("/onboarding");
    const id = setInterval(() => router.replace("/onboarding"), INTERVALO_DE_NOVA_TENTATIVA_MS);
    return () => clearInterval(id);
  }, [situacao, router]);

  if (situacao === "confirmado") {
    return (
      <div data-testid="plano-confirmado" className="space-y-3 rounded-md border p-4">
        <Badge variant="success">{t("Pagamento confirmado")}</Badge>
        <p className="text-sm text-muted-foreground">{t("Ativando seu plano…")}</p>
      </div>
    );
  }

  if (situacao === "encerrado") {
    return (
      <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        <p>{t("Este pedido não está mais aguardando pagamento. Atualize a página ou fale com o suporte.")}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
          {t("Atualizar")}
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="plano-aguardando-pagamento" className="space-y-4 rounded-md border p-4">
      <Badge variant="info">{t("Aguardando o pagamento")}</Badge>
      <p className="text-sm text-muted-foreground">
        {metodo === "PIX"
          ? t("Pague o Pix para entrar no CRM. Assim que o pagamento for confirmado, esta tela segue sozinha.")
          : t("Conclua o pagamento no cartão para entrar no CRM. Assim que o Asaas confirmar, esta tela segue sozinha.")}
      </p>

      {urlSegura && (
        <Button asChild variant="outline" size="sm">
          <a href={urlSegura} target="_blank" rel="noopener noreferrer" data-testid="abrir-cobranca">
            {t("Abrir a cobrança para pagar")}
          </a>
        </Button>
      )}

      {estado.parou ? (
        <p className="text-sm text-muted-foreground">
          {t("Ainda não recebemos a confirmação. Atualize a página mais tarde.")}{" "}
          <button type="button" className="underline" onClick={() => router.refresh()}>
            {t("Atualizar")}
          </button>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{t("Aguardando a confirmação do pagamento.")}</p>
      )}

      <div className="space-y-2 border-t pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="trocar-forma-de-pagamento"
          disabled={trocando}
          onClick={() => setConfirmando(true)}
        >
          {t("Trocar forma de pagamento")}
        </Button>
        {erroDaTroca && (
          <p role="alert" data-testid="trocar-forma-de-pagamento-erro" className="text-sm text-destructive">
            {t(erroDaTroca)}
          </p>
        )}
      </div>

      <AlertDialog open={confirmando} onOpenChange={setConfirmando}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Trocar a forma de pagamento?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Cancelamos este pedido, que ainda não foi pago, e você escolhe de novo o plano e a forma de pagamento. Se você já pagou, não cancelamos: o pagamento está em confirmação.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={trocando}>{t("Voltar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="trocar-forma-de-pagamento-confirmar"
              disabled={trocando}
              onClick={(e) => {
                e.preventDefault();
                trocar();
              }}
            >
              {t("Trocar forma de pagamento")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
