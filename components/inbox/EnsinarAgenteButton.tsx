"use client";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { useEnsinarAgente } from "@/hooks/inbox/useEnsinarAgente";
import { Brain, Check } from "@/lib/ui/icons";
import type { EstadoDoEnsino } from "@/lib/ai/rag/conversa-que-ensina";

interface Props {
  conversationId: string;
  /** Só conversa encerrada pode ensinar: aberta, o botão não aparece. */
  encerrada: boolean;
}

/**
 * "Usar para ensinar o agente" — a única porta da fonte "Conversas anteriores"
 * do Conhecimento. Sem ela a fonte existia e nunca recebia nada.
 *
 * O que a tela promete é o que o código faz (ver a rota
 * `app/api/v1/conversations/[id]/usable-for-rag`):
 *  - marcada, entra na rodada noturna (`kb-conversations-batch`), anonimizada;
 *  - já indexada, retirar a marcação NÃO apaga o que o agente aprendeu, e
 *    mensagens novas desta conversa não entram de novo — por isso o diálogo
 *    diz isso em vez de prometer "remover".
 */
export function EnsinarAgenteButton({ conversationId, encerrada }: Props) {
  const t = useT();
  const { estado, alternar } = useEnsinarAgente(conversationId, encerrada);
  const [aberto, setAberto] = useState(false);

  if (!encerrada) return null;
  const atual = estado.data;
  const marcada = atual?.usable_for_rag ?? false;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={marcada}
        disabled={!atual || alternar.isPending}
        data-testid="ensinar-o-agente"
        title={
          marcada
            ? t("Esta conversa está marcada para ensinar o agente.")
            : t("Entra no conhecimento do agente na próxima rodada noturna, sem dados pessoais.")
        }
        onClick={() => setAberto(true)}
        className="flex items-center gap-1"
      >
        {marcada ? <Check size={14} aria-hidden /> : <Brain size={14} aria-hidden />}
        {marcada ? t("Ensinando o agente") : t("Usar para ensinar o agente")}
      </Button>
      <AlertDialog open={aberto} onOpenChange={setAberto}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {marcada
                ? t("Parar de usar esta conversa para ensinar o agente?")
                : t("Usar esta conversa para ensinar o agente?")}
            </AlertDialogTitle>
            <AlertDialogDescription>{t(explicacao(atual, marcada))}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => alternar.mutate(!marcada)}>
              {marcada ? t("Retirar a marcação") : t("Usar para ensinar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A frase do diálogo, escolhida pelo que JÁ aconteceu com a conversa. */
function explicacao(atual: EstadoDoEnsino | undefined, marcada: boolean): string {
  const jaNaBase = atual?.rag_review_status === "ingested";
  if (marcada) {
    return jaNaBase
      ? "Ela já entrou no conhecimento do agente. Retirar a marcação não apaga o que ele já aprendeu com ela."
      : "Ela ainda não entrou no conhecimento do agente e deixa de entrar na próxima rodada noturna.";
  }
  if (jaNaBase) {
    return "Esta conversa já está no conhecimento do agente. Marcar de novo não muda nada: mensagens novas dela não entram outra vez.";
  }
  return "Ela entra no conhecimento do agente na próxima rodada noturna, sem dados pessoais: nomes, telefones, e-mails, CPF e CEP são removidos antes.";
}
