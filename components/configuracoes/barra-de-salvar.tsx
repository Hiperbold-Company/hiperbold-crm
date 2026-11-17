"use client";

/**
 * A barra de salvar das telas de Configurações: UMA por tela, no rodapé da área
 * de conteúdo, no lugar dos botões Salvar espalhados pelos cartões.
 *
 * Só aparece quando há o que salvar (`sujo`), enquanto salva, ou quando a última
 * tentativa falhou. Em erro ela diz que as mudanças continuam na tela e oferece
 * "Tentar de novo" — nunca some levando a edição junto.
 *
 * ── Por que `sticky`, e não `fixed` ──────────────────────────────────────────
 * Presa ao fundo do container que rola, a barra continua ocupando o seu lugar
 * no fluxo da página: quando aparece, empurra o fim do conteúdo para cima em
 * vez de cobri-lo. É o mesmo efeito do `padding-bottom` que um `fixed` exigiria,
 * sem depender de a página saber a altura da barra. E fica dentro da área de
 * conteúdo, sem passar por cima do menu lateral.
 *
 * Quem decide `sujo`, `salvando` e `erro` é o formulário (ou o grupo, em
 * `grupo-de-salvar.tsx`). Esta peça só desenha.
 */
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

export interface PropsDaBarraDeSalvar {
  sujo: boolean;
  salvando?: boolean;
  erro?: boolean;
  /** `false` desliga o Salvar (campo inválido, token que falta). */
  podeSalvar?: boolean;
  /** Frase curta que explica por que o Salvar está desligado. */
  aviso?: string | null;
  onDescartar: () => void;
  /**
   * Sem `onSalvar`, o Salvar é `type="submit"`: a barra mora dentro do
   * `<form>` (ou aponta para ele por `formulario`) e o `onSubmit` do formulário
   * continua sendo o caminho único — Enter num campo e o clique fazem o mesmo.
   */
  onSalvar?: () => void;
  /** `id` do `<form>` quando a barra fica fora dele. */
  formulario?: string;
  className?: string;
}

export function BarraDeSalvar({
  sujo,
  salvando = false,
  erro = false,
  podeSalvar = true,
  aviso,
  onDescartar,
  onSalvar,
  formulario,
  className,
}: PropsDaBarraDeSalvar) {
  const t = useT();
  if (!sujo && !salvando && !erro) return null;

  const tipo = onSalvar ? "button" : "submit";
  const rotuloDoSalvar = salvando ? t("Salvando…") : erro ? t("Tentar de novo") : t("Salvar");

  return (
    <div
      role="region"
      aria-label={t("Alterações não salvas")}
      data-testid="barra-de-salvar"
      data-estado={salvando ? "salvando" : erro ? "erro" : "sujo"}
      className={cn("sticky bottom-0 z-10 pt-2 pb-4 sm:bottom-4 sm:pb-0", className)}
    >
      <div
        role={erro ? "alert" : undefined}
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-lg border py-3 pr-3 pl-5 shadow-lg",
          erro
            ? "border-error bg-error-bg text-error-fg"
            : "border-border-strong bg-surface text-text",
        )}
      >
        <div className="flex min-w-0 flex-[1_1_16rem] flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
          {erro ? (
            <>
              <span className="font-semibold">{t("Não consegui salvar.")}</span>
              <span>{t("Suas mudanças continuam aqui. Tente de novo.")}</span>
            </>
          ) : (
            <>
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />
              <span className="font-semibold">{t("Alterações não salvas")}</span>
              {aviso && !podeSalvar ? <span className="text-muted-foreground">{aviso}</span> : null}
            </>
          )}
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button
            type="button"
            variant="ghost"
            className="flex-1 sm:flex-none"
            disabled={salvando}
            onClick={onDescartar}
          >
            {t("Descartar")}
          </Button>
          <Button
            type={tipo}
            form={tipo === "submit" ? formulario : undefined}
            className="flex-1 sm:flex-none"
            disabled={salvando || !podeSalvar}
            onClick={onSalvar}
          >
            {rotuloDoSalvar}
          </Button>
        </div>
      </div>
    </div>
  );
}
