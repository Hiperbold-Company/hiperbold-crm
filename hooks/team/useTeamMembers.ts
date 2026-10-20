"use client";
import type { InterfaceSettings } from "@/lib/navigation/interface";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface TeamMember {
  interface_settings?: InterfaceSettings;
  user_id: string;
  role: string;
  invited_at: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  /** Vínculo da agência que opera o CRM (migration 0974): sem ação para o cliente. */
  membro_da_agencia?: boolean;
  email: string | null;
  full_name: string | null;
  last_sign_in_at: string | null;
}

export function useTeamMembers(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["team", "members"],
    queryFn: async () => apiClient.get<{ data: TeamMember[] }>("/api/v1/team"),
    staleTime: 30_000,
    enabled: opts?.enabled ?? true,
  });
}
