"use client";

/**
 * Avisa antes de sair de uma tela de Configurações com mudança não salva.
 *
 * Três saídas, três mecanismos:
 *
 * - **Fechar a aba, recarregar, digitar outra URL**: `beforeunload`. O texto é
 *   do navegador; a tela só pede que ele pergunte.
 * - **Clicar num link do próprio produto** (menu lateral, outra configuração):
 *   o `next/link` navega sem descarregar a página, então o `beforeunload` não
 *   dispara. Um ouvinte em CAPTURA no `document` pega o clique antes do React,
 *   segura a navegação e pergunta pela confirmação do produto. Confirmou, o
 *   MESMO link é clicado de novo, já com o aviso liberado: quem navega é o
 *   próprio `<Link>`, com o `replace`, o `scroll` e o `prefetch` que ele
 *   declarou — o `<a>` do DOM não os carrega, então reproduzi-los por fora
 *   seria adivinhar. Se o link saiu da tela enquanto a pergunta estava aberta,
 *   não há a quem clicar: a saída vai por `router.push`, e aí `replace` e
 *   `scroll` voltam ao padrão (empilha no histórico e rola ao topo). É a
 *   limitação conhecida.
 * - **Voltar/Avançar do navegador**: `popstate`. Esse evento não é cancelável —
 *   quando ele chega, a URL já mudou. Um ouvinte em captura no `window` roda
 *   antes do roteador do Next (que ouve o mesmo evento sem captura), impede que
 *   ele troque a tela, desfaz a travessia com `history.go(-delta)` e pergunta.
 *   Confirmou, refaz com `history.go(delta)`; cancelou, fica onde está. O
 *   `delta` vem do evento `navigate` da Navigation API; sem ela, assume-se
 *   Voltar (`-1`), que é o caso comum — um Avançar nesses navegadores seria
 *   desfeito para o lado errado.
 *
 * O clique só é interceptado quando seria uma navegação comum nesta aba: botão
 * principal, sem Ctrl/Cmd/Shift/Alt, sem `target` de outra janela, sem
 * `download`, mesma origem, fora de `/api/` (download de arquivo, exportação:
 * não saem da tela) e para outra página (âncora `#` na mesma tela não sai de
 * lugar nenhum). O botão do meio dispara `auxclick`, não `click`.
 *
 * `liberarSaida()` desliga o aviso para uma saída que a própria tela provocou
 * (ex.: ir ao desafio do segundo fator no meio do salvar).
 *
 * Liberar — pela confirmação ou por `liberarSaida()` — vale por um instante
 * (`REARME_MS`): se a saída não aconteceu (a navegação falhou, o destino
 * devolveu para cá) e a tela continua montada com a mudança pendente, o aviso
 * volta a valer em vez de ficar desligado para sempre.
 */
import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { useConfirmar } from "@/components/ui/confirmar";
import { useT } from "@/hooks/i18n/useT";

/** Por quanto tempo uma saída liberada fica liberada. */
export const REARME_MS = 3000;

/** O pedaço da Navigation API que este aviso lê (ausente em navegador antigo e no jsdom). */
interface NavegacaoDoNavegador {
  currentEntry: { index: number } | null;
  addEventListener: (tipo: "navigate", ouvinte: (evento: EventoDeNavegacao) => void) => void;
  removeEventListener: (tipo: "navigate", ouvinte: (evento: EventoDeNavegacao) => void) => void;
}
interface EventoDeNavegacao {
  navigationType: string;
  destination: { index: number };
}

