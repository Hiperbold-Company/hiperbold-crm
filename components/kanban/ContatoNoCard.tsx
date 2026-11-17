"use client";

import { ListaDeLinks } from "@/components/contacts/ListaDeLinks";
import { useT } from "@/hooks/i18n/useT";
import type { Lead } from "@/lib/types/leads";
import { Phone } from "@/lib/ui/icons";

interface Props {
  lead: Pick<Lead, "contact_phone" | "contact_email" | "contact_links">;
}

/**
 * Telefone e links do CONTATO, no card do funil. O e-mail não entra: na
 * largura do card ele só aparecia cortado ("lucasladeia1602@g…"), e mora
 * inteiro no dossiê. Decisão do dono do produto.
 *
 * Some por inteiro quando não há nada a mostrar (negócio sem contato é estado
 * normal) — mesma regra do `ConversaSlot`: o card não reserva altura para o que
 * não existe.
 *
 * Cada link é um `<a>` com `stopPropagation`: o card inteiro abre o dossiê ao
 * clique, e abrir o Instagram de alguém não pode abrir o dossiê por cima. O
 * arrasto não é afetado — o dnd não inicia gesto a partir de elemento
 * interativo.
 *
 * O `href` já chega validado do servidor (`linksParaExibir`), e mesmo assim só
 * se renderiza o que começa com http(s): um card que recebesse um valor
 * estranho por outro caminho (evento em tempo real, cache antigo) não vira
 * `javascript:` clicável.
 */
export function ContatoNoCard({ lead }: Props) {
  const t = useT();
  const telefone = lead.contact_phone;
  const links = (lead.contact_links ?? []).filter(({ href }) => /^https?:\/\//i.test(href));

  if (!telefone && links.length === 0) return null;

  return (
    <div className="mt-1 space-y-1 text-xs text-text-muted" data-testid="contato-no-card">
      {telefone && (
        <span className="inline-flex items-center gap-1 tabular-nums">
          <Phone size={12} aria-hidden />
          <span className="sr-only">{t("Telefone")}: </span>
          {telefone}
        </span>
      )}
      {links.length > 0 && (
        <ListaDeLinks links={links} aoClicarNoLink={(e) => e.stopPropagation()} />
      )}
    </div>
  );
}
