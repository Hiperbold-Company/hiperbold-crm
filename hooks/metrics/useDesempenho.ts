"use client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { TipoDaLista } from "@/lib/metrics/desempenho";

/**
 * Leituras da tela Desempenho (BI). `query` é a query string já montada por
 * `queryDaApi` (`lib/metrics/desempenho.ts`): período, funil e atendente. As
 * contas são do servidor; aqui só se busca.
 */

export interface CartaoDeNegocios {
  quantidade: number;
  valor_cents: number;
}

export interface DiaDeNegocios {
  dia: string;
  criados: number;
  criados_valor_cents: number;
  ganhos: number;
  ganhos_valor_cents: number;
  perdidos: number;
  perdidos_valor_cents: number;
  em_aberto: number;
  em_aberto_valor_cents: number;
  movimentacoes: number;
}

export interface DesempenhoNegocios {
  janela: { from: string; to: string };
  moeda: string;
  fuso: string;
  fora_da_moeda: number;
  cartoes: Record<"criados" | "ganhos" | "perdidos" | "em_aberto" | "carteira", CartaoDeNegocios>;
  diario: DiaDeNegocios[];
  etapas: Array<{ stage_id: string; nome: string; posicao: number; quantidade: number; valor_cents: number }>;
  funis: Array<{ pipeline_id: string; nome: string; quantidade: number; valor_cents: number }>;
  movimentacoes: {
    total: number;
    por_etapa: Array<{ stage_id: string; nome: string; funil: string; quantidade: number }>;
  };
  atendentes: Array<{
    user_id: string | null;
    name: string | null;
    criados: number;
    ganhos: number;
    perdidos: number;
    valor_ganho_cents: number;
    ticket_medio_cents: number | null;
  }>;
}

export interface LinhaDeOrigem {
  chave: string | null;
  total: number;
  ganhos: number;
  perdidos: number;
  abertos: number;
  valor_ganho_cents: number;
  taxa_de_ganho: number;
}

export interface DesempenhoOrigens {
  janela: { from: string; to: string };
  moeda: string;
  total: number;
  limite: number;
  por_source: LinhaDeOrigem[];
  por_medium: LinhaDeOrigem[];
  por_campaign: LinhaDeOrigem[];
  cortado: { source: boolean; medium: boolean; campaign: boolean };
}

export interface DesempenhoAtendimento {
  janela: { from: string; to: string };
  fuso: string;
  cartoes: {
    atendimentos: number;
    atendimentos_anterior: number;
    finalizados: number;
    em_aberto: number;
    aguardando: number;
  };
  tempos: { primeira_resposta_seg: number | null; resposta_seg: number | null; respostas: number };
  diario: Array<{
    dia: string;
    atendimentos: number;
    primeira_resposta_seg: number | null;
    resposta_seg: number | null;
  }>;
  mapa_de_calor: Array<{ dow: number; hora: number; quantidade: number }>;
  atendentes: Array<{
    user_id: string | null;
    name: string | null;
    atendimentos: number;
    finalizados: number;
    em_aberto: number;
    primeira_resposta_seg: number | null;
    respostas: number;
    resposta_seg: number | null;
  }>;
}

export interface NegocioDaLista {
  id: string;
  titulo: string;
  contato: string | null;
  tags: string[];
  status: string;
  value_cents: number | null;
  currency: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  etapa: string | null;
  progresso: number | null;
  dias_em_aberto: number;
  dias_na_etapa: number | null;
}

export interface ListaDeNegocios {
  tipo: TipoDaLista;
  pagina: number;
  por_pagina: number;
  total: number;
  negocios: NegocioDaLista[];
}

const VIVO = 30_000;

export function useDesempenhoNegocios(query: string, enabled = true) {
  return useQuery({
    queryKey: ["metrics", "desempenho", "negocios", query],
    queryFn: async () => apiClient.get<{ data: DesempenhoNegocios }>(`/api/v1/metrics/negocios?${query}`),
    staleTime: VIVO,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useDesempenhoOrigens(query: string, enabled = true) {
  return useQuery({
    queryKey: ["metrics", "desempenho", "origens", query],
    queryFn: async () => apiClient.get<{ data: DesempenhoOrigens }>(`/api/v1/metrics/origens?${query}`),
    staleTime: VIVO,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useDesempenhoAtendimento(query: string, enabled = true) {
  return useQuery({
    queryKey: ["metrics", "desempenho", "atendimento", query],
    queryFn: async () =>
      apiClient.get<{ data: DesempenhoAtendimento }>(`/api/v1/metrics/atendimento?${query}`),
    staleTime: VIVO,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useListaDeNegocios(query: string, tipo: TipoDaLista, pagina: number) {
  return useQuery({
    queryKey: ["metrics", "desempenho", "lista", query, tipo, pagina],
    queryFn: async () =>
      apiClient.get<{ data: ListaDeNegocios }>(
        `/api/v1/metrics/negocios/lista?${query}&tipo=${tipo}&pagina=${pagina}`,
      ),
    staleTime: VIVO,
    placeholderData: keepPreviousData,
  });
}
