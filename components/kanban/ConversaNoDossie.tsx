"use client";
import { useMarcaDoPipeline } from "@/lib/redesign/pipeline";
import type { ReactNode } from "react";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { ArrowRight, ChatCircle } from "@/lib/ui/icons";
import type { Contact } from "@/lib/types/contacts";
import { AbrirConversaDoLead, temAlvoParaAbrir } from "./AbrirConversaDoLead";
import { BotaoNovaAba } from "./BotaoNovaAba";
import { useAbrirPelaConexao } from "./AbrirPelaConexao";
import { useSeletorDeConexao } from "./SeletorDeConexao";
import { ehCanalSocial } from "@/lib/channels/capabilities";

/**
 * A porta para a conversa, dentro do dossiê.
 *
 * ─── Por que não bastava o atalho do card ───────────────────────────────────
 *
 * O card tem o atalho desde o PR do quadro, e ele funciona. Mas o dossiê é para
 * onde se vai quando a pergunta é "o que está acontecendo com este negócio?" — e
 * lá dentro a linha do tempo ANUNCIA "Entrou no funil / primeira mensagem
 * recebida no WhatsApp" e não oferece nenhum jeito de abrir essa conversa.
 *
 * Anunciar um canal e não dar a porta é pior que não anunciar: quem lê procura,
 * não acha, e fecha o painel para ir caçar a conversa na mão no inbox. Foi
 * exatamente esse o caminho do usuário que pediu isto — ele abriu o dossiê
 * justamente porque é onde a informação mora.
 *
 * ─── Por que aqui é um bloco, e no card é uma linha ─────────────────────────
 *
 * No card o espaço é disputado por oito outras coisas e a prévia precisa caber
 * em uma linha discreta. No dossiê não há disputa, e o alvo de clique pode ser
 * grande o suficiente para ser óbvio — que é o defeito que se está consertando.
 *
 * Ausência continua sendo estado normal: negócio criado à mão não tem contato, e
 * contato pode não ter conversa. Nesses casos o bloco não aparece, em vez de um
 * "sem conversa" cinza que ocuparia o mesmo espaço para não dizer nada.
 *
 * ─── Sem conversa, mas com contato: a AÇÃO (issue #1993) ─────────────────────
 *
 * O lead do webhook chega com telefone e sem thread. Para ele o bloco não some:
 * vira o botão "Abrir conversa", que reaproveita a rota já existente, abre (ou
 * reabre) a conversa do contato e leva para a Inbox. `contactId`/`phone` são
 * opcionais porque a tela de CONTATO ainda não os passa — sem eles o bloco
 * continua sumindo, como antes.
 *
 * ─── Com conversa: pela conexão de quem clica (16/11/2026) ──────────────────
 *
 * Com `contactId` (a ficha do negócio), os dois botões passam por
 * `useAbrirPelaConexao` — a mesma regra do card. Sem ele (a tela de contato),
 * seguem como elos diretos, como antes.
 */
export function ConversaNoDossie({
  conversa,
  contactId,
  phone,
  leadId,
}: {
  conversa: Contact["conversa"] | null | undefined;
  contactId?: string | null;
  phone?: string | null;
  leadId?: string | null;
}) {
  if (conversa === undefined) return null;
  if (conversa === null) {
    // Mesma guarda do card, antes de montar: sem contato e sem telefone o bloco
    // continua sumindo (regra de sempre), em vez de desenhar um botão mudo.
    return temAlvoParaAbrir(contactId, phone) ? (
      <AbrirConversaDoLead contactId={contactId} phone={phone} leadId={leadId} variante="dossie" />
    ) : null;
  }
  // Sem contato (a tela de contato): os elos diretos de sempre, sem montar
  // router nem query client.
  if (!contactId || ehCanalSocial((conversa as { provider?: string | null }).provider)) {
    return <BlocoDaConversa conversa={conversa} />;
  }
  return <BlocoPelaConexao conversa={conversa} contactId={contactId} phone={phone} leadId={leadId} />;
}

function BlocoPelaConexao({
  conversa,
  contactId,
  phone,
  leadId,
}: {
  conversa: NonNullable<Contact["conversa"]>;
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
  // O seletor de conexão (18/11/2026): marcado com a conexão de quem clica; "Automático" = a
  // regra de sempre.
  const { conexao, seletor } = useSeletorDeConexao();
  return (
    <BlocoDaConversa
      conversa={conversa}
      janela={janela}
      abrindo={abrindo}
      onAbrir={(n) => void abrir(n, conexao)}
      seletor={seletor}
    />
  );
}

function BlocoDaConversa({
  conversa,
  janela,
  abrindo = false,
  onAbrir,
  seletor,
}: {
  conversa: NonNullable<Contact["conversa"]>;
  janela?: ReactNode;
  abrindo?: boolean;
  /** Presente = os dois botões passam pela escolha de conexão. */
  onAbrir?: (novaAba: boolean) => void;
  /** O seletor de conexão, logo abaixo dos botões. */
  seletor?: ReactNode;
}) {
  const t = useT();
  const rd = useMarcaDoPipeline();

  const preview = conversa.preview?.trim();

  const destino = `/app/inbox?id=${conversa.id}`;

  // Dois botões lado a lado (pedido do dono do produto, 12/11/2026): o largo
  // abre a conversa nesta aba; o quadrado, só com o ícone, abre a MESMA
  // conversa numa nova aba e deixa o funil onde estava.
  return (
    <div className="mt-3 space-y-2" data-rd-pipeline={rd("conversa")}>
    <div className="flex items-stretch gap-2">
      {janela}
      <Link
        href={destino}
        onClick={(e) => {
          if (!onAbrir) return;
          e.preventDefault();
          // Ctrl/Cmd/Shift-clique pede nova aba: o mesmo fluxo, em nova aba.
          onAbrir(e.metaKey || e.ctrlKey || e.shiftKey);
        }}
        onAuxClick={(e) => {
          if (!onAbrir || e.button !== 1) return;
          e.preventDefault();
          onAbrir(true);
        }}
        aria-busy={abrindo}
        className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-md border border-border bg-muted/40 px-3 py-2 transition-colors hover:border-primary/40 hover:bg-muted"
      >
        <ChatCircle size={16} weight="regular" className="shrink-0 text-text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-text">
            {t("Abrir conversa no Chat do CRM")}
          </span>
          {preview && (
            // A última mensagem responde "vale a pena entrar agora?" sem entrar —
            // sem ela o botão é uma aposta, e o dossiê já existe para não obrigar
            // a abrir outra tela para saber.
            <span className="block truncate text-2xs text-text-muted">{preview}</span>
          )}
        </span>
        {conversa.unread > 0 && (
          // O número, não um ponto: "3 sem ler" e "12 sem ler" pedem urgências
          // diferentes, e um ponto colapsa as duas.
          <span
            className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-2xs font-medium text-primary-foreground tabular-nums"
            aria-label={`${conversa.unread} ${t("sem ler")}`}
          >
            {conversa.unread}
          </span>
        )}
        <ArrowRight
          size={14}
          weight="regular"
          className="shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </Link>
      {onAbrir ? (
        <BotaoNovaAba onClick={() => onAbrir(true)} disabled={abrindo} />
      ) : (
        <BotaoNovaAba href={destino} />
      )}
    </div>
    {seletor}
    </div>
  );
}
