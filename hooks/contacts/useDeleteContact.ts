"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { toast } from "sonner";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";

/**
 * A pré-checagem do handler põe `{ vinculos, por_tabela }` em `error.details`
 * (issue #1925). Com um compromisso na Agenda barrando, a frase diz O QUE barrou
 * e O QUE fazer; qualquer outro caso devolve null e cai no texto genérico.
 * A frase sai de chave fixa do dicionário (a de `vinculos` vem do servidor em
 * pt-BR e não se traduz).
 */
export function mensagemDeBloqueioPorVinculo(
  details: Record<string, unknown> | undefined,
  t: (texto: string) => string,
): string | null {
  const porTabela = details?.por_tabela as Record<string, unknown> | undefined;
  const n = porTabela?.calendar_appointments;
  const negocios = porTabela?.crm_leads;
  const partes: string[] = [];
  if (typeof negocios === "number" && negocios >= 1) {
    partes.push(
      negocios === 1
        ? t("Este contato tem 1 negócio em aberto no Pipeline. Ganhe, perca ou passe o negócio para outro contato antes de excluir.")
        : t("Este contato tem {n} negócios em aberto no Pipeline. Ganhe, perca ou passe os negócios para outro contato antes de excluir.").replace(
            "{n}",
            String(negocios),
          ),
    );
  }
  if (typeof n === "number" && n >= 1) {
    partes.push(
      n === 1
        ? t("Este contato tem 1 compromisso na Agenda. Cancele ou apague o compromisso antes de excluir.")
        : t("Este contato tem {n} compromissos na Agenda. Cancele ou apague os compromissos antes de excluir.").replace(
            "{n}",
            String(n),
          ),
    );
  }
  return partes.length > 0 ? partes.join(" ") : null;
}

function toastDeBloqueioPorVinculo(err: ApiError): boolean {
  const t = (s: string) => traduzir(s, idiomaAtual());
  const mensagem = mensagemDeBloqueioPorVinculo(err.details, t);
  if (!mensagem) return false;
  const porTabela = err.details?.por_tabela as Record<string, unknown> | undefined;
  const temNegocio = typeof porTabela?.crm_leads === "number" && porTabela.crm_leads >= 1;
  toast.error(mensagem, {
    action: temNegocio
      ? {
          label: t("Abrir Pipeline"),
          onClick: () => {
            window.location.href = "/app/kanban";
          },
        }
      : {
          label: t("Abrir Agenda"),
          onClick: () => {
            window.location.href = "/app/agenda";
          },
        },
  });
  return true;
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactId: string) =>
      apiClient.delete<unknown>(`/api/v1/contacts/${contactId}`),
    onError: (err) => {
      if (err instanceof ApiError && toastDeBloqueioPorVinculo(err)) return;
      showApiError(err);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}
