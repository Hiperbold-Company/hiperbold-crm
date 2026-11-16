"use client";
import { useQuery } from "@tanstack/react-query";

import type { OpcoesDeAbertura } from "@/lib/inbox/conexao-ao-abrir";

/** A chave, exportada: salvar Configurações › Atendimento a invalida. */
export const CHAVE_MINHAS_CONEXOES = ["minhas-conexoes"] as const;

/**
 * As conexões em que quem está logado é responsável, o número geral e o modo
 * da organização ("deixar escolher" × "só a conexão própria"). Sem contato: só
 * a parte da pessoa. Cache curto (30 s) e invalidado ao salvar a configuração.
 *
 * Falha de leitura vira `undefined`; quem usa decide (o aviso do Chat some; a
 * abertura pelo funil, sabendo que há conexão vinculada, recusa navegar).
 */
export function useMinhasConexoes(): OpcoesDeAbertura | undefined {
  const q = useQuery({
    queryKey: CHAVE_MINHAS_CONEXOES,
    queryFn: async () => {
      const res = await fetch("/api/v1/conversations/open-with-contact/opcoes");
      if (!res.ok) throw new Error("opcoes_indisponiveis");
      const json = (await res.json()) as { data?: OpcoesDeAbertura };
      if (!json.data) throw new Error("opcoes_indisponiveis");
      return json.data;
    },
    staleTime: 30_000,
    retry: false,
  });
  return q.data;
}
