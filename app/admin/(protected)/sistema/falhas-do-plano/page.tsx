import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { loadAuthUser } from "@/lib/auth/server";
import { falhasDoGatilhoDePlano } from "@/lib/billing/alarmes-de-gatilho";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Falhas na contagem do plano" };
export const dynamic = "force-dynamic";

/**
 * D-074: a tela de `billing_trigger_alarmes`. Quando o gatilho que soma os
 * leads do plano falha, o lead entra assim mesmo e a falha fica gravada; até
 * aqui ela só era vista por SQL. Só leitura, do mais novo para o mais velho,
 * 50 por página.
 *
 * A guarda é a mesma das irmãs (`../cobranca`, `../exclusoes`): o layout de
 * `(protected)` roda `requirePlatformAdmin()`, e a página confere de novo
 * `is_platform_admin` antes de abrir o client de serviço (a tabela não tem
 * policy: só o `service_role` a lê, e ela tem dados de todas as organizações).
 * O suporte só-leitura vê, como em Cobrança: não há ação nenhuma aqui.
 */

const FUSO_SP = "America/Sao_Paulo";

const PaginaSchema = z.coerce.number().int().min(1).max(10_000).catch(1);

/** Nome em português do gatilho que falhou; o nome técnico aparece se não houver tradução. */
const NOME_DO_GATILHO: Record<string, string> = {
  fn_billing_trava_crm_leads: "Contagem de leads abertos",
};

interface FalhasDoPlanoPageProps {
  searchParams: Promise<{ pagina?: string }>;
}

export default async function FalhasDoPlanoPage({ searchParams }: FalhasDoPlanoPageProps) {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  const { pagina: paginaCrua } = await searchParams;
  const pagina = PaginaSchema.parse(paginaCrua);
  const t = (texto: string) => traduzir(texto, usuario.idioma);
  const tagDoIdioma = tagDeIdioma(usuario.idioma);

  const resultado = await falhasDoGatilhoDePlano(createAdminClient(), pagina);
  const formatarData = (iso: string) => new Date(iso).toLocaleString(tagDoIdioma, { timeZone: FUSO_SP });
  const nomeDoGatilho = (g: string) => (NOME_DO_GATILHO[g] ? t(NOME_DO_GATILHO[g]) : g);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/admin/sistema" className="text-sm text-primary underline-offset-4 hover:underline">
          {t("Voltar para Comportamento da instalação")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Falhas na contagem do plano")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Quando o sistema não consegue somar um lead novo ao limite do plano de uma empresa, o lead entra normalmente e a falha fica anotada aqui. A conferência diária corrige a conta no dia seguinte. As anotações com mais de 90 dias são apagadas sozinhas.",
          )}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("Falhas registradas")}</CardTitle>
          <CardDescription>{t("Da mais nova para a mais antiga.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {resultado.leituraFalhou ? (
            <p className="text-sm text-destructive" role="alert">
              {t("Não foi possível ler as falhas agora.")}
            </p>
          ) : resultado.falhas.length === 0 ? (
            <p className="text-sm text-text-muted">
              {pagina > 1 ? t("Não há mais falhas nesta página.") : t("Nenhuma falha registrada.")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Quando")}</TableHead>
                  <TableHead>{t("Organização")}</TableHead>
                  <TableHead>{t("O que falhou")}</TableHead>
                  <TableHead>{t("Mensagem do banco")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resultado.falhas.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="whitespace-nowrap">{formatarData(f.criadoEm)}</TableCell>
                    <TableCell>
                      <Link
                        className="text-primary underline-offset-4 hover:underline"
                        href={`/admin/tenants/${f.organizationId}/plano`}
                      >
                        {f.organizacaoNome ?? f.organizationId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>{nomeDoGatilho(f.gatilho)}</TableCell>
                    <TableCell className="max-w-md break-words font-mono text-xs">{f.falha}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {!resultado.leituraFalhou && (pagina > 1 || resultado.temMais) && (
            <nav className="flex items-center gap-4 text-sm" aria-label={t("Páginas")}>
              {pagina > 1 && (
                <Link
                  className="text-primary underline-offset-4 hover:underline"
                  href={`/admin/sistema/falhas-do-plano?pagina=${pagina - 1}`}
                >
                  {t("Anterior")}
                </Link>
              )}
              <span className="text-text-muted">
                {t("Página")} {pagina}
              </span>
              {resultado.temMais && (
                <Link
                  className="text-primary underline-offset-4 hover:underline"
                  href={`/admin/sistema/falhas-do-plano?pagina=${pagina + 1}`}
                >
                  {t("Próxima")}
                </Link>
              )}
            </nav>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