export function useAvisoDeSaidaSemSalvar(sujo: boolean): { liberarSaida: () => void } {
  const t = useT();
  const router = useRouter();
  const { confirmar } = useConfirmar();
  const liberado = useRef(false);
  const rearme = useRef<ReturnType<typeof setTimeout> | null>(null);

  // O que os ouvintes leem no momento do evento, sem re-registrar a cada render.
  const atual = useRef({ t, router, confirmar });
  useEffect(() => {
    atual.current = { t, router, confirmar };
  });

  const liberarPorUmInstante = useCallback(() => {
    liberado.current = true;
    if (rearme.current) clearTimeout(rearme.current);
    rearme.current = setTimeout(() => {
      rearme.current = null;
      liberado.current = false;
    }, REARME_MS);
  }, []);

  useEffect(
    () => () => {
      if (rearme.current) clearTimeout(rearme.current);
    },
    [],
  );

  useEffect(() => {
    if (!sujo) {
      liberado.current = false;
      if (rearme.current) {
        clearTimeout(rearme.current);
        rearme.current = null;
      }
      return;
    }

    function perguntarSeSai(): Promise<boolean> {
      const { t: traduzir, confirmar: perguntar } = atual.current;
      return perguntar({
        titulo: traduzir("Sair sem salvar?"),
        descricao: traduzir("As mudanças desta tela vão se perder."),
        confirmar: traduzir("Descartar e sair"),
        cancelar: traduzir("Continuar editando"),
        perigo: true,
      });
    }

    function aoDescarregar(evento: BeforeUnloadEvent) {
      if (liberado.current) return;
      evento.preventDefault();
      // Navegadores antigos só perguntam com `returnValue` preenchido.
      evento.returnValue = "";
    }

    function aoClicar(evento: MouseEvent) {
      if (liberado.current || evento.defaultPrevented) return;
      if (
        evento.button !== 0 ||
        evento.metaKey ||
        evento.ctrlKey ||
        evento.shiftKey ||
        evento.altKey
      )
        return;
      const alvo = evento.target instanceof Element ? evento.target.closest("a[href]") : null;
      if (!(alvo instanceof HTMLAnchorElement)) return;
      const janela = alvo.getAttribute("target");
      if (janela && janela !== "_self") return;
      if (alvo.hasAttribute("download")) return;

      let destino: URL;
      try {
        destino = new URL(alvo.href, window.location.href);
      } catch {
        return;
      }
      if (destino.origin !== window.location.origin) return;
      if (destino.pathname === "/api" || destino.pathname.startsWith("/api/")) return;
      const aqui = window.location;
      if (destino.pathname === aqui.pathname && destino.search === aqui.search) return;

      // Antes de qualquer `await`: o clique tem de parar aqui, e o `next/link`
      // não pode receber o evento.
      evento.preventDefault();
      evento.stopPropagation();

      const href = destino.pathname + destino.search + destino.hash;
      void perguntarSeSai().then((sair) => {
        if (!sair) return;
        liberarPorUmInstante();
        if (alvo.isConnected) {
          // O próprio link navega, com as opções que declarou (ver o topo).
          alvo.click();
          return;
        }
        atual.current.router.push(href);
      });
    }

    // ── Voltar/Avançar ────────────────────────────────────────────────────
    let enderecoDaTela = window.location.pathname + window.location.search;
    const navegacao = (window as unknown as { navigation?: NavegacaoDoNavegador }).navigation;
    let deltaDaTravessia: number | null = null;
    let desfazendo = false;
    let perguntando = false;

    function aoNavegar(evento: EventoDeNavegacao) {
      if (evento.navigationType !== "traverse") return;
      // Antes da travessia o `location` ainda é o da tela: guarda-o, para uma
      // troca de busca sem entrada nova (`router.replace`) não fazer o nosso
      // próprio desfazer parecer saída e entrar em vaivém.
      if (!desfazendo) enderecoDaTela = window.location.pathname + window.location.search;
      const de = navegacao?.currentEntry?.index;
      if (typeof de !== "number" || de < 0 || evento.destination.index < 0) return;
      deltaDaTravessia = evento.destination.index - de;
    }

    function aoVoltarOuAvancar(evento: PopStateEvent) {
      const delta = deltaDaTravessia ?? -1;
      deltaDaTravessia = null;
      const destino = window.location.pathname + window.location.search;
      if (destino === enderecoDaTela) {
        // Âncora na mesma tela, ou o nosso próprio desfazer chegando: nada sai
        // da tela. O desfazer não vai ao roteador, que restauraria a árvore
        // guardada nessa entrada por cima da tela que está aberta.
        if (desfazendo) {
          desfazendo = false;
          evento.stopImmediatePropagation();
        }
        return;
      }
      if (liberado.current) return;

      evento.stopImmediatePropagation();
      if (delta === 0) return;
      desfazendo = true;
      window.history.go(-delta);
      if (perguntando) return;
      perguntando = true;
      void perguntarSeSai().then((sair) => {
        perguntando = false;
        if (!sair) return;
        desfazendo = false;
        liberarPorUmInstante();
        window.history.go(delta);
      });
    }

    window.addEventListener("beforeunload", aoDescarregar);
    window.addEventListener("popstate", aoVoltarOuAvancar, true);
    navegacao?.addEventListener("navigate", aoNavegar);
    document.addEventListener("click", aoClicar, true);
    return () => {
      window.removeEventListener("beforeunload", aoDescarregar);
      window.removeEventListener("popstate", aoVoltarOuAvancar, true);
      navegacao?.removeEventListener("navigate", aoNavegar);
      document.removeEventListener("click", aoClicar, true);
    };
  }, [sujo, liberarPorUmInstante]);

  return { liberarSaida: liberarPorUmInstante };
}
