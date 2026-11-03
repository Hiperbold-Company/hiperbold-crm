"use client";

/**
 * Peças comuns dos formulários das AUTOMAÇÕES: o seletor nativo, o seletor de
 * campo (padrão + personalizados dos funis), a lista de etapas agrupada por
 * funil e os nomes que o card e as frases usam.
 *
 * `<select>` nativo de propósito: são listas curtas, funcionam no celular sem
 * portal e a prova pela tela consegue escolher a opção pelo rótulo.
 */
import { useQueries } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { CAMPOS_SO_LEITURA } from "@/lib/automacoes/campos";
import type { FieldRef } from "@/lib/automacoes/schemas";
import {
  CAMPOS_PADRAO_DO_CONTATO,
  CAMPOS_PADRAO_DO_NEGOCIO,
  type NomesDaAutomacao,
} from "@/lib/automacoes/vocabulario";
import type { CustomFieldDef } from "@/lib/schemas/settings";
import { etapasPorFunil, nomeDaEtapa } from "@/hooks/followup/useEtapasDeGatilho";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useT } from "@/hooks/i18n/useT";

import { useEtapasDoFluxo } from "../../EtapasDoFluxo";

export const CLASSE_DO_SELETOR =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm text-text disabled:opacity-60";

export function Campo({
  id,
  rotulo,
  children,
  ajuda,
}: {
  id: string;
  rotulo: string;
  children: ReactNode;
  ajuda?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{rotulo}</Label>
      {children}
      {ajuda && <p className="text-xs text-text-muted">{ajuda}</p>}
    </div>
  );
}

export interface Opcao {
  valor: string;
  rotulo: string;
}

export function Seletor({
  id,
  valor,
  opcoes,
  onChange,
  vazio,
  testId,
}: {
  id: string;
  valor: string;
  opcoes: Opcao[];
  onChange: (valor: string) => void;
  /** Rótulo da opção vazia; ausente = sem opção vazia. */
  vazio?: string;
  testId?: string;
}) {
  return (
    <select
      id={id}
      className={CLASSE_DO_SELETOR}
      value={valor}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId ?? id}
    >
      {vazio !== undefined && <option value="">{vazio}</option>}
      {opcoes.map((o) => (
        <option key={o.valor} value={o.valor}>
          {o.rotulo}
        </option>
      ))}
    </select>
  );
}

/** Funis da organização, na ordem em que as etapas chegaram. */
export function useFunis() {
  const { etapas, carregando, falhou } = useEtapasDoFluxo();
  const funis = useMemo(() => etapasPorFunil(etapas), [etapas]);
  return { funis, etapas, carregando, falhou };
}

/** Opções de etapa de UM funil (ou de todos, agrupadas pelo nome do funil no rótulo). */
export function opcoesDeEtapa(
  etapas: ReturnType<typeof useFunis>["etapas"],
  pipelineId?: string,
): Opcao[] {
  return etapas
    .filter((e) => !pipelineId || e.pipelineId === pipelineId)
    .map((e) => ({ valor: e.stageId, rotulo: pipelineId ? e.stageName : nomeDaEtapa(e) }));
}

