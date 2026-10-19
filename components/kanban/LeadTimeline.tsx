"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import {
  activityLabel,
  actorLabel,
  actorName,
  actorShape,
} from "@/lib/leads/activity-vocabulary";
import { agrupaTimeline, ehBlocoColapsavel, ehBlocoDeDia } from "@/lib/leads/timeline-grouping";
import { eventoManualDaAtividade, foiRetroativo, ROTULO_DO_SUBTIPO, type SubtipoDeEventoManual } from "@/lib/leads/evento-manual";
import { EnvelopeSimple, Note, Phone, UsersThree, WhatsappLogo, DotsThree } from "@/lib/ui/icons";
import type { TimelineItemView } from "@/lib/types/contacts";

interface Props {
  /** O negócio ABERTO: evento de outro negócio do contato ganha a indicação de origem. */
  leadId: string;
  itens: TimelineItemView[];
  /** Ids que chegaram por realtime nesta sessão — ficam FORA do agrupamento. */
  chegouAoVivo: Set<string>;
  isLoading: boolean;
  isError: boolean;
  /** Há história mais antiga no servidor: mostra "Carregar mais". */
  temMais?: boolean;
  carregandoMais?: boolean;
  aoCarregarMais?: () => void;
}

function quando(iso: string, idioma: string): string {
  try {
    return new Intl.DateTimeFormat(idioma, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** O marcador do ator: FORMA, nunca cor — a cor é da borda de estado (Lei C). */
function Marcador({ item }: { item: TimelineItemView }) {
  const forma = actorShape(item.actor_kind ?? null);
  return (
    <span
      aria-hidden
      className={cn(
        "mt-1 h-2 w-2 shrink-0 rounded-full",
        forma === "filled" && "bg-text",
        forma === "ring" && "border border-text bg-transparent",
        forma === "dashed" && "border border-dashed border-text-muted bg-transparent",
      )}
    />
  );
}

const ICONE_DO_SUBTIPO: Record<SubtipoDeEventoManual, typeof Note> = {
  nota: Note,
  ligacao: Phone,
  reuniao: UsersThree,
  email: EnvelopeSimple,
  whatsapp: WhatsappLogo,
  outro: DotsThree,
};

function Linha({
  item,
  leadId,
  aoVivo,
}: {
  item: TimelineItemView;
  leadId: string;
  aoVivo?: boolean;
}) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const nome = actorName(
    item.actor_kind ?? null,
    {
      agente: item.actor_agent_name ?? null,
      usuario: item.actor_user_name ?? null,
    },
    t,
  );
  const manual = eventoManualDaAtividade(item);
  const Icone = manual ? ICONE_DO_SUBTIPO[manual.subtype] : null;
  // A timeline da ficha é a do CONTATO: o que veio de OUTRO negócio dele diz de
  // qual funil e negócio veio. O do negócio aberto não repete o óbvio.
  const origem =
    item.lead_id !== leadId && (item.negocio_titulo || item.funil_nome)
      ? [item.funil_nome, item.negocio_titulo].filter(Boolean).join(" · ")
      : null;
  return (
    <li className="flex gap-2 py-1.5" data-evento-manual={manual ? manual.subtype : undefined}>
      <Marcador item={item} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-xs text-text">
          {Icone && <Icone size={13} aria-hidden className="shrink-0 text-text-muted" />}
          {manual ? t(ROTULO_DO_SUBTIPO[manual.subtype]) : t(activityLabel(item.type))}
          {aoVivo && (
            // O que chegou AGORA fica marcado: sem isto ele entraria na lista
            // idêntico ao resto e a chegada seria indistinguível do histórico.
            <span className="ml-1.5 text-[10px] uppercase tracking-wide text-accent">
              {/* "agora" é de quem acabou de acontecer. Evento manual RETROATIVO que
                  acabou de ser registrado chegou agora, mas aconteceu antes: "agora" ao
                  lado de uma data de semanas atrás confunde, então vira "novo". */}
              {manual && foiRetroativo(item.performed_at, item.created_at) ? t("novo") : t("agora")}
            </span>
          )}
        </p>
        {origem && (
          <p className="mt-0.5 text-[11px] text-text-muted" data-origem-do-negocio>
            {t("Em")} {origem}
          </p>
        )}
        {manual ? (
          // O texto COMPLETO, com as quebras de linha da pessoa: é o conteúdo do
          // registro, não um resumo — truncar esconderia justamente o que foi
          // anotado.
          <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-text">{manual.text}</p>
        ) : (
          item.reason && <p className="mt-0.5 text-xs text-text-muted">{t(item.reason)}</p>
        )}
        <p className="mt-0.5 text-[11px] text-text-muted">
          {nome} · {quando(item.performed_at, tagDoIdioma)}
          {manual && ` · ${t("registro manual")}`}
        </p>
        {manual && foiRetroativo(item.performed_at, item.created_at) && item.created_at && (
          // Evento anotado muito depois de ocorrer: a data da linha é a do
          // acontecimento, e sem esta o leitor tomaria o registro por contemporâneo.
          <p className="mt-0.5 text-[11px] text-text-muted" data-registrado-em>
            {t("registrado em")} {quando(item.created_at, tagDoIdioma)}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * A timeline do dossiê — linha vertical, marcador por ator, blocos expansíveis.
 *
 * O agrupamento vem de `agrupaTimeline`, que é função pura e testada: decisão
 * humana nunca colapsa, e o que chegou ao vivo nesta sessão fica fora do bloco.
 * Reimplementar a regra aqui dentro seria a mesma falha que o card já pagou —
 * precedência reescrita em componente é rejeição de review.
 */
export function LeadTimeline({
  leadId,
  itens,
  chegouAoVivo,
  isLoading,
  isError,
  temMais = false,
  carregandoMais = false,
  aoCarregarMais,
}: Props) {
  const t = useT();
  const [abertos, setAbertos] = useState<Set<number>>(new Set());
  const blocos = agrupaTimeline(itens, chegouAoVivo);

  if (isLoading) {
    return <p className="py-4 text-xs text-text-muted">{t("Carregando a linha do tempo…")}</p>;
  }
  // TRÊS estados, não dois: "não consegui ler" é diferente de "não há nada".
  // Transformar erro em lista vazia diria ao usuário que o lead não tem
  // história, quando o que houve foi uma falha de leitura.
  if (isError) {
    return (
      <p className="py-4 text-xs text-warning-fg">
        {t("Não consegui carregar a linha do tempo. Tente de novo em instantes.")}
      </p>
    );
  }
  if (itens.length === 0) {
    return (
      <p className="py-4 text-xs text-text-muted">
        {t("Nada aconteceu com este negócio ainda.")}
      </p>
    );
  }

  return (
    <div>
    <ul className="border-l border-border pl-3">
      {blocos.map((b, i) => {
        if (b.tipo === "item") {
          return <Linha leadId={leadId} key={b.item.id} item={b.item} aoVivo={b.aoVivo} />;
        }
        if (b.tipo === "dia") {
          // Bloco de dia com UM item só não vira bloco: "terça · 1 ação" custa
          // um clique e não informa nada que a própria linha não informe.
          if (!ehBlocoDeDia(b)) return <Linha leadId={leadId} key={b.itens[0]!.id} item={b.itens[0]!} />;
          const aberto = abertos.has(i);
          return (
            <li key={b.dia} className="py-1.5">
              <button
                type="button"
                onClick={() =>
                  setAbertos((prev) => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  })
                }
                aria-expanded={aberto}
                className="flex w-full items-center gap-2 text-left text-xs text-text-muted hover:text-text"
              >
                {/* O marcador do dia é uma BARRA, não um ponto: ele não
                    representa um ator, e reusar a forma de ator diria que
                    alguém fez aquilo. */}
                <span aria-hidden className="mt-1 h-2 w-0.5 shrink-0 bg-border" />
                <span className="first-letter:uppercase">{b.rotulo}</span>
                <span className="text-text-muted">· {b.itens.length} {t("ações")}</span>
                <span aria-hidden className="ml-auto text-[10px]">
                  {aberto ? "−" : "+"}
                </span>
              </button>
              {aberto && (
                <ul className="ml-2 border-l border-border pl-3">
                  {b.itens.map((it) => (
                    <Linha leadId={leadId} key={it.id} item={it} />
                  ))}
                </ul>
              )}
            </li>
          );
        }
        if (!ehBlocoColapsavel(b)) {
          return <Linha leadId={leadId} key={b.itens[0]!.id} item={b.itens[0]!} />;
        }
        const aberto = abertos.has(i);
        const primeiro = b.itens[0]!;
        const nome = actorName(
          primeiro.actor_kind ?? null,
          {
            agente: primeiro.actor_agent_name ?? null,
            usuario: primeiro.actor_user_name ?? null,
          },
          t,
        );
        return (
          <li key={`g${i}`} className="py-1.5">
            <button
              type="button"
              onClick={() =>
                setAbertos((prev) => {
                  const next = new Set(prev);
                  if (next.has(i)) next.delete(i);
                  else next.add(i);
                  return next;
                })
              }
              aria-expanded={aberto}
              className="flex w-full items-center gap-2 text-left text-xs text-text-muted hover:text-text"
            >
              <Marcador item={primeiro} />
              <span>
                {nome} · {b.itens.length} {t("ações")}
              </span>
              <span aria-hidden className="ml-auto text-[10px]">
                {aberto ? "−" : "+"}
              </span>
            </button>
            {aberto && (
              <ul className="ml-2 border-l border-border pl-3">
                {b.itens.map((it) => (
                  <Linha leadId={leadId} key={it.id} item={it} />
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
    {temMais && (
      <button
        type="button"
        onClick={() => aoCarregarMais?.()}
        disabled={carregandoMais}
        className="mt-2 w-full rounded-md border border-border py-1.5 text-xs text-text-muted hover:text-text disabled:opacity-60"
      >
        {carregandoMais ? t("Carregando…") : t("Carregar mais")}
      </button>
    )}
    </div>
  );
}
