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
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useFollowupFlows } from "@/hooks/followup/useFollowupFlows";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

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
  /** Aparece na lista mas não pode ser escolhida (ex.: recurso fora do plano, D-227). */
  desabilitada?: boolean;
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
        <option key={o.valor} value={o.valor} disabled={o.desabilitada}>
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
  vazio,
  onLimpar,
}: {
  id: string;
  valor: FieldRef | null;
  onChange: (ref: FieldRef) => void;
  /** Na escrita some o que é só leitura (variáveis, etapa/funil/situação, que têm ação própria). */
  paraEscrita?: boolean;
  /** Rótulo da opção vazia ESCOLHÍVEL (ex.: "Não salvar"); ausente = a vazia só aparece desabilitada. */
  vazio?: string;
  onLimpar?: () => void;
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
    .map(([k]) => ({
      valor: `lead:${k}`,
      rotulo: t(CAMPOS_PADRAO_DO_NEGOCIO[k as keyof typeof CAMPOS_PADRAO_DO_NEGOCIO]),
    }));
  const contato = Object.entries(CAMPOS_PADRAO_DO_CONTATO)
    .filter(([k]) => !paraEscrita || !CAMPOS_SO_LEITURA.contact.has(k))
    .map(([k]) => ({
      valor: `contact:${k}`,
      rotulo: t(CAMPOS_PADRAO_DO_CONTATO[k as keyof typeof CAMPOS_PADRAO_DO_CONTATO]),
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
        if (e.target.value === "") {
          onLimpar?.();
          return;
        }
        const ref = campoDoValor(e.target.value);
        if (ref) onChange(ref);
      }}
    >
      {vazio !== undefined ? (
        <option value="">{vazio}</option>
      ) : (
        <option value="" disabled>
          {t("Escolha o campo")}
        </option>
      )}
      {blocos}
      {/* Campo gravado que não está mais declarado em funil nenhum: continua visível. */}
      {atual && !conhecidos.has(atual) && (
        <option value={atual}>{atual.replace(/^[a-z_]+:/, "")}</option>
      )}
    </select>
  );
}

/**
 * As automações da organização (a mesma listagem da tela Automações), para a
 * ação "Iniciar outra automação" e o gatilho "Iniciada por outra automação".
 */
export function useAutomacoesDaOrganizacao(enabled = true) {
  return useFollowupFlows({ surface: "automacao", enabled });
}

