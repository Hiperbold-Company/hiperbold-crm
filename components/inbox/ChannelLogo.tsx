"use client";

import { useId } from "react";
import { ChatCircle } from "@/lib/ui/icons";
import { channelBrand } from "@/lib/channels/presentation";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import type { ChannelSummary } from "@/hooks/inbox/useConversationsRealtime";

/**
 * Selo do canal: azulejo arredondado na cor da marca com o desenho em branco
 * (decisão do dono do produto, 03/11/2026). O azulejo segura o contraste em
 * 16px no canto do avatar, onde o desenho solto sumia. Cores das marcas são
 * fixas nos dois temas: são a identidade do canal, não tokens do produto.
 */
const NOMES = { whatsapp: "WhatsApp", instagram: "Instagram", messenger: "Messenger" } as const;
type Marca = keyof typeof NOMES;

const GRADIENTES: Record<Exclude<Marca, "whatsapp">, [string, string][]> = {
  messenger: [
    ["0", "#0099FF"],
    [".6", "#A033FF"],
    ["1", "#FF5280"],
  ],
  instagram: [
    ["0", "#FEDA75"],
    [".3", "#FA7E1E"],
    [".6", "#D62976"],
    ["1", "#4F5BD5"],
  ],
};

function Desenho({ marca }: { marca: Marca }) {
  if (marca === "whatsapp") {
    return (
      <>
        <path
          d="M12 3.2a8.8 8.8 0 0 0-7.6 13.2L3.2 20.8l4.5-1.2A8.8 8.8 0 1 0 12 3.2z"
          fill="none"
          stroke="#fff"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path
          d="M9.3 7.9c.2-.4.4-.4.7-.4h.5c.2 0 .4.1.5.4l.7 1.8c.1.3 0 .5-.1.7l-.5.6c-.1.1-.1.3 0 .5.6 1 1.4 1.8 2.4 2.4.2.1.4.1.5 0l.6-.5c.2-.2.5-.2.7-.1l1.8.7c.3.1.4.3.4.5v.5c0 .3-.1.6-.4.8-.6.4-1.4.6-2.2.4-2.9-.8-5.2-3.1-6-6-.2-.8 0-1.6.4-2.3z"
          fill="#fff"
        />
      </>
    );
  }
  if (marca === "messenger") {
    return (
      <>
        <path
          d="M12 3C7 3 3 6.7 3 11.3c0 2.6 1.3 4.9 3.3 6.4V21l3-1.7c.8.2 1.7.3 2.7.3 5 0 9-3.7 9-8.3S17 3 12 3z"
          fill="#fff"
        />
        <path d="M6.8 14.2l3.9-4.2 2.1 2.1 4.4-2.3-3.9 4.2-2.1-2.1z" fill="#7B3BFF" />
      </>
    );
  }
  return (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="3.9" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="17" cy="7" r="1.2" fill="#fff" />
    </>
  );
}

export function ChannelLogo({ channel, size = 18, className }: {
  channel?: ChannelSummary | null;
  size?: number;
  className?: string;
}) {
  const t = useT();
  // Um id por instância: a lista do Chat desenha dezenas de selos na mesma página.
  const gradienteId = `canal-${useId().replace(/:/g, "")}`;
  const marca = channelBrand(channel);
  if (marca === "unknown") {
    const nome = t("Canal");
    return <span role="img" aria-label={nome} title={nome} className={cn("inline-flex shrink-0 items-center justify-center text-muted-foreground", className)}>
      <ChatCircle size={size} weight="fill" aria-hidden />
    </span>;
  }
  const nome = NOMES[marca];
  // Em tamanho pequeno o desenho ocupa mais do azulejo para não sumir.
  const margem = size <= 18 ? 7 : 8;
  return <span role="img" aria-label={nome} title={nome} className={cn("inline-flex shrink-0 items-center justify-center", className)}>
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      {marca === "whatsapp" ? (
        <rect width="40" height="40" rx="10" fill="#25D366" />
      ) : (
        <>
          <defs>
            <linearGradient id={gradienteId} x1="0" y1="1" x2="1" y2="0">
              {GRADIENTES[marca].map(([offset, cor]) => (
                <stop key={offset} offset={offset} stopColor={cor} />
              ))}
            </linearGradient>
          </defs>
          <rect width="40" height="40" rx="10" fill={`url(#${gradienteId})`} />
        </>
      )}
      <svg x={margem} y={margem} width={40 - margem * 2} height={40 - margem * 2} viewBox="0 0 24 24">
        <Desenho marca={marca} />
      </svg>
    </svg>
  </span>;
}
