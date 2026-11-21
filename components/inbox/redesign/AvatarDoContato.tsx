"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { ContactSummary } from "@/hooks/inbox/useConversationsRealtime";
import { iniciaisDoNome } from "@/lib/ui/iniciais";
import { corDoAvatar } from "@/components/inbox/redesign/marca";

/**
 * O avatar do contato no cabeçalho da conversa aberta (redesign, item B4). Só
 * existe com a chave ligada — o cabeçalho de sempre não tem avatar.
 *
 * A foto segue a regra da lista (`ConversationListItem`): a `<img>` só monta
 * quando há arquivo, e nunca para contato anonimizado; sem foto, as iniciais
 * sobre a cor estável do contato.
 */
export function AvatarDoContato({
  contato,
  nome,
  reserva,
}: {
  contato: ContactSummary | null;
  nome: string;
  reserva: string;
}) {
  return (
    <Avatar
      className="h-10 w-10"
      data-rd-chat="avatar"
      data-rd-cor={corDoAvatar(contato?.id ?? reserva)}
      aria-hidden
    >
      {contato?.avatar_storage_path && !contato.is_anonymized ? (
        <AvatarImage src={`/api/v1/contacts/${contato.id}/avatar`} alt="" className="object-cover" />
      ) : null}
      <AvatarFallback className="text-sm font-semibold">{iniciaisDoNome(nome) ?? "?"}</AvatarFallback>
    </Avatar>
  );
}
