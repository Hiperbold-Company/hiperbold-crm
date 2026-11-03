"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  automacaoTriggerConfigSchema,
  GATILHO_PADRAO,
  type AutomacaoTrigger,
  type AutomacaoTriggerConfig,
  type AutomacaoTriggerKind,
} from "@/lib/automacoes/schemas";
import {
  GATILHOS_DA_AUTOMACAO,
  POLITICAS_DE_REENTRADA,
  VIAS_DA_ETAPA,
} from "@/lib/automacoes/vocabulario";
import { useWebhookSources } from "@/hooks/webhooks/useWebhookSources";
import { useT } from "@/hooks/i18n/useT";
import { Plus, Trash } from "@/lib/ui/icons";

import { Campo, opcoesDeEtapa, Seletor, useFunis } from "./comum";

function gatilhoEmBranco(kind: AutomacaoTriggerKind): AutomacaoTrigger {
  switch (kind) {
    case "manual":
      return { kind };
    case "lead_created":
      return { kind };
    case "stage_entered":
      return { kind, stage_ids: [], via: "any" };
  }
}

/**
 * O gatilho de uma automação: quando ela começa e o que fazer se o contato já
 * está nela. Grava na config do nó Início (`triggers` + `reentry`); só sobe
 * para o canvas quando o schema aceita — etapa não escolhida fica como erro.
 */
