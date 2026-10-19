"use client";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "@/lib/api/client";
import { useRealtimeChannel, type RealtimeStatus } from "@/hooks/realtime/useRealtimeChannel";
import { useRefetchDeSeguranca, type RefetchDeSeguranca } from "@/hooks/realtime/useRefetchDeSeguranca";
import type { TimelineItemView } from "@/lib/types/contacts";

/**
 * A timeline do dossiê, viva.
 *
 * ⚠️ **NÃO reuse o eco local do board aqui.** As duas superfícies têm
 * polaridades OPOSTAS pelo mesmo motivo: no card, a própria ação já é visível e
 * repetir seria ruído; na timeline, a própria ação é JUSTAMENTE o que se quer
 * ver registrado. Suprimir o eco aqui faria a atividade que o usuário acabou de
 * gerar sumir para ele — e sumir em silêncio, porque ela FOI gravada.
 *
 * A semelhança é a armadilha: dois usos do mesmo mecanismo com polaridade
 * oposta parecem duplicação para quem lê rápido, e "remover duplicação" é o
 * refactor mais aplaudido que existe.
 */
export interface TimelineAoVivo {
  itens: TimelineItemView[];
  isLoading: boolean;
  isError: boolean;
  /**
   * Ids que chegaram por realtime NESTE mount.
   *
   * Existem porque o colapso e o tempo real se anulam: se o evento novo cai
   * dentro de um bloco já colapsado, a timeline vai de "3 ações" para "4 ações"
   * e o usuário NÃO VÊ O QUE CHEGOU — o requisito de agrupar esconde o que o
   * requisito de tempo real promete mostrar.
   *
   * A saída não é expandir o bloco sozinho (isso mudaria retroativamente o que
   * já está na tela e a pessoa perde onde estava lendo): o que chega fica FORA
   * do agrupamento nesta sessão, e só se junta ao bloco numa abertura nova do
   * dossiê. O que vem de fora tem de ser VISTO, não contado.
   */
  chegouAoVivo: Set<string>;
  /** O PIOR dos canais assinados (lead e contato): um canal morto não se esconde atrás do outro vivo. */
  realtimeStatus: string;
  /** Há páginas mais antigas no servidor (a ficha mostra "Carregar mais"). */
  temMais: boolean;
  carregandoMais: boolean;
  carregarMais: () => Promise<void>;
  /**
   * Garante que o evento `id` esteja na lista: pagina para trás até achá-lo. É o
   * que faz o evento RETROATIVO recém-registrado aparecer — a data dele pode cair
   * muito além da primeira página, e sem isto a pessoa registraria e não veria.
   */
  revelarEvento: (id: string) => Promise<void>;
  /** A rede que cura a perda e denuncia a falha — ver o hook. */
  seguranca: RefetchDeSeguranca;
}

/**
 * `?escopo=contato`: a ficha conta a história do CONTATO (todos os negócios dele
 * e o que foi registrado nele), cada linha com o negócio e o funil de origem.
 * Lead sem contato continua com o eixo do negócio — a rota decide.
 */
export interface PaginaDaTimeline {
  itens: TimelineItemView[];
  hasMore: boolean;
  cursor: string | null;
}

/** A chave da timeline da ficha; quem escreve na timeline invalida por ela. */
export const chaveDaTimeline = (leadId: string | null) => ["timeline", "ficha", leadId] as const;

/** Páginas buscadas, no máximo, por `revelarEvento`: um teto, não uma promessa. */
const MAXIMO_DE_PAGINAS_PARA_REVELAR = 20;

async function fetchTimeline(leadId: string, cursor: string | null): Promise<PaginaDaTimeline> {
  const qs = new URLSearchParams({ escopo: "contato" });
  if (cursor) qs.set("cursor", cursor);
  const res = await apiClient.get<{
    data: TimelineItemView[];
    meta?: { has_more?: boolean; cursor?: string | null };
  }>(`/api/v1/leads/${leadId}/timeline?${qs.toString()}`);
  const itens = Array.isArray(res) ? (res as unknown as TimelineItemView[]) : (res?.data ?? []);
  return {
    itens,
    hasMore: Boolean(res?.meta?.has_more),
    cursor: res?.meta?.cursor ?? null,
  };
}

const GRAVIDADE: Record<RealtimeStatus, number> = {
  subscribed: 0,
  connecting: 1,
  closed: 2,
  timed_out: 3,
  channel_error: 4,
};

/** O pior de uma lista de estados de canal. */
export function piorStatus(estados: RealtimeStatus[]): RealtimeStatus {
  return estados.reduce((pior, atual) => (GRAVIDADE[atual] > GRAVIDADE[pior] ? atual : pior), estados[0] ?? "closed");
}

/** O id da atividade dentro do payload do postgres_changes. */
function idDoEvento(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { new?: { id?: unknown } };
  return typeof p.new?.id === "string" ? p.new.id : null;
}

