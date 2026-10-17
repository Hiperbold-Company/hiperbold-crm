"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { resolverPedidoDeReembolso, type PedidoDeReembolsoListado } from "@/app/actions/admin/reembolsos";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoMotivo } from "@/lib/billing/reembolso/motivos";
import { formatCentsBRL } from "@/lib/money";

/**
 * A lista de pedidos de reembolso (migration 0957): os pendentes primeiro, com a empresa, o valor, a data do
 * pagamento, se estava dentro dos 7 dias, o motivo do cancelamento, o link da cobrança no Asaas e as duas saídas
 * manuais: recusar, ou marcar como concluído (reembolso feito fora do fluxo). O normal é o `concluido` vir
 * sozinho do webhook do Asaas. A frase de erro vem pronta da ação e vai direto ao toast, sem passar por `t()`.
 */
export function ListaDePedidosDeReembolso({ pedidos }: { pedidos: PedidoDeReembolsoListado[] }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();

  if (pedidos.length === 0) {
    return <p className="text-sm text-text-muted">{t("Nenhum pedido de reembolso.")}</p>;
  }

  const data = (iso: string) => new Date(iso).toLocaleDateString(tagDoIdioma, { timeZone: "America/Sao_Paulo" });
  const rotuloDoStatus: Record<PedidoDeReembolsoListado["status"], string> = {
    pendente: t("Pendente"),
    concluido: t("Concluído"),
    recusado: t("Recusado"),
  };
  const varianteDoStatus = { pendente: "warning", concluido: "success", recusado: "neutral" } as const;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("Empresa")}</TableHead>
          <TableHead>{t("Valor")}</TableHead>
          <TableHead>{t("Pagamento")}</TableHead>
          <TableHead>{t("Dentro dos 7 dias")}</TableHead>
          <TableHead>{t("Motivo")}</TableHead>
          <TableHead>{t("Pedido em")}</TableHead>
          <TableHead>{t("Situação")}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {pedidos.map((p) => (
          <TableRow key={p.id} data-testid={`reembolso-${p.id}`}>
            <TableCell>
              <span className="font-medium">{p.empresa}</span>
              {p.detalhe && <span className="block max-w-xs text-xs text-text-muted">{p.detalhe}</span>}
            </TableCell>
            <TableCell>
              {formatCentsBRL(p.amountCents)}
              {p.pacote && (
                <span className="block text-xs text-text-muted" data-testid={`reembolso-pacote-${p.id}`}>
                  {t("Pacote de tokens")}
                  {p.pacote.tokensDoPacote !== null && <>: {p.pacote.tokensDoPacote.toLocaleString("pt-BR")}</>}
                  {p.pacote.consumidoAvulso !== null && p.pacote.creditadoAvulso !== null ? (
                    <>
                      {" · "}
                      {t("consumido")} {p.pacote.consumidoAvulso.toLocaleString("pt-BR")} {t("de")}{" "}
                      {p.pacote.creditadoAvulso.toLocaleString("pt-BR")}
                    </>
                  ) : (
                    <> · {t("consumo indisponível")}</>
                  )}
                </span>
              )}
            </TableCell>
            <TableCell>
              {data(p.paidAt)}
              {p.linkDoAsaas && (
                <a
                  className="block text-xs text-primary underline-offset-4 hover:underline"
                  href={p.linkDoAsaas}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("Abrir no Asaas")}
                </a>
              )}
            </TableCell>
            <TableCell>{p.dentro7Dias ? t("Sim") : t("Não")}</TableCell>
            <TableCell>{t(rotuloDoMotivo(p.motivo))}</TableCell>
            <TableCell>{data(p.createdAt)}</TableCell>
            <TableCell>
              <Badge variant={varianteDoStatus[p.status]}>{rotuloDoStatus[p.status]}</Badge>
              {p.resolvedAt && <span className="block text-xs text-text-muted">{data(p.resolvedAt)}</span>}
            </TableCell>
            <TableCell>{p.status === "pendente" && <AcoesDoPedido pedido={p} />}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type Acao = "recusado" | "concluido";

export function AcoesDoPedido({ pedido }: { pedido: PedidoDeReembolsoListado }) {
  const t = useT();
  const router = useRouter();
  const [acao, setAcao] = useState<Acao | null>(null);
  const [pendente, iniciar] = useTransition();

  function confirmar() {
    if (!acao) return;
    iniciar(async () => {
      const r = await resolverPedidoDeReembolso({ pedidoId: pedido.id, status: acao });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(t("Pedido atualizado."));
      setAcao(null);
      router.refresh();
    });
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          data-testid={`concluir-reembolso-${pedido.id}`}
          disabled={pendente}
          onClick={() => setAcao("concluido")}
        >
          {t("Marcar como concluído")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid={`recusar-reembolso-${pedido.id}`}
          disabled={pendente}
          onClick={() => setAcao("recusado")}
        >
          {t("Recusar")}
        </Button>
      </div>

      <AlertDialog open={acao !== null} onOpenChange={(aberto) => !aberto && setAcao(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {acao === "recusado" ? t("Recusar o pedido de reembolso?") : t("Marcar o pedido como concluído?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {acao === "recusado"
                ? t("O pedido fica como recusado. O cliente não recebe aviso por aqui.")
                : t("Use quando o reembolso foi feito fora do fluxo. Quando o Asaas avisa o estorno, o pedido fecha sozinho.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendente}>{t("Voltar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid={`confirmar-reembolso-${pedido.id}`}
              disabled={pendente}
              onClick={(e) => {
                e.preventDefault();
                confirmar();
              }}
            >
              {t("Confirmar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