export function AutomationTriggerForm({
  config,
  onChange,
}: {
  config: Partial<AutomacaoTriggerConfig> | Record<string, never>;
  onChange: (config: AutomacaoTriggerConfig) => void;
}) {
  const t = useT();
  const inicial = automacaoTriggerConfigSchema.safeParse(config);
  const [rascunho, setRascunho] = useState<AutomacaoTriggerConfig>(
    inicial.success ? inicial.data : GATILHO_PADRAO,
  );
  const [erro, setErro] = useState<string | null>(null);
  const { funis, etapas } = useFunis();
  const fontes = useWebhookSources();

  const gravar = (novo: AutomacaoTriggerConfig) => {
    setRascunho(novo);
    const r = automacaoTriggerConfigSchema.safeParse(novo);
    if (!r.success) {
      setErro(t("Complete o gatilho: escolha ao menos uma etapa."));
      return;
    }
    setErro(null);
    onChange(r.data);
  };
  const trocar = (i: number, g: AutomacaoTrigger) =>
    gravar({ ...rascunho, triggers: rascunho.triggers.map((x, j) => (j === i ? g : x)) });

  return (
    <div className="space-y-4" data-testid="automation-trigger-form">
      <p className="text-sm text-text-muted">
        {t("A automação começa quando QUALQUER um destes gatilhos acontece.")}
      </p>
      {rascunho.triggers.map((g, i) => (
        <div
          key={i}
          className="space-y-3 rounded-sm border border-border p-2"
          data-testid={`gatilho-${i}`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-muted">
              {t("Gatilho")} {i + 1}
            </span>
            {rascunho.triggers.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("Remover gatilho")}
                onClick={() =>
                  gravar({ ...rascunho, triggers: rascunho.triggers.filter((_, j) => j !== i) })
                }
              >
                <Trash size={14} aria-hidden />
              </Button>
            )}
          </div>
          <Campo id={`gatilho-${i}-tipo`} rotulo={t("Quando")}>
            <Seletor
              id={`gatilho-${i}-tipo`}
              valor={g.kind}
              opcoes={(Object.keys(GATILHOS_DA_AUTOMACAO) as AutomacaoTriggerKind[]).map((k) => ({
                valor: k,
                rotulo: t(GATILHOS_DA_AUTOMACAO[k]),
              }))}
              onChange={(k) => trocar(i, gatilhoEmBranco(k as AutomacaoTriggerKind))}
            />
          </Campo>

          {g.kind === "manual" && (
            <p className="text-xs text-text-muted">
              {t("Você inicia para um contato pelo botão “Testar com um contato”.")}
            </p>
          )}

          {g.kind === "lead_created" && (
            <>
              <Campo id={`gatilho-${i}-funil`} rotulo={t("Em qual funil")}>
                <Seletor
                  id={`gatilho-${i}-funil`}
                  valor={g.pipeline_ids?.[0] ?? ""}
                  vazio={t("Qualquer funil")}
                  opcoes={funis.map((f) => ({ valor: f.id, rotulo: f.nome }))}
                  onChange={(v) => {
                    const { pipeline_ids: _antes, ...resto } = g;
                    trocar(i, v ? { ...resto, pipeline_ids: [v] } : resto);
                  }}
                />
              </Campo>
              <Campo id={`gatilho-${i}-fonte`} rotulo={t("Por onde entrou")}>
                <Seletor
                  id={`gatilho-${i}-fonte`}
                  valor={g.capture_source_ids?.[0] ?? (g.only_capture ? "__captacao" : "")}
                  vazio={t("Qualquer origem (inclusive cadastro manual)")}
                  opcoes={[
                    { valor: "__captacao", rotulo: t("Qualquer fonte de captação") },
                    ...(fontes.data?.data ?? []).map((f) => ({ valor: f.id, rotulo: f.name })),
                  ]}
                  onChange={(v) => {
                    const { capture_source_ids: _a, only_capture: _b, ...resto } = g;
                    if (!v) trocar(i, resto);
                    else if (v === "__captacao") trocar(i, { ...resto, only_capture: true });
                    else trocar(i, { ...resto, capture_source_ids: [v] });
                  }}
                />
              </Campo>
            </>
          )}

          {g.kind === "stage_entered" && (
            <>
              <Campo id={`gatilho-${i}-etapa`} rotulo={t("Etapa")}>
                <Seletor
                  id={`gatilho-${i}-etapa`}
                  valor={g.stage_ids[0] ?? ""}
                  vazio={t("Escolha a etapa")}
                  opcoes={opcoesDeEtapa(etapas)}
                  onChange={(v) => trocar(i, { ...g, stage_ids: v ? [v] : [] })}
                />
              </Campo>
              <Campo id={`gatilho-${i}-via`} rotulo={t("Como chegou")}>
                <Seletor
                  id={`gatilho-${i}-via`}
                  valor={g.via}
                  opcoes={(Object.keys(VIAS_DA_ETAPA) as Array<keyof typeof VIAS_DA_ETAPA>).map(
                    (k) => ({
                      valor: k,
                      rotulo: t(VIAS_DA_ETAPA[k]),
                    }),
                  )}
                  onChange={(v) => trocar(i, { ...g, via: v as keyof typeof VIAS_DA_ETAPA })}
                />
              </Campo>
            </>
          )}
        </div>
      ))}
      {rascunho.triggers.length < 5 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            gravar({ ...rascunho, triggers: [...rascunho.triggers, { kind: "lead_created" }] })
          }
        >
          <Plus size={14} aria-hidden className="mr-1" /> {t("Gatilho")}
        </Button>
      )}

      <div className="space-y-3 border-t border-border pt-3">
        <Campo id="reentrada-politica" rotulo={t("Se o contato já estiver nesta automação")}>
          <Seletor
            id="reentrada-politica"
            valor={rascunho.reentry.policy}
            opcoes={(
              Object.keys(POLITICAS_DE_REENTRADA) as Array<keyof typeof POLITICAS_DE_REENTRADA>
            ).map((k) => ({
              valor: k,
              rotulo: t(POLITICAS_DE_REENTRADA[k]),
            }))}
            onChange={(v) =>
              gravar({
                ...rascunho,
                reentry: { ...rascunho.reentry, policy: v as keyof typeof POLITICAS_DE_REENTRADA },
              })
            }
          />
        </Campo>
        <Campo
          id="reentrada-espera"
          rotulo={t("Esperar quantos minutos antes de começar de novo para o mesmo contato")}
          ajuda={t("0 = pode começar de novo assim que terminar.")}
        >
          <Input
            id="reentrada-espera"
            type="number"
            min={0}
            max={43200}
            defaultValue={rascunho.reentry.cooldown_minutes}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 0 && n <= 43200) {
                gravar({ ...rascunho, reentry: { ...rascunho.reentry, cooldown_minutes: n } });
              }
            }}
          />
        </Campo>
      </div>
      {erro && <p className="text-xs text-error-fg">{erro}</p>}
    </div>
  );
}
