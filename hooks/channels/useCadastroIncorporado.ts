"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

const ROTA = "/api/v1/channels/official/cadastro-incorporado";

export type InicioDoCadastroIncorporado =
  | { disponivel: false; motivo: string }
  | {
      disponivel: true;
      appId: string;
      configId: string;
      versaoDaGraph: string;
      /** Uso único: cada clique pede o seu, e o servidor o confere no POST. */
      state: string;
    };

export interface FimDoCadastroIncorporado {
  state: string;
  code: string;
  phone_number_id: string;
  waba_id?: string;
  nome?: string;
  evento?: string;
}

export interface ResultadoDoCadastroIncorporado {
  connected: boolean;
  displayName: string;
  phoneNumber: string | null;
  webhookRegistro: unknown;
  /** `null` = a Meta não respondeu sobre o estado do número; a tela não afirma nada. */
  precisaRegistrar: boolean | null;
  /** Coexistência: `true` = a Meta aceitou sincronizar os contatos do app, `false` = recusou, `null` = não se aplica. */
  sincronizacaoDoApp?: boolean | null;
}

/** Pede o início do cadastro: devolve um `state` NOVO a cada chamada. Não passa pelo cache. */
export async function pedirInicioDoCadastroIncorporado(): Promise<InicioDoCadastroIncorporado> {
  const r = await apiClient.get<{ data: InicioDoCadastroIncorporado }>(ROTA);
  return r.data;
}

export function useFinalizarCadastroIncorporado() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: FimDoCadastroIncorporado) =>
      apiClient.post<{ data: ResultadoDoCadastroIncorporado }>(ROTA, input),
    // Sem toast genérico: a tela mostra a mensagem da rota em caixa própria.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
      qc.invalidateQueries({ queryKey: ["conexoes"] });
    },
  });
}
