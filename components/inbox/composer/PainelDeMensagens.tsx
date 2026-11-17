"use client";
/**
 * O PAINEL DE MENSAGENS DO CHAT (17/11/2026) — o botão de aspas do compositor.
 *
 * Abre SOBRE a conversa, sem trocar de página, com duas abas:
 *
 *   - "Mensagens rápidas": a mesma lista do `/` e da barra (`useMessageTemplates`),
 *     com busca (`filtrarRespostas`, a régua do `/`). O clique entrega a resposta
 *     ao `applyTemplate` do compositor — o MESMO caminho do `/`, então as
 *     variáveis (`{{nome}}`…) e as mídias seguem a regra de sempre. "Nova
 *     mensagem rápida" abre o formulário da tela de Respostas rápidas, com a
 *     mesma rota e o mesmo `canShare` (gerente para cima compartilha).
 *   - "Templates do WhatsApp": só no canal oficial (`fonteDeTemplates` diz
 *     "oficial" — a tela não lê o nome do provider). Ver `AbaDeModelosDoWhatsApp`.
 *
 * Esc fecha o painel (e só ele: com o formulário aberto, o Esc é do formulário).
 * O foco vai para a busca ao abrir; quem abriu devolve o foco ao botão.
 */
import { useEffect, useRef, useState } from "react";

import { TemplateFormDialog } from "@/app/app/templates/_components/TemplateFormDialog";
import { AbaDeModelosDoWhatsApp } from "@/components/inbox/composer/AbaDeModelosDoWhatsApp";
import { filtrarRespostas } from "@/components/inbox/composer/TemplateMenu";
import { useT } from "@/hooks/i18n/useT";
import {
  useGruposDeRespostas,
  useMessageTemplates,
  type MessageTemplate,
} from "@/hooks/inbox/useMessageTemplates";
import { fonteDeTemplates } from "@/lib/channels/templates-fonte";
import { Plus, X } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

type Aba = "rapidas" | "modelos";

interface Props {
  aberto: boolean;
  onFechar: () => void;
  conversationId: string;
  /** Decide se a aba de modelos existe. A tela não interpreta o valor. */
  provider: string | null;
  /** A conexão DA conversa: a organização pode ter várias contas oficiais. */
  channelSessionId: string | null;
  /** Gerente para cima: compartilha resposta rápida e cria modelo. */
  podeGerenciar: boolean;
  /** Entrega a resposta ao `applyTemplate` do compositor. */
  onInserir: (resposta: MessageTemplate) => void;
}

const ABA_BASE =
  "rounded-md px-3 py-1.5 text-xs font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

export function PainelDeMensagens({
  aberto,
  onFechar,
  conversationId,
  provider,
  channelSessionId,
  podeGerenciar,
  onInserir,
}: Props) {
  const t = useT();
  const [aba, setAba] = useState<Aba>("rapidas");
  const [busca, setBusca] = useState("");
  const [formAberto, setFormAberto] = useState(false);
  const buscaRef = useRef<HTMLInputElement>(null);
  const respostas = useMessageTemplates();
  const grupos = useGruposDeRespostas();
  const temModelos = fonteDeTemplates(provider) === "oficial";
  const abaAtual: Aba = aba === "modelos" && !temModelos ? "rapidas" : aba;

  useEffect(() => {
    if (aberto) requestAnimationFrame(() => buscaRef.current?.focus());
  }, [aberto]);

  if (!aberto) return null;

  const lista = filtrarRespostas(respostas.data ?? [], busca, grupos.data ?? []);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={t("Painel de mensagens")}
      data-painel-de-mensagens
      onKeyDown={(e) => {
        if (e.key !== "Escape" || formAberto || e.defaultPrevented) return;
        e.stopPropagation();
        onFechar();
      }}
      className="absolute bottom-full right-3 left-3 z-30 mb-2 flex max-h-[min(32rem,70vh)] flex-col overflow-hidden rounded-md border border-border bg-popover shadow-lg sm:left-auto sm:w-[30rem]"
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <div role="tablist" aria-label={t("Painel de mensagens")} className="flex flex-1 gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={abaAtual === "rapidas"}
            onClick={() => setAba("rapidas")}
            className={cn(ABA_BASE, abaAtual === "rapidas" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted")}
          >
            {t("Mensagens rápidas")}
          </button>
          {temModelos && (
            <button
              type="button"
              role="tab"
              aria-selected={abaAtual === "modelos"}
              onClick={() => setAba("modelos")}
              className={cn(ABA_BASE, abaAtual === "modelos" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted")}
            >
              {t("Templates do WhatsApp")}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onFechar}
          aria-label={t("Fechar painel")}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={16} aria-hidden />
        </button>
      </div>

      {abaAtual === "rapidas" ? (
        <div role="tabpanel" aria-label={t("Mensagens rápidas")} className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 px-2 py-2">
            <input
              ref={buscaRef}
              type="search"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder={t("Buscar mensagem rápida…")}
              aria-label={t("Buscar mensagem rápida")}
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm focus:outline-hidden focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              onClick={() => setFormAberto(true)}
              className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus size={14} aria-hidden />
              {t("Nova mensagem rápida")}
            </button>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" aria-label={t("Mensagens rápidas")}>
            {lista.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">
                {busca.trim() ? t("Nenhuma mensagem rápida com essa busca.") : t("Nenhuma mensagem rápida ainda.")}
              </li>
            ) : (
              lista.map((resposta) => (
                <li key={resposta.id}>
                  <button
                    type="button"
                    data-resposta-rapida={resposta.id}
                    onClick={() => {
                      onInserir(resposta);
                      onFechar();
                    }}
                    className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex w-full items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{resposta.title}</span>
                      {resposta.shortcut && (
                        <span className="shrink-0 font-mono text-2xs text-muted-foreground">/{resposta.shortcut}</span>
                      )}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{resposta.body}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : (
        <div role="tabpanel" aria-label={t("Templates do WhatsApp")} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <AbaDeModelosDoWhatsApp
            conversationId={conversationId}
            channelSessionId={channelSessionId}
            podeCriar={podeGerenciar}
            onEnviado={onFechar}
          />
        </div>
      )}

      {/* Montado só quando pedido: o formulário traz mutações e upload, e o
          painel fechado não paga por eles. */}
      {formAberto && (
        <TemplateFormDialog
          open
          onOpenChange={setFormAberto}
          canShare={podeGerenciar}
          grupos={grupos.data ?? []}
        />
      )}
    </div>
  );
}