/** Nomes de etapa, funil, pessoa e automação para as frases dos blocos. */
export function useNomesDaAutomacao(): NomesDaAutomacao {
  const { etapas, funis, carregando, falhou } = useFunis();
  const membros = useAssignableMembers(true);
  const automacoes = useAutomacoesDaOrganizacao();
  const t = useT();
  return useMemo(() => {
    const etapa = new Map(etapas.map((e) => [e.stageId, nomeDaEtapa(e)]));
    const funil = new Map(funis.map((f) => [f.id, f.nome]));
    const pessoa = new Map((membros.data ?? []).map((m) => [m.user_id, rotuloDoMembro(m, t)]));
    const automacao = new Map((automacoes.data ?? []).map((a) => [a.id, a.name]));
    const incerto = carregando || falhou ? "…" : null;
    return {
      etapa: (id) => etapa.get(id) ?? incerto,
      funil: (id) => funil.get(id) ?? incerto,
      pessoa: (id) => pessoa.get(id) ?? (membros.isLoading ? "…" : null),
      automacao: (id) => automacao.get(id) ?? (automacoes.isLoading ? "…" : null),
    };
  }, [etapas, funis, carregando, falhou, membros.data, membros.isLoading, automacoes.data, automacoes.isLoading, t]);
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

/**
 * Ajuda curta sobre as variáveis aceitas nos textos. `{{param.chave}}`: o dado
 * que a automação que iniciou esta passou (ação "Iniciar outra automação").
 */
export const AJUDA_DAS_VARIAVEIS =
  "Aceita variáveis: {{contact.name}}, {{lead.title}}, {{campo.chave}}, {{gatilho.tipo}}, {{param.chave}}, {{sistema.data}}.";

/** Unidades de tempo dos formulários da automação. */
export const UNIDADES_DE_TEMPO = {
  segundos: { ms: 1000, rotulo: "segundos" },
  minutos: { ms: 60_000, rotulo: "minutos" },
  horas: { ms: 3_600_000, rotulo: "horas" },
  dias: { ms: 86_400_000, rotulo: "dias" },
} as const;
export type UnidadeDeTempo = keyof typeof UNIDADES_DE_TEMPO;

/** A maior unidade em que `ms` é um número inteiro (3_600_000 → 1 hora). */
export function unidadeDe(ms: number, unidades: readonly UnidadeDeTempo[]): UnidadeDeTempo {
  const ordem = [...unidades].sort((a, b) => UNIDADES_DE_TEMPO[b].ms - UNIDADES_DE_TEMPO[a].ms);
  return ordem.find((u) => ms > 0 && ms % UNIDADES_DE_TEMPO[u].ms === 0) ?? ordem[ordem.length - 1]!;
}

/**
 * Um tempo com número e unidade ("2 horas"). Devolve milissegundos, ou `null`
 * quando o número não serve (vazio, negativo, quebrado) — quem chama decide o
 * aviso, porque o mínimo e o máximo são do bloco.
 */
export function TempoComUnidade({
  id,
  ms,
  unidades,
  onChange,
}: {
  id: string;
  ms: number;
  unidades: readonly UnidadeDeTempo[];
  onChange: (ms: number | null) => void;
}) {
  const t = useT();
  const [unidade, setUnidade] = useState<UnidadeDeTempo>(() => unidadeDe(ms, unidades));
  const [numero, setNumero] = useState(() => String(ms / UNIDADES_DE_TEMPO[unidadeDe(ms, unidades)].ms));
  const emitir = (texto: string, u: UnidadeDeTempo) => {
    const n = Number(texto);
    onChange(texto.trim() !== "" && Number.isInteger(n) && n > 0 ? n * UNIDADES_DE_TEMPO[u].ms : null);
  };
  return (
    <div className="flex gap-2">
      <Input
        id={id}
        type="number"
        min={1}
        className="w-28"
        value={numero}
        data-testid={id}
        onChange={(e) => {
          setNumero(e.target.value);
          emitir(e.target.value, unidade);
        }}
      />
      <Seletor
        id={`${id}-unidade`}
        valor={unidade}
        opcoes={unidades.map((u) => ({ valor: u, rotulo: t(UNIDADES_DE_TEMPO[u].rotulo) }))}
        onChange={(v) => {
          setUnidade(v as UnidadeDeTempo);
          emitir(numero, v as UnidadeDeTempo);
        }}
      />
    </div>
  );
}

/** Uma variável de resposta que um bloco anterior deixa para os seguintes. */
export interface RespostaDisponivel {
  /** `{{resposta.<chave>}}`, pronto para colar. */
  variavel: string;
  /** Rótulo do bloco que a produz. */
  origem: string;
}

/**
 * A ajuda das variáveis do texto: as fixas e as respostas dos blocos de
 * pergunta e de mensagem com opções que vêm ANTES deste no fluxo. Clicar numa
 * resposta a acrescenta ao fim do texto.
 */
export function AjudaDeVariaveis({
  respostas = [],
  onInserir,
  testId,
}: {
  respostas?: RespostaDisponivel[];
  onInserir?: (variavel: string) => void;
  testId?: string;
}) {
  const t = useT();
  return (
    <div className="space-y-1" data-testid={testId}>
      <p className="text-xs text-text-muted">{t(AJUDA_DAS_VARIAVEIS)}</p>
      {respostas.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-text-muted">{t("Respostas dos blocos anteriores:")}</span>
          {respostas.map((r) => (
            <Button
              key={r.variavel}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-1.5 font-mono text-[11px]"
              title={r.origem}
              data-testid={`inserir-variavel-${r.variavel}`}
              onClick={() => onInserir?.(r.variavel)}
            >
              {r.variavel}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Aviso fixo de Mensagem e Pergunta numa automação que começa por comentário do
 * Instagram: a conversa do Direct só abre quando a pessoa responde (a resposta
 * privada é o único primeiro envio). A publicação recusa o bloco que vem antes
 * de um "Aguardar o contato responder".
 */
export function AvisoDoDirect() {
  const t = useT();
  return (
    <div
      className="space-y-1 rounded-sm border border-border bg-muted p-2 text-xs text-text-muted"
      data-testid="aviso-do-direct"
    >
      <p>{t("No Instagram, esta mensagem sai pelo Direct de quem comentou.")}</p>
      <p>
        {t(
          "A conversa abre quando a pessoa responde: ponha antes deste bloco um “Aguardar” em “Esperar o contato responder”.",
        )}
      </p>
    </div>
  );
}
