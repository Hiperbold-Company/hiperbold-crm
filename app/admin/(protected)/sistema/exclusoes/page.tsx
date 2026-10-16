import Link from "next/link";
import { notFound } from "next/navigation";

import { listarExclusoes, type ExclusaoListada, type OrganizacaoParaProgramar } from "@/app/actions/admin/exclusoes";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

import { FormularioDeProgramar, ListaDeExclusoes } from "./_client";

export const metadata = { title: "Exclusão dos dados" };
export const dynamic = "force-dynamic";

/**
 * A exclusão dos dados das organizações (migration 0959, D-209). Irmã de `../reembolsos`, no mesmo molde: Server
 * Component que lê e um componente cliente (`./_client`) para programar, cancelar e excluir agora.
 *
 * `podeEscrever` só decide o que a tela MOSTRA. Cada ação de `app/actions/admin/exclusoes.ts` confere de novo
 * `requirePlatformAdmin()`, o escopo `full` e o MFA em dia, inclusive a leitura.
 */
export default async function ExclusoesPage() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  const { platformAdmin } = await requirePlatformAdmin();
  const podeEscrever = platformAdmin.scope === "full";
  const t = (texto: string) => traduzir(texto, usuario.idioma);

  let exclusoes: ExclusaoListada[] = [];
  let organizacoes: OrganizacaoParaProgramar[] = [];
  let erro: string | null = null;
  if (podeEscrever) {
    const r = await listarExclusoes();
    if (r.ok) {
      exclusoes = r.exclusoes;
      organizacoes = r.organizacoes;
    } else erro = r.error;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/admin/sistema" className="text-sm text-primary underline-offset-4 hover:underline">
          {t("Voltar para Comportamento da instalação")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Exclusão dos dados")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Depois que a assinatura de um cliente que pagou acaba (cancelada ou suspensa), os dados ficam guardados para exportação pelo prazo configurado (90 dias por padrão) e depois são excluídos. Contas com acesso concedido por você nunca entram sozinhas: você programa ou exclui à mão. Registros fiscais ficam 5 anos e a auditoria de acesso pelo prazo de retenção.",
          )}
        </p>
      </div>

      {!podeEscrever ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">{t("Seu acesso de suporte não permite ver as exclusões.")}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("Exclusões programadas")}</CardTitle>
            </CardHeader>
            <CardContent>
              {erro ? (
                <p className="text-sm text-destructive" role="alert">
                  {erro}
                </p>
              ) : (
                <ListaDeExclusoes exclusoes={exclusoes} />
              )}
            </CardContent>
          </Card>

          {!erro && (
            <Card>
              <CardHeader>
                <CardTitle>{t("Programar exclusão")}</CardTitle>
              </CardHeader>
              <CardContent>
                <FormularioDeProgramar organizacoes={organizacoes} />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
