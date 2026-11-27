"use client";

import { useT } from "@/hooks/i18n/useT";
import { BotaoIniciarConversa } from "@/components/inbox/PainelIniciarConversa";

/**
 * O alto da lista no redesign (protótipo v49): o título "Conversas" e, ao lado,
 * o botão principal de iniciar conversa. É o MESMO botão de sempre (mesma
 * permissão `inbox.claim`, mesmo diálogo); só muda onde e como ele aparece.
 */
export function CabecalhoDaLista() {
  const t = useT();
  return (
    <div
      data-rd-chat="cabecalho-da-lista"
      className="flex items-center justify-between gap-2 px-4 pt-4"
    >
      <h1 data-rd-chat="titulo-da-lista" className="text-xl font-bold">
        {t("Conversas")}
      </h1>
      <BotaoIniciarConversa noCabecalho />
    </div>
  );
}
