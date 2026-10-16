import Link from "next/link";
import { notFound } from "next/navigation";

import {
  listarMotivosDeCancelamento,
  listarPedidosDeReembolso,
  type MotivoDeCancelamentoListado,
  type PedidoDeReembolsoListado,
} from "@/app/actions/admin/reembolsos";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { loadAuthUser } from "@/lib/auth/server";
import { rotuloDoMotivo } from "@/lib/billing/reembolso/motivos";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";

import { ListaDePedidosDeReembolso } from "./_client";

export const metadata = { title: "Reembolsos e cancelamentos" };
export const dynamic = "force-dynamic";

/**
 * Os pedidos de reembolso e os motivos de cancelamento (migration 0957, fork Hiperbold). Irmã de `../cupons`, no
 * mesmo molde: Server Component que lê, e um componente cliente (`./_client`) só para recusar e marcar como
 * concluído. Quem avisa que há pedido novo é o e-mail ao financeiro (`EMAIL_DO_FINANCEIRO`).
 *
 * ─── Onde mora a barreira de verdade ────────────────────────────────────────
 *
 * `podeEscrever` só decide o que a tela MOSTRA. Cada ação de `app/actions/admin/reembolsos.ts` confere de novo
 * `requirePlatformAdmin()`, o escopo `full` e o MFA em dia, inclusive a leitura: o suporte só leitura nem vê
 * a lista. Esconder o botão é conveniência, não segurança.
 */
export default async function ReembolsosPage() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  const { platformAdmin } = await requirePlatformAdmin();
  const podeEscrever = platformAdmin.scope === "full";
  const t = (texto: string) => traduzir(texto, usuario.idioma);
  const tagDoIdioma = tagDeIdioma(usuario.idioma);

  let pedidos: PedidoDeReembolsoListado[] = [];
  let motivos: MotivoDeCancelamentoListado[] = [];
  let erroDosPedidos: string | null = null;
  let erroDosMotivos: string | null = null;

  if (podeEscrever) {
    const [listaDePedidos, listaDeMotivos] = await Promise.all([
      listarPedidosDeReembolso(),
      listarMotivosDeCancelamento(),
    ]);
    if (listaDePedidos.ok) pedidos = listaDePedidos.pedidos;
    else erroDosPedidos = listaDePedidos.error;
    if (listaDeMotivos.ok) motivos = listaDeMotivos.motivos;
    else erroDosMotivos = listaDeMotivos.error;
  }

  const data = (iso: string) => new Date(iso).toLocaleDateString(tagDoIdioma, { timeZone: "America/Sao_Paulo" });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/admin/sistema" className="text-sm text-primary underline-offset-4 hover:underline">
          {t("Voltar para Comportamento da instalação")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Reembolsos e cancelamentos")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "O cliente só pede reembolso depois de cancelar, do pagamento mais recente e até 7 dias depois dele. O reembolso é feito no Asaas; quando o Asaas avisa o estorno, o pedido fecha sozinho.",
          )}
        </p>
      </div>

      {!podeEscrever ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              {t("Seu acesso de suporte não permite ver os pedidos de reembolso.")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("Pedidos de reembolso")}</CardTitle>
            </CardHeader>
            <CardContent>
              {erroDosPedidos ? (
                <p className="text-sm text-destructive" role="alert">
                  {erroDosPedidos}
                </p>
              ) : (
                <ListaDePedidosDeReembolso pedidos={pedidos} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("Motivos de cancelamento")}</CardTitle>
            </CardHeader>
            <CardContent>
              {erroDosMotivos ? (
                <p className="text-sm text-destructive" role="alert">
                  {erroDosMotivos}
                </p>
              ) : motivos.length === 0 ? (
                <p className="text-sm text-text-muted">{t("Nenhum cancelamento com motivo ainda.")}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Empresa")}</TableHead>
                      <TableHead>{t("Motivo")}</TableHead>
                      <TableHead>{t("Detalhe")}</TableHead>
                      <TableHead>{t("Data")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {motivos.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-medium">{m.empresa}</TableCell>
                        <TableCell>{t(rotuloDoMotivo(m.motivo))}</TableCell>
                        <TableCell className="max-w-md text-sm text-text-muted">{m.detalhe ?? "-"}</TableCell>
                        <TableCell>{data(m.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
