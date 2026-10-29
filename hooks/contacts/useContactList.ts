"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { ContactOrderBy } from "@/lib/schemas/contacts";
import type { Contact } from "@/lib/types/contacts";
import { filtrosToParams, type FiltrosDaTela } from "@/lib/contacts/filtros-url";

interface ListResponse {
  data: Contact[];
  meta?: { cursor?: string; has_more?: boolean };
}

export interface ContactListFilters extends FiltrosDaTela {
  order_by?: ContactOrderBy;
  order_dir?: "asc" | "desc";
  limit?: number;
  /** Anexa os UTMs dos negócios (só quando alguma coluna de UTM está visível). */
  com_utm?: boolean;
}

export function useContactList(filters: ContactListFilters) {
  return useInfiniteQuery({
    queryKey: ["contacts", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = filtrosToParams(filters);
      if (filters.order_by) qs.set("order_by", filters.order_by);
      if (filters.order_dir) qs.set("order_dir", filters.order_dir);
      if (filters.limit) qs.set("limit", String(filters.limit));
      if (filters.com_utm) qs.set("com_utm", "1");
      if (pageParam) qs.set("cursor", pageParam);
      try {
        return await apiClient.get<ListResponse>(`/api/v1/contacts?${qs.toString()}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (lastPage) =>
      lastPage.meta?.has_more ? lastPage.meta.cursor : undefined,
  });
}
