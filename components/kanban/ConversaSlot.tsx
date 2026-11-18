"use client";
import Link from "next/link";
import type { MouseEvent } from "react";

import { useT } from "@/hooks/i18n/useT";
import { ChatCircle } from "@/lib/ui/icons";
import type { Lead } from "@/lib/types/leads";
import { cn } from "@/lib/utils";
import { AbrirConversaDoLead, temAlvoParaAbrir } from "./AbrirConversaDoLead";
import { useAbrirPelaConexao } from "./AbrirPelaConexao";
import { ehCanalSocial } from "@/lib/channels/capabilities";

/**
 * A última mensagem do negócio, com atalho para o inbox.
 *
 * ─── Por que atalho e não um composer aqui dentro ───────────────────────────
 *
 * Responder de dentro do quadro exigiria trazer o composer inteiro — anexos,
 * templates, notas internas, gravação de áudio — para uma segunda tela. Duas
 * cópias do mesmo campo divergem: a correção entra numa e não na outra, e o
 * atendente aprende que "no Kanban não funciona igual". O inbox já é o lugar
 * onde se conversa; o que faltava era chegar nele sem procurar.
 *
 * ─── O que a prévia resolve ─────────────────────────────────────────────────
 *
 * Sem ela o atalho é uma aposta: clicar para descobrir se vale a pena. Com a
 * última mensagem à vista, o vendedor decide olhando o quadro — que é para o
 * que o quadro serve.
 *
 * ─── Ausência é estado normal, não erro ─────────────────────────────────────
 *
 * Negócio criado à mão ou por webhook não tem contato; contato pode não ter
 * conversa. Nesses casos o slot não aparece — e NÃO aparece um "sem mensagens"
 * cinza, que ocuparia a mesma linha em metade dos cards para não dizer nada.
 *
 * ─── Sem conversa, mas com contato: a AÇÃO no lugar da prévia ────────────────
 *
 * O lead do webhook chega com telefone e sem thread (issue #1993). Para ele a
 * linha não some: vira o botão "Abrir conversa", que usa a rota já existente e
 * leva para a Inbox. `conversa === undefined` continua mudo — é "ainda não
 * carregou", e prometer ação sobre um dado que pode existir seria mentir.
 *
 * ─── Com conversa: pela conexão de quem clica (16/11/2026) ──────────────────
 *
 * A conversa da prévia pode estar na conexão de OUTRA atendente. O clique não
 * vai mais direto a ela: passa por `useAbrirPelaConexao`, que abre a da minha
 * conexão, pergunta numa janela ou recusa, conforme o modo da organização. O
 * `href` continua no elo (leitor de tela, copiar link), mas o clique comum é
 * interceptado. Sem contato, o elo segue como antes.
 */
export function ConversaSlot({
  conversa,
  contactId,
  phone,
  leadId,
}: {
  conversa: Lead["conversa"];
  contactId?: string | null;
  phone?: string | null;
  leadId?: string | null;
}) {
  if (conversa === undefined) return null;
  if (conversa === null) {
    // A guarda de alvo fica AQUI, antes de montar: montar o botão sem contato
    // nem telefone desenharia (e custaria router + query client) uma linha que
    // não tem o que dizer.
    return temAlvoParaAbrir(contactId, phone) ? (
      <AbrirConversaDoLead contactId={contactId} phone={phone} leadId={leadId} />
    ) : null;
  }
  // Sem contato não há conexão a decidir, e conversa de rede social (Instagram,
  // Messenger) não vira WhatsApp: o elo direto de sempre, sem montar router nem
  // query client e sem perguntar nada ao servidor.
  if (!contactId || ehCanalSocial(conversa.provider)) return <EloDaConversa conversa={conversa} />;
  return <EloPelaConexao conversa={conversa} contactId={contactId} phone={phone} leadId={leadId} />;
}

function EloPelaConexao({
  conversa,
  contactId,
  phone,
  leadId,
}: {
  conversa: NonNullable<Lead["conversa"]>;
  contactId: string;
  phone?: string | null;
  leadId?: string | null;
}) {
  const { abrir, abrindo, janela } = useAbrirPelaConexao({
    contactId,
    phone,
    leadId,
    conversaId: conversa.id,
  });
  return (
    <>
      <span onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        {janela}
      </span>
      <EloDaConversa conversa={conversa} abrindo={abrindo} onAbrir={() => void abrir(true)} />
    </>
  );
}

function EloDaConversa({
  conversa,
  abrindo = false,
  onAbrir,
}: {
  conversa: NonNullable<Lead["conversa"]>;
  abrindo?: boolean;
  /** Presente = o clique comum passa pela escolha de conexão. */
  onAbrir?: () => void;
}) {
  const t = useT();

  const preview = conversa.preview?.trim();
  const temNaoLidas = conversa.unread > 0;

  return (
    <Link
      href={`/app/inbox?id=${conversa.id}`}
      // Sempre em nova aba: o funil fica onde estava.
      target="_blank"
      rel="noopener noreferrer"
      // O card inteiro é arrastável e clicável (abre o dossiê). Sem parar a
      // propagação, o clique no atalho também abriria o dossiê por baixo — dois
      // destinos para um gesto.
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        if (!onAbrir) return;
        // Ctrl/Cmd/Shift-clique também: o atalho já abre em nova aba, e deixar o
        // navegador abrir o `href` pularia a escolha da conexão.
        e.preventDefault();
        onAbrir();
      }}
      // Clique do meio (botão 1): o mesmo fluxo, em nova aba. O menu de
      // contexto ("abrir em nova aba") não dá para interceptar — quem segura é
      // o servidor, no envio.
      onAuxClick={(e: MouseEvent) => {
        e.stopPropagation();
        if (!onAbrir || e.button !== 1) return;
        e.preventDefault();
        onAbrir();
      }}
      aria-busy={abrindo}
      onPointerDown={(e: MouseEvent) => e.stopPropagation()}
      className={cn(
        "group/conversa mt-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-2xs",
        "text-text-muted transition-colors hover:bg-muted hover:text-foreground",
      )}
      title={t("Abrir esta conversa no Chat do CRM")}
    >
      <ChatCircle size={12} weight="regular" className="shrink-0" aria-hidden />
      <span className="truncate">
        {preview || <span className="italic">{t("conversa sem mensagens")}</span>}
      </span>
      {temNaoLidas && (
        // O número, não um ponto: "3 sem ler" e "12 sem ler" pedem urgências
        // diferentes, e um ponto colapsa as duas.
        <span
          className="ml-auto shrink-0 rounded-full bg-primary px-1.5 text-2xs font-medium text-primary-foreground tabular-nums"
          aria-label={`${conversa.unread} ${t("sem ler")}`}
        >
          {conversa.unread}
        </span>
      )}
    </Link>
  );
}
