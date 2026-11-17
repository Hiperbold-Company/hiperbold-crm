"use client";
/**
 * As mensagens agendadas de uma conversa (migration 1017): a lista que o fim da
 * conversa mostra e as três escritas (agendar, editar, cancelar).
 *
 * O balão some quando a linha vira `enviada`: a lista é relida a cada 20 s
 * enquanto houver alguma, e toda escrita a invalida na hora. A mensagem real
 * entra na conversa pelo realtime de sempre (`useMessagesRealtime`).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { ModeloDaAgendada, StatusDaAgendada } from "@/lib/mensagens-agendadas/regras";

export interface MensagemAgendada {
  id: string;
  conversation_id: string;
  created_by: string | null;
  body: string;
  template: ModeloDaAgendada | null;
  send_at: string;
  status: StatusDaAgendada;
  motivo: string | null;
  message_id: string | null;
  adiada_ate: string | null;
  updated_at: string;
}

export const chaveDasAgendadas = (conversationId: string) => ["mensagens-agendadas", conversationId] as const;

/** Releitura enquanto houver agendada: é o que faz o balão sumir depois do envio. */
export const RELEITURA_MS = 20_000;

export function useMensagensAgendadas(conversationId: string | null) {
  return useQuery({
    queryKey: chaveDasAgendadas(conversationId ?? ""),
    enabled: !!conversationId,
    queryFn: async () =>
      (await apiClient.get<{ data: MensagemAgendada[] }>(`/api/v1/conversations/${conversationId}/scheduled-messages`))
        .data,
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? RELEITURA_MS : false),
    staleTime: 10_000,
  });
}

export interface AgendarArgs {
  conversationId: string;
  body: string;
  sendAt: Date;
  template: ModeloDaAgendada | null;
}

export function useAgendarMensagem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: AgendarArgs) =>
      (
        await apiClient.post<{ data: MensagemAgendada }>(
          `/api/v1/conversations/${args.conversationId}/scheduled-messages`,
          // O `apiClient` põe o `Idempotency-Key` em toda escrita: a retentativa do mesmo pedido não agenda duas.
          { body: args.body, send_at: args.sendAt.toISOString(), template: args.template },
        )
      ).data,
    onError: showApiError,
    onSuccess: (_d, args) => qc.invalidateQueries({ queryKey: chaveDasAgendadas(args.conversationId) }),
  });
}

export interface EditarArgs {
  agendada: MensagemAgendada;
  body?: string;
  sendAt?: Date;
}

export function useEditarAgendada() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: EditarArgs) =>
      (
        await apiClient.patch<{ data: MensagemAgendada }>(`/api/v1/scheduled-messages/${args.agendada.id}`, {
          expected_updated_at: args.agendada.updated_at,
          ...(args.body !== undefined ? { body: args.body } : {}),
          ...(args.sendAt !== undefined ? { send_at: args.sendAt.toISOString() } : {}),
        })
      ).data,
    onError: showApiError,
    // Também no erro: o 409 diz que a linha mudou, e a tela tem de reler para mostrar como ela está.
    onSettled: (_d, _e, args) => qc.invalidateQueries({ queryKey: chaveDasAgendadas(args.agendada.conversation_id) }),
  });
}

export function useCancelarAgendada() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agendada: MensagemAgendada) =>
      (await apiClient.delete<{ data: MensagemAgendada }>(`/api/v1/scheduled-messages/${agendada.id}`)).data,
    onError: showApiError,
    onSettled: (_d, _e, agendada) => qc.invalidateQueries({ queryKey: chaveDasAgendadas(agendada.conversation_id) }),
  });
}
