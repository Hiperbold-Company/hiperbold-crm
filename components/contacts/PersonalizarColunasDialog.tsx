"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useColunasDeContatos } from "@/hooks/contacts/useColunasDeContatos";
import { useT } from "@/hooks/i18n/useT";
import {
  COLUNAS_DO_SISTEMA,
  MAXIMO_DE_COLUNAS,
  PREFIXO_DE_CAMPO,
  colunaValida,
  ehColunaFixa,
  normalizarColunas,
} from "@/lib/contacts/colunas-da-lista";
import { ArrowDown, ArrowUp } from "@/lib/ui/icons";

/** Rótulo de uma coluna: as do sistema pelo catálogo; campo personalizado pelo rótulo do campo. */
export function rotuloDaColuna(
  id: string,
  camposDoContato: Array<{ key: string; label: string }>,
  t: (texto: string) => string,
): string {
  const doSistema = COLUNAS_DO_SISTEMA.find((c) => c.id === id);
  if (doSistema) return t(doSistema.rotulo);
  const chave = id.slice(PREFIXO_DE_CAMPO.length);
  return camposDoContato.find((c) => c.key === chave)?.label ?? chave;
}

/**
 * "Personalizar colunas": quais colunas a lista de Contatos mostra e em que ordem (setas), até
 * `MAXIMO_DE_COLUNAS`. Nome e ações ficam sempre. Salva no servidor, por usuário.
 */
export function PersonalizarColunasDialog({
  open,
  onOpenChange,
  camposDoContato,
}: {
  open: boolean;
  onOpenChange: (aberto: boolean) => void;
  /** Campos personalizados do contato (os mesmos que o filtro "Campo" oferece). */
  camposDoContato: Array<{ key: string; label: string }>;
}) {
  const t = useT();
  const { colunas, salvar, restaurar } = useColunasDeContatos();
  // Cada abertura parte do que está salvo: a tela só monta o painel aberto.
  const [rascunho, setRascunho] = useState<string[]>(colunas);


  const disponiveis = useMemo(
    () => [
      ...COLUNAS_DO_SISTEMA.filter((c) => !ehColunaFixa(c.id)).map((c) => c.id as string),
      ...camposDoContato.map((c) => `${PREFIXO_DE_CAMPO}${c.key}`).filter(colunaValida),
    ],
    [camposDoContato],
  );
  const cheio = rascunho.length >= MAXIMO_DE_COLUNAS;
  const rotulo = (id: string) => rotuloDaColuna(id, camposDoContato, t);

  function alternar(id: string) {
    setRascunho((atual) =>
      atual.includes(id)
        ? atual.filter((c) => c !== id)
        : normalizarColunas([...atual.filter((c) => c !== "acoes"), id]),
    );
  }

  function mover(id: string, passo: -1 | 1) {
    setRascunho((atual) => {
      const i = atual.indexOf(id);
      const j = i + passo;
      // Nome (primeira) e ações (última) não saem do lugar.
      if (i < 0 || j <= 0 || j >= atual.length - 1) return atual;
      const proxima = [...atual];
      [proxima[i], proxima[j]] = [proxima[j]!, proxima[i]!];
      return proxima;
    });
  }

  async function aplicar() {
    try {
      await salvar.mutateAsync(normalizarColunas(rascunho));
      toast.success(t("Colunas salvas."));
      onOpenChange(false);
    } catch {
      toast.error(t("Não foi possível salvar as colunas."));
    }
  }

  async function voltarAoPadrao() {
    try {
      await restaurar.mutateAsync();
      toast.success(t("Colunas restauradas ao padrão."));
      onOpenChange(false);
    } catch {
      toast.error(t("Não foi possível salvar as colunas."));
    }
  }

  const ocupado = salvar.isPending || restaurar.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Personalizar colunas")}</DialogTitle>
          <DialogDescription>
            {t("Escolha as colunas da lista e a ordem. Nome e ações ficam sempre.")}{" "}
            {rascunho.length}/{MAXIMO_DE_COLUNAS}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <section aria-labelledby="colunas-mostradas">
            <h3 id="colunas-mostradas" className="mb-1 text-xs font-medium">
              {t("Na lista, nesta ordem")}
            </h3>
            <ol className="max-h-80 space-y-1 overflow-y-auto" data-colunas-escolhidas>
              {rascunho.map((id, i) => {
                const fixa = ehColunaFixa(id);
                const ultimaMovel = i === rascunho.length - 2;
                return (
                  <li
                    key={id}
                    data-coluna={id}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm"
                  >
                    <span className="flex-1 truncate">{rotulo(id)}</span>
                    {fixa ? (
                      <span className="text-xs text-muted-foreground">{t("fixa")}</span>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={`${t("Subir")} ${rotulo(id)}`}
                          disabled={i <= 1}
                          onClick={() => mover(id, -1)}
                        >
                          <ArrowUp size={14} aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={`${t("Descer")} ${rotulo(id)}`}
                          disabled={ultimaMovel}
                          onClick={() => mover(id, 1)}
                        >
                          <ArrowDown size={14} aria-hidden />
                        </Button>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
          <section aria-labelledby="colunas-disponiveis">
            <h3 id="colunas-disponiveis" className="mb-1 text-xs font-medium">
              {t("Colunas disponíveis")}
            </h3>
            <div className="max-h-80 space-y-0.5 overflow-y-auto rounded-md border border-input p-1">
              {disponiveis.map((id) => {
                const marcada = rascunho.includes(id);
                return (
                  <label
                    key={id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={marcada}
                      disabled={!marcada && cheio}
                      onChange={() => alternar(id)}
                    />
                    <span className="truncate">{rotulo(id)}</span>
                    {id.startsWith(PREFIXO_DE_CAMPO) && (
                      <span className="ml-auto text-xs text-muted-foreground">{t("campo")}</span>
                    )}
                  </label>
                );
              })}
            </div>
            {cheio && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Limite de colunas atingido. Desmarque uma para escolher outra.")}
              </p>
            )}
          </section>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" disabled={ocupado} onClick={() => void voltarAoPadrao()}>
            {t("Restaurar padrão")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" disabled={ocupado} onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button disabled={ocupado} onClick={() => void aplicar()}>
              {salvar.isPending ? t("Salvando…") : t("Salvar")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
