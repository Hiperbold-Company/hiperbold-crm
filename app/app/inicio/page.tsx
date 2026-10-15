/**
 * Início — o que já está feito e o que falta para o CRM trabalhar pela empresa.
 *
 * Com a compra pelo cliente ligada, `/app` abre aqui enquanto faltar algum passo obrigatório (ver
 * `lib/inicio/entrada.ts`); depois, abre no Inbox, e esta tela segue no menu. A lista é calculada
 * no servidor por `primeirosPassos` (`lib/inicio/primeiros-passos.ts`, função pura) a partir do que
 * `carregarDadosDosPrimeirosPassos` lê da organização ATIVA.
 *
 * Gate: administrador. Os passos levam a telas de administração, e quem não administra não tem o
 * que fazer aqui.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ReenviarConfirmacaoBotao } from "@/components/auth/ReenviarConfirmacaoBotao";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { carregarPrimeirosPassos } from "@/lib/inicio/carregar";
import type { PassoDoInicio } from "@/lib/inicio/primeiros-passos";
import { createAdminClient } from "@/lib/supabase/admin";
import { ArrowRight, CheckCircle } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Início" };

export default async function InicioPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  const { passos, contagem } = await carregarPrimeirosPassos(createAdminClient(), activeOrg.orgId, user.id);

  const obrigatorios = passos.filter((p) => p.tipo === "obrigatorio");
  const opcionais = passos.filter((p) => p.tipo === "opcional");
  const pronto = contagem.obrigatoriosFaltando === 0;
  const percentual = Math.round((contagem.obrigatoriosFeitos / Math.max(contagem.obrigatoriosTotal, 1)) * 100);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Início")}</h1>
        <p className="text-sm text-muted-foreground">
          {pronto
            ? t("O essencial está pronto. Os passos abaixo deixam o CRM ainda melhor para a sua equipe.")
            : t("Faltam poucos passos para o CRM começar a trabalhar pela sua empresa.")}
        </p>
        <div className="space-y-1.5">
          <p className="text-sm font-medium" data-testid="inicio-progresso">
            {contagem.obrigatoriosFeitos} {t("de")} {contagem.obrigatoriosTotal} {t("obrigatórios")}
          </p>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={contagem.obrigatoriosTotal}
            aria-valuenow={contagem.obrigatoriosFeitos}
            aria-label={t("Passos obrigatórios concluídos")}
            className="h-2 w-full overflow-hidden rounded-full bg-surface-elevated"
          >
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percentual}%` }} />
          </div>
        </div>
      </header>

      <section aria-labelledby="inicio-obrigatorios" className="space-y-3">
        <h2 id="inicio-obrigatorios" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("Obrigatórios")}
        </h2>
        <ul className="space-y-3">
          {obrigatorios.map((passo) => (
            <CartaoDoPasso key={passo.id} passo={passo} t={t} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="inicio-opcionais" className="space-y-3">
        <h2 id="inicio-opcionais" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("Opcionais")}
        </h2>
        <ul className="space-y-3">
          {opcionais.map((passo) => (
            <CartaoDoPasso key={passo.id} passo={passo} t={t} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function CartaoDoPasso({ passo, t }: { passo: PassoDoInicio; t: (texto: string) => string }) {
  return (
    <li data-testid={`inicio-passo-${passo.id}`} data-feito={passo.feito ? "sim" : "nao"}>
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className={cn(
              "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border",
              passo.feito ? "border-transparent bg-success-bg text-success-fg" : "border-border text-transparent",
            )}
          >
            {passo.feito ? <CheckCircle className="size-5" weight="fill" /> : null}
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">{t(passo.titulo)}</h3>
              <Badge variant={passo.feito ? "success" : passo.tipo === "obrigatorio" ? "warning" : "neutral"}>
                {passo.feito ? t("Feito") : passo.tipo === "obrigatorio" ? t("Falta fazer") : t("Opcional")}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{t(passo.descricao)}</p>
          </div>
        </div>
        {passo.id === "email" && !passo.feito ? (
          // "Confirmar e-mail" pendente: o reenvio mora AQUI. O perfil (href do passo) não tem botão de reenvio,
          // e mandar a pessoa para uma tela onde nada se resolve seria um beco sem saída.
          <div className="w-full shrink-0 self-start sm:w-56 sm:self-center" data-testid="inicio-passo-email-reenviar">
            <ReenviarConfirmacaoBotao />
          </div>
        ) : (
          <Button asChild variant={passo.feito ? "outline" : "primary"} size="sm" className="shrink-0 self-start sm:self-center">
            <Link href={passo.href}>
              {t(passo.cta)}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        )}
      </Card>
    </li>
  );
}
