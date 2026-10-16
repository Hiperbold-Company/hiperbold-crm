"use client";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import { listaRestringe, modelosParaOSeletor } from "@/lib/ai/modelos-da-instalacao";
import { useT } from "@/hooks/i18n/useT";

/**
 * Derivado de `lib/ai/pontos/provedores.ts` — a mesma lista única da tela de
 * Credenciais e da rota. Como literal aqui, o seletor de modelo do agente não
 * conseguia representar um agente publicado em OpenRouter.
 */
export type Provider = (typeof PROVEDORES)[number]["id"];

export interface ModelOption {
  provider: Provider;
  model_id: string;
  display_name: string;
  context_window: number | null;
  is_default_for_provider: boolean;
}

interface Props {
  provider: Provider;
  value: string;
  onChange: (modelId: string, ctx?: { contextWindow: number | null }) => void;
  disabled?: boolean;
  id?: string;
  /**
   * Texto do estado "nada escolhido". Existe porque nem todo uso deste seletor
   * trata vazio como erro: no papel Operador, vazio SIGNIFICA "usa o mesmo
   * modelo que conversa", e chamar isso de "Selecione um modelo" mentiria.
   */
  placeholder?: string;
  /**
   * O agente vai rodar na chave da INSTALAÇÃO (a empresa não tem chave própria
   * deste provedor): só os modelos de `MODELOS_DA_INSTALACAO` são oferecidos. Com
   * chave própria, ou sem esta prop, o catálogo inteiro (freio de custo; o
   * servidor aplica a mesma regra, esta tela só evita a escolha que seria trocada).
   */
  restritoAoPlano?: boolean;
  /**
   * Escolhe sozinho o modelo padrão liberado quando o campo está vazio e a lista é
   * restrita (agente novo). Não usar onde vazio tem significado (papel Operador).
   */
  preselecionarPadrao?: boolean;
}

interface ApiResponse {
  data: { models: ModelOption[]; modelos_da_instalacao?: string[] };
}

/** O catálogo do provedor e a lista liberada na chave da instalação — uma consulta, dois usos. */
function useCatalogoDoProvedor(provider: Provider) {
  return useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return {
        models: res.data.models,
        liberados: res.data.modelos_da_instalacao ?? [],
      };
    },
    staleTime: 60_000,
  });
}

export function ModelPicker({
  provider,
  value,
  onChange,
  disabled,
  id,
  placeholder,
  restritoAoPlano = false,
  preselecionarPadrao = false,
}: Props) {
  const t = useT();
  const query = useCatalogoDoProvedor(provider);

  const catalogo = query.data?.models ?? [];
  const liberados = query.data?.liberados ?? [];
  // Só restringe depois de saber a lista liberada: antes disso (carregando, ou
  // servidor antigo sem o campo) mostra o catálogo como sempre.
  const restrito = restritoAoPlano && liberados.length > 0 && listaRestringe(liberados);
  const models = React.useMemo(
    () => modelosParaOSeletor({ catalogo, liberados, provedor: provider, restrito }),
    [catalogo, liberados, provider, restrito],
  );
  const padrao = restrito ? (models[0]?.model_id ?? "") : "";
  // O modelo salvo que a chave da instalação não executa: continua visível (o
  // seletor não pode abrir em branco) e o aviso diz o que acontece de verdade.
  const salvoForaDaLista = restrito && value !== "" && !models.some((m) => m.model_id === value);

  React.useEffect(() => {
    if (preselecionarPadrao && restrito && value === "" && padrao !== "" && !disabled) {
      onChange(padrao, { contextWindow: catalogo.find((m) => m.model_id === padrao)?.context_window ?? null });
    }
    // onChange vem do pai e muda a cada render; o gatilho é o estado vazio + a lista pronta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselecionarPadrao, restrito, value, padrao, disabled]);

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t("Modelo")}</Label>
      {models.length === 0 && !query.isLoading ? (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value, { contextWindow: null })}
          placeholder={t("Digite o identificador do modelo")}
          disabled={disabled}
        />
      ) : (
        <Select
          value={value || undefined}
          onValueChange={(v) => {
            const m = catalogo.find((m) => m.model_id === v);
            onChange(v, { contextWindow: m?.context_window ?? null });
          }}
          disabled={disabled || query.isLoading}
        >
          <SelectTrigger id={id}>
            <SelectValue
              placeholder={
                query.isLoading ? t("Carregando…") : (placeholder ?? t("Selecione um modelo"))
              }
            />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.model_id} value={m.model_id}>
                {m.display_name}
                {restrito
                  ? m.model_id === padrao
                    ? ` · ${t("default")}`
                    : ""
                  : "is_default_for_provider" in m && m.is_default_for_provider
                    ? ` · ${t("default")}`
                    : ""}
              </SelectItem>
            ))}
            {salvoForaDaLista ? (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      )}
      {salvoForaDaLista ? (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="modelo-so-com-chave-propria">
          {t("Este modelo só funciona com a sua própria chave. Sem ela, o agente usa o Luna.")}
        </p>
      ) : null}
    </div>
  );
}

export function useModelMeta(provider: Provider, modelId: string): ModelOption | null {
  const query = useCatalogoDoProvedor(provider);
  return (query.data?.models ?? []).find((m) => m.model_id === modelId) ?? null;
}
