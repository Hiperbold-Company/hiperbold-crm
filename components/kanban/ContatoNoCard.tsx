"use client";

import type { ReactNode } from "react";

import { ListaDeLinks } from "@/components/contacts/ListaDeLinks";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDaOrigem } from "@/lib/contacts/origens";
import {
  LINHAS_PADRAO,
  valorDaLinha,
  type CampoDoCartao,
  type LeadDoCartao,
} from "@/lib/kanban/linhas-do-cartao";
import type { Lead } from "@/lib/types/leads";
import { Buildings, ChatCircle, EnvelopeSimple, IdentificationCard, Phone, Signpost } from "@/lib/ui/icons";

interface Props {
  lead: Partial<LeadDoCartao> & Pick<Lead, "contact_links"> & { conversa?: Lead["conversa"] };
  /**
   * As linhas que o funil escolheu ("Editar cartão"), na ordem. Ausente = o
   * padrão (última mensagem e telefone), que é o card de sempre.
   */
  linhas?: readonly CampoDoCartao[];
}

/**
 * A área de contato do card: ATÉ 5 linhas configuráveis por funil
 * (`lib/kanban/linhas-do-cartao.ts`) e, depois delas, os links do contato
 * (Instagram, site…), que não são linha configurável e seguem sempre.
 *
 * Linha sem valor SOME: nem "—", nem altura reservada. O card não reserva
 * espaço para o que não existe, e some por inteiro quando não há nada.
 *
 * A última mensagem é SÓ TEXTO (decisão do dono do produto): sem clique e sem
 * atalho para a conversa. Clicar nela abre o dossiê, como o resto do card; o
 * atalho para o chat mora no dossiê.
 *
 * Cada link é um `<a>` com `stopPropagation`: o card inteiro abre o dossiê ao
 * clique, e abrir o Instagram de alguém não pode abrir o dossiê por cima. Só
 * se renderiza o que começa com http(s): um valor estranho que chegue por outro
 * caminho (evento em tempo real, cache antigo) não vira `javascript:` clicável.
 */
export function ContatoNoCard({ lead, linhas = LINHAS_PADRAO }: Props) {
  const links = (lead.contact_links ?? []).filter(({ href }) => /^https?:\/\//i.test(href));
  const preenchidas = linhas
    .map((campo) => ({ campo, valor: valorDaLinha(lead, campo) }))
    .filter((l): l is { campo: CampoDoCartao; valor: string } => l.valor !== null);

  if (preenchidas.length === 0 && links.length === 0) return null;

  return (
    <div className="mt-1 space-y-1 text-xs text-text-muted" data-testid="contato-no-card">
      {preenchidas.map(({ campo, valor }) => (
        <LinhaDoCartao
          key={campo}
          campo={campo}
          valor={valor}
          naoLidas={campo === "ultima_mensagem" ? (lead.conversa?.unread ?? 0) : 0}
        />
      ))}
      {links.length > 0 && (
        <ListaDeLinks links={links} aoClicarNoLink={(e) => e.stopPropagation()} />
      )}
    </div>
  );
}

/** Uma linha do cartão: ícone (ou prefixo curto) + valor, em uma linha cortada. */
export function LinhaDoCartao({
  campo,
  valor,
  naoLidas = 0,
}: {
  campo: CampoDoCartao;
  valor: string;
  naoLidas?: number;
}) {
  const t = useT();
  let icone: ReactNode = null;
  let rotulo = "";
  let dica: string | undefined;
  let exibido = valor;
  let numerico = false;
  switch (campo) {
    case "telefone":
      icone = <Phone size={12} aria-hidden className="shrink-0" />;
      rotulo = t("Telefone");
      numerico = true;
      break;
    case "email":
      icone = <EnvelopeSimple size={12} aria-hidden className="shrink-0" />;
      rotulo = t("E-mail");
      break;
    case "empresa":
      icone = <Buildings size={12} aria-hidden className="shrink-0" />;
      rotulo = t("Empresa");
      break;
    case "cargo":
      icone = <IdentificationCard size={12} aria-hidden className="shrink-0" />;
      rotulo = t("Cargo");
      break;
    case "ultima_mensagem":
      icone = <ChatCircle size={12} aria-hidden className="shrink-0" />;
      rotulo = t("Última mensagem");
      break;
    case "origem":
      icone = <Signpost size={12} aria-hidden className="shrink-0" />;
      rotulo = t("Origem");
      exibido = rotuloDaOrigem(valor);
      break;
    case "utm_source":
      rotulo = "source";
      dica = t("utm_source: de onde veio o clique (ex.: google, instagram)");
      break;
    case "utm_medium":
      rotulo = "medium";
      dica = t("utm_medium: o tipo de mídia (ex.: cpc, email, social)");
      break;
    case "utm_campaign":
      rotulo = "campaign";
      dica = t("utm_campaign: o nome da campanha");
      break;
  }
  const ehUtm = campo.startsWith("utm_");

  return (
    <span
      className={`flex min-w-0 items-center gap-1 ${numerico ? "tabular-nums" : ""}`}
      data-linha-do-cartao={campo}
      title={dica ?? `${rotulo}: ${exibido}`}
    >
      {icone}
      {ehUtm ? (
        <span className="shrink-0 font-medium">{rotulo}</span>
      ) : (
        <span className="sr-only">{rotulo}: </span>
      )}
      <span className="truncate">{exibido}</span>
      {naoLidas > 0 && (
        // O número, não um ponto: "3 sem ler" e "12 sem ler" pedem urgências
        // diferentes. É texto: a linha não tem clique.
        <span
          className="ml-auto shrink-0 rounded-full bg-primary px-1.5 text-2xs font-medium text-primary-foreground tabular-nums"
          aria-label={`${naoLidas} ${t("sem ler")}`}
        >
          {naoLidas}
        </span>
      )}
    </span>
  );
}
