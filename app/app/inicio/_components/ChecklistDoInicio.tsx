"use client";

/**
 * O checklist dos primeiros passos, desenhado igual nos dois estados do Início: sozinho na tela
 * (enquanto falta obrigatório) e na barra lateral do painel (depois que o essencial está pronto).
 * Só apresenta: a lista e a contagem chegam prontas de `primeirosPassos` (`lib/inicio/primeiros-passos.ts`).
 */
import Link from "next/link";

import { ReenviarConfirmacaoBotao } from "@/components/auth/ReenviarConfirmacaoBotao";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import type { ContagemDosPassos, PassoDoInicio } from "@/lib/inicio/primeiros-passos";
import { ArrowRight, CheckCircle } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

export function ProgressoDosPassos({ contagem }: { contagem: ContagemDosPassos }) {
  const t = useT();
  const percentual = Math.round((contagem.obrigatoriosFeitos / Math.max(contagem.obrigatoriosTotal, 1)) * 100);
  return (
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
  );
}

export function ListasDePassos({ passos }: { passos: PassoDoInicio[] }) {
  const t = useT();
  const obrigatorios = passos.filter((p) => p.tipo === "obrigatorio");
  const opcionais = passos.filter((p) => p.tipo === "opcional");
  return (
    <>
      <section aria-labelledby="inicio-obrigatorios" className="space-y-3">
        <h2 id="inicio-obrigatorios" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("Obrigatórios")}
        </h2>
        <ul className="space-y-3">
          {obrigatorios.map((passo) => (
            <CartaoDoPasso key={passo.id} passo={passo} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="inicio-opcionais" className="space-y-3">
        <h2 id="inicio-opcionais" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t("Opcionais")}
        </h2>
        <ul className="space-y-3">
          {opcionais.map((passo) => (
            <CartaoDoPasso key={passo.id} passo={passo} />
          ))}
        </ul>
      </section>
    </>
  );
}

/** Progresso + as duas listas, na ordem da barra lateral. */
export function ChecklistDoInicio({ passos, contagem }: { passos: PassoDoInicio[]; contagem: ContagemDosPassos }) {
  return (
    <div className="flex flex-col gap-6" data-testid="inicio-checklist">
      <ProgressoDosPassos contagem={contagem} />
      <ListasDePassos passos={passos} />
    </div>
  );
}

function CartaoDoPasso({ passo }: { passo: PassoDoInicio }) {
  const t = useT();
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
