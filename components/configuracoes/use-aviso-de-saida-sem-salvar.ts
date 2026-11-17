"use client";

/**
 * Avisa antes de sair de uma tela de Configurações com mudança não salva.
 *
 * Duas saídas, dois mecanismos:
 *
 * - **Fechar a aba, recarregar, digitar outra URL**: `beforeunload`. O texto é
 *   do navegador; a tela só pede que ele pergunte.
 * - **Clicar num link do próprio produto** (menu lateral, outra configuração):
 *   o `next/link` navega sem descarregar a página, então o `beforeunload` não
 *   dispara. Um ouvinte em CAPTURA no `document` pega o clique antes do React,
 *   segura a navegação e pergunta pela confirmação do produto. Confirmou, vai
 *   com `router.push`; cancelou, fica onde está.
 *
 * O clique só é interceptado quando seria uma navegação comum nesta aba: botão
 * principal, sem Ctrl/Cmd/Shift/Alt, sem `target` de outra janela, sem
 * `download`, mesma origem e para outra página (âncora `#` na mesma tela não
 * sai de lugar nenhum).
 *
 * `liberarSaida()` desliga o aviso para uma saída que a própria tela provocou
 * (ex.: ir ao desafio do segundo fator no meio do salvar).
 */
import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { useConfirmar } from "@/components/ui/confirmar";
import { useT } from "@/hooks/i18n/useT";

export function useAvisoDeSaidaSemSalvar(sujo: boolean): { liberarSaida: () => void } {
  const t = useT();
  const router = useRouter();
  const { confirmar } = useConfirmar();
  const liberado = useRef(false);

  // O que o ouvinte lê no momento do clique, sem re-registrar a cada render.
  const atual = useRef({ t, router, confirmar });
  useEffect(() => {
    atual.current = { t, router, confirmar };
  });

  useEffect(() => {
    if (!sujo) {
      liberado.current = false;
      return;
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
      const aqui = window.location;
      if (destino.pathname === aqui.pathname && destino.search === aqui.search) return;

      // Antes de qualquer `await`: o clique tem de parar aqui, e o `next/link`
      // não pode receber o evento.
      evento.preventDefault();
      evento.stopPropagation();

      const { t: traduzir, router: roteador, confirmar: perguntar } = atual.current;
      const href = destino.pathname + destino.search + destino.hash;
      void perguntar({
        titulo: traduzir("Sair sem salvar?"),
        descricao: traduzir("As mudanças desta tela vão se perder."),
        confirmar: traduzir("Descartar e sair"),
        cancelar: traduzir("Continuar editando"),
        perigo: true,
      }).then((sair) => {
        if (!sair) return;
        liberado.current = true;
        roteador.push(href);
      });
    }

    window.addEventListener("beforeunload", aoDescarregar);
    document.addEventListener("click", aoClicar, true);
    return () => {
      window.removeEventListener("beforeunload", aoDescarregar);
      document.removeEventListener("click", aoClicar, true);
    };
  }, [sujo]);

  const liberarSaida = useCallback(() => {
    liberado.current = true;
  }, []);

  return { liberarSaida };
}