export function useLeadTimeline(
  leadId: string | null,
  contactId: string | null,
): TimelineAoVivo {
  const qc = useQueryClient();
  const queryKey = chaveDaTimeline(leadId);
  const [chegouAoVivo, setChegouAoVivo] = useState<Set<string>>(new Set());
  // `useRef` para o Set não virar dependência do callback e o canal não
  // re-assinar a cada evento — re-assinar perderia eventos na janela.
  const recebidos = useRef<Set<string>>(new Set());

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchTimeline(leadId as string, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (ultima) => (ultima.hasMore ? ultima.cursor : undefined),
    enabled: !!leadId,
  });
  // A versão mais nova do `query` para os callbacks assíncronos (que sobrevivem a renders).
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  });

  const carregarMais = useCallback(async () => {
    if (queryRef.current.hasNextPage && !queryRef.current.isFetchingNextPage) {
      await queryRef.current.fetchNextPage();
    }
  }, []);

  const revelarEvento = useCallback(
    async (id: string) => {
      for (let i = 0; i < MAXIMO_DE_PAGINAS_PARA_REVELAR; i++) {
        const dados = qc.getQueryData<InfiniteData<PaginaDaTimeline>>(queryKey);
        if (dados?.pages.some((p) => p.itens.some((it) => it.id === id))) return;
        if (!queryRef.current.hasNextPage) return;
        await queryRef.current.fetchNextPage();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qc, leadId],
  );

  const onChange = useCallback(
    (payload: unknown) => {
      qc.invalidateQueries({ queryKey });
      const id = idDoEvento(payload);
      if (!id || recebidos.current.has(id)) return;
      recebidos.current.add(id);
      setChegouAoVivo(new Set(recebidos.current));
    },
    [qc, queryKey],
  );

  // DOIS CANAIS, porque o supabase-js só aceita filtro simples por assinatura:
  //  - `lead_id`: tudo do negócio aberto — cobre 100% do que existe hoje, inclusive
  //    o lead SEM contato;
  //  - `contact_id`: o que acontece nos negócios irmãos e direto no contato. A
  //    ficha mostra a história da pessoa, então uma ligação registrada no outro
  //    funil tem de aparecer sem recarregar.
  // A atividade de um irmão gravada SEM `contact_id` não chega ao vivo; chega pelo
  // refetch da invalidação e pela rede de segurança abaixo. Limitação conhecida e
  // escrita, não descoberta depois. A rota (`leads/[id]/timeline?escopo=contato`)
  // resolve o eixo completo; o canal só avisa que algo mudou.
  //
  // O carimbo de entrega é UM só para os dois canais: a rede de segurança precisa
  // saber se ALGUM deles trouxe o que mudou, e olhar só o primeiro acusaria perda
  // numa entrega que o segundo fez.
  const entrega = useRef<number | null>(null);
  const aoReceber = useCallback(
    (payload: unknown) => {
      entrega.current = Date.now();
      onChange(payload);
    },
    [onChange],
  );
  const { status: statusDoLead } = useRealtimeChannel({
    name: leadId ? `timeline-${leadId}` : "timeline-disabled",
    postgresChanges: leadId
      ? {
          event: "INSERT",
          schema: "public",
          table: "crm_lead_activities",
          filter: `lead_id=eq.${leadId}`,
        }
      : undefined,
    onChange: aoReceber,
    enabled: !!leadId,
  });
  const { status: statusDoContato } = useRealtimeChannel({
    name: contactId ? `timeline-contato-${contactId}` : "timeline-contato-disabled",
    postgresChanges: contactId
      ? {
          event: "INSERT",
          schema: "public",
          table: "crm_lead_activities",
          filter: `contact_id=eq.${contactId}`,
        }
      : undefined,
    onChange: aoReceber,
    enabled: !!leadId && !!contactId,
  });

  // A REDE, aqui pelo mesmo motivo do board e com um agravante: o dossiê está
  // INTEIRAMENTE quebrado quando a entrega morre — a timeline nunca recupera,
  // nem por tempo nem ao voltar para a aba. E o dossiê é a superfície que
  // PROMETE contar a vida do negócio: uma timeline congelada não parece
  // congelada, parece um negócio sem novidade.
  //
  // A assinatura é a contagem mais o id do item mais recente: sensível a
  // exatamente o que o canal deveria ter trazido (atividade nova), e insensível
  // a reordenação — que não é perda.
  const seguranca = useRefetchDeSeguranca<InfiniteData<PaginaDaTimeline>>({
    queryKey,
    assinatura: (d) =>
      `${d?.pages.reduce((n, p) => n + p.itens.length, 0) ?? 0}:${d?.pages[0]?.itens[0]?.id ?? ""}`,
    ultimaEntrega: entrega,
    enabled: !!leadId,
  });

  const realtimeStatus = piorStatus(
    contactId ? [statusDoLead, statusDoContato] : [statusDoLead],
  );

  return {
    itens: query.data?.pages.flatMap((p) => p.itens) ?? [],
    temMais: query.hasNextPage ?? false,
    carregandoMais: query.isFetchingNextPage,
    carregarMais,
    revelarEvento,
    isLoading: query.isLoading,
    isError: query.isError,
    chegouAoVivo,
    realtimeStatus,
    seguranca,
  };
}
