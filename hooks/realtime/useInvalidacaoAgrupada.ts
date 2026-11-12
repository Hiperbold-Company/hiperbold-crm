"use client";
import { hashKey, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { criarAgrupador, type Agrupador, type OpcoesDoAgrupador } from "@/lib/realtime/coalescer";

/**
 * Invalidação de query pedida pelo Realtime, AGRUPADA por chave
 * (`lib/realtime/coalescer.ts`): uma rajada de eventos vira uma invalidação
 * por chave por janela, em vez de um GET por evento.
 *
 * Ao desmontar, o que estava pendente só é MARCADO como velho
 * (`refetchType: "none"`): nada sai pela rede para uma tela que saiu, e quem
 * voltar a montar a query busca de novo.
 *
 * `opcoes` é lido uma vez, na montagem — passe uma constante do módulo.
 */
export function useInvalidacaoAgrupada(opcoes: OpcoesDoAgrupador): (queryKey: QueryKey) => void {
  const qc = useQueryClient();
  const agrupador = useRef<Agrupador<QueryKey> | null>(null);
  const opcoesRef = useRef(opcoes);

  useEffect(() => {
    const atual = criarAgrupador<QueryKey>(opcoesRef.current, (queryKey) => {
      void qc.invalidateQueries({ queryKey });
    });
    agrupador.current = atual;
    return () => {
      if (agrupador.current === atual) agrupador.current = null;
      for (const queryKey of atual.encerrar()) {
        void qc.invalidateQueries({ queryKey, refetchType: "none" });
      }
    };
  }, [qc]);

  return useCallback(
    (queryKey: QueryKey) => {
      // Sem agrupador (evento antes do efeito montar): invalida direto, como antes.
      if (agrupador.current) agrupador.current.pedir(hashKey(queryKey), queryKey);
      else void qc.invalidateQueries({ queryKey });
    },
    [qc],
  );
}