/** Campos personalizados declarados nos funis da organização (sem repetir a chave). */
export function useCamposPersonalizados(): CustomFieldDef[] {
  const { funis } = useFunis();
  const consultas = useQueries({
    queries: funis.map((f) => ({
      queryKey: ["pipelines", f.id, "fields"],
      queryFn: async () =>
        apiClient.get<{ data: CustomFieldDef[] }>(`/api/v1/pipelines/${f.id}/fields`),
      staleTime: 60_000,
    })),
  });
  const chave = consultas.map((c) => c.dataUpdatedAt).join(",");
  return useMemo(() => {
    const vistos = new Map<string, CustomFieldDef>();
    for (const c of consultas) {
      for (const campo of c.data?.data ?? [])
        if (!vistos.has(campo.key)) vistos.set(campo.key, campo);
    }
    return [...vistos.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave]);
}

/** Valor serializado de um `FieldRef` no `<select>`. */
export function valorDoCampo(ref: FieldRef): string {
  return ref.scope === "var" ? `var:${ref.path}` : `${ref.scope}:${ref.key}`;
}

export function campoDoValor(valor: string): FieldRef | null {
  const i = valor.indexOf(":");
  if (i < 0) return null;
  const scope = valor.slice(0, i);
  const key = valor.slice(i + 1);
  switch (scope) {
    case "contact":
      return key in CAMPOS_PADRAO_DO_CONTATO
        ? { scope, key: key as keyof typeof CAMPOS_PADRAO_DO_CONTATO }
        : null;
    case "lead":
      return key in CAMPOS_PADRAO_DO_NEGOCIO
        ? { scope, key: key as keyof typeof CAMPOS_PADRAO_DO_NEGOCIO }
        : null;
    case "contact_custom":
    case "lead_custom":
      return { scope, key };
    case "var":
      return { scope, path: key };
    default:
      return null;
  }
}

/**
 * Seletor de campo: os padrões do negócio e do contato, os personalizados dos
 * funis (gravados no negócio) e, para leitura, as variáveis do gatilho.
 */
export function SeletorDeCampo({
  id,
  valor,
  onChange,
  paraEscrita = false,
}: {
  id: string;
  valor: FieldRef | null;
  onChange: (ref: FieldRef) => void;
  /** Na escrita some o que é só leitura (variáveis, etapa/funil/situação, que têm ação própria). */
  paraEscrita?: boolean;
}) {
  const t = useT();
  const personalizados = useCamposPersonalizados();
  const atual = valor ? valorDoCampo(valor) : "";
  const conhecidos = new Set<string>();
  const grupo = (rotulo: string, itens: Opcao[]) => {
    for (const o of itens) conhecidos.add(o.valor);
    return (
      <optgroup label={rotulo}>
        {itens.map((o) => (
          <option key={o.valor} value={o.valor}>
            {o.rotulo}
          </option>
        ))}
      </optgroup>
    );
  };
  const negocio = Object.entries(CAMPOS_PADRAO_DO_NEGOCIO)
    .filter(([k]) => !paraEscrita || !CAMPOS_SO_LEITURA.lead.has(k))
    .map(([k, r]) => ({ valor: `lead:${k}`, rotulo: t(r) }));
  const contato = Object.entries(CAMPOS_PADRAO_DO_CONTATO)
    .filter(([k]) => !paraEscrita || !CAMPOS_SO_LEITURA.contact.has(k))
    .map(([k, r]) => ({
    valor: `contact:${k}`,
    rotulo: t(r),
  }));
  const custom = personalizados.map((c) => ({ valor: `lead_custom:${c.key}`, rotulo: c.label }));
  const variaveis = paraEscrita
    ? []
    : [
        { valor: "var:gatilho.tipo", rotulo: t("Gatilho: como começou") },
        { valor: "var:gatilho.fonte_id", rotulo: t("Gatilho: fonte de captação") },
      ];
  const blocos = (
    <>
      {grupo(t("Negócio"), negocio)}
      {custom.length > 0 && grupo(t("Campos personalizados do negócio"), custom)}
      {grupo(t("Contato"), contato)}
      {variaveis.length > 0 && grupo(t("Gatilho"), variaveis)}
    </>
  );
  return (
    <select
      id={id}
      className={CLASSE_DO_SELETOR}
      value={atual}
      data-testid={id}
      onChange={(e) => {
        const ref = campoDoValor(e.target.value);
        if (ref) onChange(ref);
      }}
    >
      <option value="" disabled>
        {t("Escolha o campo")}
      </option>
      {blocos}
      {/* Campo gravado que não está mais declarado em funil nenhum: continua visível. */}
      {atual && !conhecidos.has(atual) && (
        <option value={atual}>{atual.replace(/^[a-z_]+:/, "")}</option>
      )}
    </select>
  );
}

/** Nomes de etapa, funil e pessoa para as frases dos blocos. */
export function useNomesDaAutomacao(): NomesDaAutomacao {
  const { etapas, funis, carregando, falhou } = useFunis();
  const membros = useAssignableMembers(true);
  return useMemo(() => {
    const etapa = new Map(etapas.map((e) => [e.stageId, nomeDaEtapa(e)]));
    const funil = new Map(funis.map((f) => [f.id, f.nome]));
    const pessoa = new Map((membros.data ?? []).map((m) => [m.user_id, m.full_name ?? m.user_id]));
    const incerto = carregando || falhou ? "…" : null;
    return {
      etapa: (id) => etapa.get(id) ?? incerto,
      funil: (id) => funil.get(id) ?? incerto,
      pessoa: (id) => pessoa.get(id) ?? (membros.isLoading ? "…" : null),
    };
  }, [etapas, funis, carregando, falhou, membros.data, membros.isLoading]);
}

/** Lista "a, b, c" → array limpo (sem vazio, sem repetido). */
export function listaDeTags(texto: string): string[] {
  return [
    ...new Set(
      texto
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
}

/** Ajuda curta sobre as variáveis aceitas nos textos. */
export const AJUDA_DAS_VARIAVEIS =
  "Aceita variáveis: {{contact.name}}, {{lead.title}}, {{campo.chave}}, {{gatilho.tipo}}, {{sistema.data}}.";
