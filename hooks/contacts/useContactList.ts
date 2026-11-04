"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { ContactOrderBy } from "@/lib/schemas/contacts";
import type { Contact } from "@/lib/types/contacts";
import { filtrosToParams, type FiltrosDaTela } from "@/lib/contacts/filtros-url";
import {
  type ModoDeEtiqueta,
  marcadoresEscolhidos,
} from "@/lib/inbox/marcador-da-conversa";

interface ListResponse {
  data: Contact[];
  meta?: { cursor?: string; has_more?: boolean };
}

export interface ContactListFilters extends Omit<FiltrosDaTela, "tag"> {
  /**
   * A etiqueta, ou VÁRIAS (#1274).
   *
   * `string` continua aceito porque é o que a tela e qualquer chamada antiga
   * produzem; a lista sai na URL por `append` porque é a repetição que a rota lê
   * com `getAll`.
   */
  tag?: string | readonly string[];
  /** E ou OU entre as etiquetas escolhidas (#1274). `e` e o padrao. */
  tagMode?: ModoDeEtiqueta;
  /**
   * Só pessoais (spec 21, etapa 13): `true` lista SÓ pessoais, ausente/false
   * exclui. Viaja como `?pessoais=true` — só o ligado viaja, como o `modo=ou`.
   */
  pessoais?: boolean;
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
      // Os filtros da tela (Hiperbold: datas, funil, etapa, campo) saem pela
      // mesma função da URL; a etiqueta sai à parte porque pode ser várias.
      const qs = filtrosToParams({ ...filters, tag: undefined });
      for (const marcador of marcadoresEscolhidos(
        typeof filters.tag === "string" ? [filters.tag] : (filters.tag ?? []),
      ))
        qs.append("tag", marcador);
      // So `ou` viaja: `e` e o padrao, e um `&modo=e` colado num link de hoje
      // mudaria a URL sem mudar o sentido do filtro.
      if (filters.tagMode === "ou") qs.set("modo", "ou");
      // Só o ligado viaja: desligado é o padrão do servidor, e um
      // `&pessoais=false` colado num link de hoje mudaria a URL sem mudar nada.
      if (filters.pessoais) qs.set("pessoais", "true");
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
