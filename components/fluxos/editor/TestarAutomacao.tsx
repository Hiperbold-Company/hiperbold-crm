"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

interface ContatoDaBusca {
  id: string;
  name: string | null;
  phone_number: string | null;
  email: string | null;
}

/**
 * "Testar com um contato": inicia a automação PUBLICADA para um contato
 * escolhido, pelo gatilho manual (`POST /api/v1/automacoes/[id]/executar`).
 * A resposta do servidor já vem em português ("Iniciada", "Já em execução"…).
 */
export function TestarAutomacao({ flowId, publicada }: { flowId: string; publicada: boolean }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [enviando, setEnviando] = useState<string | null>(null);
  const termo = busca.trim();
  const contatos = useQuery({
    queryKey: ["automacao-testar-contatos", termo],
    queryFn: async () =>
      apiClient.get<{ data: ContatoDaBusca[] }>(
        `/api/v1/contacts?limit=8${termo ? `&search=${encodeURIComponent(termo)}` : ""}`,
      ),
    enabled: aberto,
    staleTime: 10_000,
  });

  const iniciar = async (contato: ContatoDaBusca) => {
    setEnviando(contato.id);
    try {
      const r = await apiClient.post<{ data: { resultado: string; mensagem: string } }>(
        `/api/v1/automacoes/${flowId}/executar`,
        { contact_id: contato.id },
      );
      if (r.data.resultado === "iniciada" || r.data.resultado === "reiniciada") toast.success(r.data.mensagem);
      else toast.info(r.data.mensagem);
      setAberto(false);
    } catch (err) {
      showApiError(err);
    } finally {
      setEnviando(null);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!publicada}
        title={publicada ? undefined : t("Publique a automação para testar.")}
        onClick={() => setAberto(true)}
        data-testid="testar-automacao"
      >
        {t("Testar com um contato")}
      </Button>
      <Button type="button" variant="outline" size="sm" asChild>
        <Link href={`/app/automacoes/${flowId}/execucoes`} data-testid="ver-execucoes">
          {t("Execuções")}
        </Link>
      </Button>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Testar com um contato")}</DialogTitle>
            <DialogDescription>
              {t("A automação publicada roda de verdade para o contato escolhido: as ações mudam o CRM.")}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={t("Buscar por nome, telefone ou e-mail")}
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            data-testid="testar-busca"
          />
          <ul className="max-h-72 space-y-1 overflow-y-auto" data-testid="testar-resultados">
            {contatos.isLoading && <li className="text-sm text-text-muted">{t("Carregando…")}</li>}
            {!contatos.isLoading && (contatos.data?.data ?? []).length === 0 && (
              <li className="text-sm text-text-muted">{t("Nenhum contato encontrado.")}</li>
            )}
            {(contatos.data?.data ?? []).map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 rounded-sm border border-border p-2">
                <span className="min-w-0 truncate text-sm text-text">
                  {c.name ?? c.phone_number ?? c.email ?? t("Sem nome")}
                  {c.phone_number && c.name ? <span className="ml-2 text-text-muted">{c.phone_number}</span> : null}
                </span>
                <Button type="button" size="sm" disabled={enviando !== null} onClick={() => void iniciar(c)}>
                  {enviando === c.id ? t("Iniciando…") : t("Iniciar")}
                </Button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
