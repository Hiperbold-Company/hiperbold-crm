"use client";
import { useEffect, useRef, type ComponentType } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { CartaoDaConexao, StatusDaConexao, TipoDaConexao } from "@/hooks/channels/useConexoes";
import { useT } from "@/hooks/i18n/useT";
import { ROTULO_DO_QR_POR_INSTANCIA, ROTULO_DO_QR_POR_SESSAO } from "@/lib/channels/rotulo-do-qr-por-sessao";
import { InstagramLogo, MessengerLogo, Plug, QrCode, WhatsappLogo } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Um cartão por conexão, na grade da tela de Conexões (decisão do dono do produto, 17/11/2026).
 *
 * O cartão diz o que quem opera reconhece: se está funcionando, que tipo de canal é, o nome que
 * a equipe deu e o número (ou @). O resto (credencial, webhook, modelos) mora no Gerenciar.
 */

// Rótulos em tabela de topo: a cerca de i18n resolve t(TABELA[chave]) e cobra o espanhol de cada valor.
export const TITULO_DO_TIPO: Record<TipoDaConexao, string> = {
  whatsapp_oficial: "WhatsApp API Oficial",
  whatsapp_qr: ROTULO_DO_QR_POR_INSTANCIA,
  instagram: "Instagram",
  messenger: "Messenger",
  outros: "Outra conexão",
};

const TITULO_DA_OFICIAL_POR_PARCEIRO = "WhatsApp oficial (parceiro)";

export const ICONE_DO_TIPO: Record<TipoDaConexao, ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>> = {
  whatsapp_oficial: WhatsappLogo,
  whatsapp_qr: QrCode,
  instagram: InstagramLogo,
  messenger: MessengerLogo,
  outros: Plug,
};

const ROTULO_DO_STATUS: Record<StatusDaConexao, string> = {
  conectado: "Conectado",
  desconectado: "Desconectado",
  precisa_atencao: "Precisa de atenção",
};

const COR_DO_STATUS: Record<StatusDaConexao, string> = {
  conectado: "bg-success",
  desconectado: "bg-error",
  precisa_atencao: "bg-warning",
};

/**
 * O título do tipo, já com o "(parceiro)" da oficial por intermediário e o nome do serviço na conexão
 * por QR que se pareia pela sessão (a terceira forma de conexão). Sem tradução: quem chama traduz.
 */
export function tituloDaConexao(conexao: Pick<CartaoDaConexao, "tipo" | "via"> & { pareamento?: CartaoDaConexao["pareamento"] }): string {
  if (conexao.tipo === "whatsapp_oficial" && conexao.via === "parceiro") return TITULO_DA_OFICIAL_POR_PARCEIRO;
  if (conexao.tipo === "whatsapp_qr" && conexao.pareamento === "sessao") return ROTULO_DO_QR_POR_SESSAO;
  return TITULO_DO_TIPO[conexao.tipo];
}

export function StatusDaConexaoBadge({ status }: { status: StatusDaConexao }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium" data-testid="status-da-conexao" data-status={status}>
      <span aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-full", COR_DO_STATUS[status])} />
      {t(ROTULO_DO_STATUS[status])}
    </span>
  );
}

export function CartaoDeConexao({
  conexao,
  aoGerenciar,
  destacado = false,
}: {
  conexao: CartaoDaConexao;
  aoGerenciar: () => void;
  /** Acabou de ser conectado (volta do OAuth): o cartão rola à vista e ganha um contorno. */
  destacado?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (destacado) ref.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [destacado]);
  const Icone = ICONE_DO_TIPO[conexao.tipo];
  const titulo = t(tituloDaConexao(conexao));
  const nome = conexao.nome ?? conexao.numero_ou_handle ?? t("Conexão sem nome");
  return (
    <Card
      ref={ref}
      className={cn(
        "flex flex-col gap-5 rounded-xl p-5 shadow-none transition-colors hover:border-border-strong",
        destacado && "ring-2 ring-primary",
      )}
      data-testid={`cartao-conexao-${conexao.id}`}
      data-destacado={destacado ? "true" : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <StatusDaConexaoBadge status={conexao.status} />
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <Icone size={22} aria-hidden />
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground" data-testid="tipo-da-conexao">
          {titulo}
        </p>
        <p className="truncate text-base font-semibold" title={nome} data-testid="nome-da-conexao">
          {nome}
        </p>
        {/* Sem nome, o número já é o título: a linha fica vazia (com altura, para os cartões alinharem). */}
        <p className="min-h-5 truncate text-sm text-muted-foreground" data-testid="numero-da-conexao">
          {conexao.numero_ou_handle === nome ? null : (conexao.numero_ou_handle ?? t("sem número informado"))}
        </p>
      </div>

      <div className="mt-auto border-t pt-4">
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={aoGerenciar}
          aria-label={`${t("Gerenciar")} ${nome}`}
          data-testid={`gerenciar-${conexao.id}`}
        >
          {t("Gerenciar")}
        </Button>
      </div>
    </Card>
  );
}
