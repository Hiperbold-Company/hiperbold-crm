"use client";

/**
 * O Início depois que os passos obrigatórios estão cumpridos: o painel de indicadores ocupa a área
 * principal e o checklist vai para uma barra lateral à direita. Um botão Exibir/Esconder mostra e
 * recolhe a barra.
 *
 * - Computador: a barra fica ao lado; a escolha é lembrada POR PESSOA (localStorage, com o id da
 *   pessoa na chave: dois usuários no mesmo navegador não herdam a escolha um do outro).
 * - Celular: a barra vira uma gaveta por cima da tela, aberta pelo mesmo botão e sempre fechada ao
 *   entrar (aberta por padrão ela cobriria o painel inteiro). A gaveta não é lembrada.
 *
 * Quem decide o que aparece é o CSS (`lg:`), então o HTML do servidor já sai certo nos dois tamanhos;
 * o estado de JS só diz a qual das duas escolhas o botão se refere. O localStorage fica em try/catch:
 * navegação privada ou armazenamento bloqueado lançam, e o Início não pode cair por isso.
 */
import { useEffect, useState } from "react";

import { LinkDeAjudaDaTela } from "@/components/ajuda/LinkDeAjudaDaTela";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import type { ContagemDosPassos, PassoDoInicio } from "@/lib/inicio/primeiros-passos";
import { X } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { ChecklistDoInicio } from "./ChecklistDoInicio";
import { PainelDoInicio } from "./PainelDoInicio";

const CHAVE = "inicio-checklist-escondido";
const QUERY_DESKTOP = "(min-width: 1024px)";

function lerEscondido(): boolean {
  try {
    return window.localStorage.getItem(CHAVE) === "1";
  } catch {
    return false;
  }
}

function gravarEscondido(escondido: boolean) {
  try {
    if (escondido) window.localStorage.setItem(CHAVE, "1");
    else window.localStorage.removeItem(CHAVE);
  } catch {
    // Sem armazenamento a escolha vale só nesta visita.
  }
}

export function InicioComPainel({
  passos,
  contagem,
  userId,
}: {
  passos: PassoDoInicio[];
  contagem: ContagemDosPassos;
  userId: string;
}) {
  const t = useT();
  const [escondido, setEscondido] = useState(false);
  const [gaveta, setGaveta] = useState(false);
  const [desktop, setDesktop] = useState(true);

  // Depois de montar: o servidor não conhece o localStorage nem a largura da janela.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ler o localStorage só é possível depois de montar
    setEscondido(lerEscondido());
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY_DESKTOP);
    const aplicar = () => setDesktop(mq.matches);
    aplicar();
    mq.addEventListener("change", aplicar);
    return () => mq.removeEventListener("change", aplicar);
  }, []);

  const visivel = desktop ? !escondido : gaveta;
  const alternar = () => {
    if (desktop) {
      const proximo = !escondido;
      setEscondido(proximo);
      gravarEscondido(proximo);
    } else {
      setGaveta((g) => !g);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-screen-2xl min-w-0 flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Início")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("O essencial está pronto. Os primeiros passos que faltam deixam o CRM ainda melhor para a sua equipe.")}
          </p>
          <LinkDeAjudaDaTela />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={alternar}
          aria-expanded={visivel}
          aria-controls="inicio-barra-lateral"
          data-testid="inicio-alternar-checklist"
        >
          {visivel ? t("Esconder checklist") : t("Exibir checklist")}
        </Button>
      </header>

      <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <PainelDoInicio currentUserId={userId} />
        </div>

        {/* Gaveta no celular: fundo que fecha ao toque. Some no computador. */}
        {gaveta ? (
          <button
            type="button"
            aria-label={t("Fechar")}
            tabIndex={-1}
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            onClick={() => setGaveta(false)}
          />
        ) : null}
        <aside
          id="inicio-barra-lateral"
          aria-label={t("Primeiros passos")}
          data-testid="inicio-barra-lateral"
          data-visivel={visivel ? "sim" : "nao"}
          className={cn(
            // Celular: gaveta fixa à direita, nunca mais larga que a tela.
            "fixed inset-y-0 right-0 z-40 w-[min(22rem,100vw)] max-w-full overflow-y-auto border-l bg-background p-4 shadow-xl",
            !gaveta && "max-lg:hidden",
            // Computador: coluna ao lado do painel.
            "lg:static lg:z-auto lg:w-96 lg:max-w-none lg:shrink-0 lg:border-l-0 lg:bg-transparent lg:p-0 lg:shadow-none",
            escondido && "lg:hidden",
          )}
        >
          <div className="mb-3 flex items-center justify-between lg:hidden">
            <h2 className="text-sm font-semibold">{t("Primeiros passos")}</h2>
            <Button type="button" variant="ghost" size="sm" aria-label={t("Fechar")} onClick={() => setGaveta(false)}>
              <X aria-hidden="true" />
            </Button>
          </div>
          <ChecklistDoInicio passos={passos} contagem={contagem} />
        </aside>
      </div>
    </div>
  );
}
