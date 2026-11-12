"use client";
import { useCallback } from "react";
import { useInvalidacaoAgrupada } from "@/hooks/realtime/useInvalidacaoAgrupada";
import { AGRUPAR_ADMIN } from "@/lib/realtime/coalescer";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";

/**
 * Subscribes to postgres_changes on `messages` (INSERT) without org_id filter —
 * platform admin sees all tenants in real-time.
 *
 * NOTE: postgres_changes requires Supabase Realtime to be enabled and the
 * `messages` table added to the `supabase_realtime` publication.
 * If Realtime is not enabled for this table, events will be silently dropped;
 * the list will still refresh on focus (staleTime = 10s).
 */
export function useAdminInboxRealtime() {
  // Sem filtro de organização, cada mensagem de QUALQUER cliente chega aqui:
  // a rajada vira uma recarga por janela.
  const invalidar = useInvalidacaoAgrupada(AGRUPAR_ADMIN);

  const onChange = useCallback(() => {
    invalidar(["admin", "inbox"]);
  }, [invalidar]);

  return useRealtimeChannel({
    name: "admin-inbox-realtime",
    postgresChanges: {
      event: "INSERT",
      schema: "public",
      table: "messages",
      // No filter — cross-tenant intentional for platform admin
    },
    onChange,
    enabled: true,
  });
}
