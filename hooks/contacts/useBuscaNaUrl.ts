"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A caixa de busca ↔ a URL, sem nunca atropelar o que a pessoa está digitando.
 *
 * O texto da caixa é estado LOCAL (a fonte enquanto se digita). Depois de `atrasoMs` sem digitar,
 * o valor vai para a URL (`aplicar`). O `router.replace` é assíncrono: a URL devolve valores
 * ANTIGOS depois que a pessoa já digitou mais, e uma versão ingênua que copia "URL → caixa" a cada
 * mudança reescreveria "abc" para "ab" no meio da digitação. Por isso cada valor que ESTE hook
 * enviou fica numa fila (`enviados`): quando a URL volta com um deles, é eco do próprio envio e a
 * caixa não é tocada. Só um valor que o hook nunca enviou (botão voltar, link colado, "Limpar
 * filtros") é mudança de fora, e esse sim reescreve a caixa.
 */
export function useBuscaNaUrl(
  buscaDaUrl: string,
  aplicar: (texto: string) => void,
  atrasoMs = 250,
): { texto: string; setTexto: (v: string) => void; limpar: () => void } {
  const [texto, setTextoLocal] = useState(buscaDaUrl);
  const textoAtual = useRef(buscaDaUrl);
  const ultimoEnviado = useRef(buscaDaUrl);
  const enviados = useRef<string[]>([]);
  const aplicarRef = useRef(aplicar);
  useEffect(() => {
    aplicarRef.current = aplicar;
  });

  const setTexto = useCallback((v: string) => {
    textoAtual.current = v;
    setTextoLocal(v);
  }, []);

  // Digitar → URL (depois de uma pausa).
  useEffect(() => {
    const timer = setTimeout(() => {
      const limpo = texto.trim();
      if (limpo === ultimoEnviado.current) return;
      ultimoEnviado.current = limpo;
      enviados.current.push(limpo);
      aplicarRef.current(limpo);
    }, atrasoMs);
    return () => clearTimeout(timer);
  }, [texto, atrasoMs]);

  // URL → caixa: só o que NÃO foi este hook quem mandou.
  useEffect(() => {
    const idx = enviados.current.indexOf(buscaDaUrl);
    if (idx >= 0) {
      enviados.current.splice(0, idx + 1);
      return;
    }
    if (buscaDaUrl === textoAtual.current.trim()) return;
    enviados.current = [];
    ultimoEnviado.current = buscaDaUrl;
    textoAtual.current = buscaDaUrl;
    setTextoLocal(buscaDaUrl);
  }, [buscaDaUrl]);

  /** "Limpar filtros": o chamador zera a URL; aqui zera a caixa sem esperar o eco. */
  const limpar = useCallback(() => {
    enviados.current = [];
    ultimoEnviado.current = "";
    textoAtual.current = "";
    setTextoLocal("");
  }, []);

  return { texto, setTexto, limpar };
}
