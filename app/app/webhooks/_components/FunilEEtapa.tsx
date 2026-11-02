"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePipelines, usePipelineStages } from "@/hooks/webhooks/useWebhookSources";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  /** Prefixo dos ids, para dois diálogos na mesma página não repetirem `id`. */
  idPrefix: string;
  pipelineId: string;
  stageId: string;
  /**
   * Trocar o funil LIMPA a etapa: a etapa do funil anterior não pertence ao
   * novo, e a rota recusaria o par. A limpeza acontece aqui, no evento, e não
   * num efeito sobre `pipelineId` — um efeito apagaria também a etapa que o
   * diálogo de edição carrega ao abrir.
   */
  onPipelineChange: (pipelineId: string) => void;
  onStageChange: (stageId: string) => void;
}

/** Funil e etapa de entrada de uma fonte de captação (criação e edição). */
export function FunilEEtapa({
  idPrefix,
  pipelineId,
  stageId,
  onPipelineChange,
  onStageChange,
}: Props) {
  const t = useT();
  const { data: pipelinesRes, isLoading: pipelinesLoading } = usePipelines();
  const { data: boardRes, isLoading: stagesLoading } = usePipelineStages(pipelineId || null);

  const pipelines = pipelinesRes?.data ?? [];
  const stages = boardRes?.data?.stages ?? [];

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-pipeline`}>{t("Funil de entrada")}</Label>
        <Select
          value={pipelineId}
          onValueChange={(novo) => {
            if (novo === pipelineId) return;
            onPipelineChange(novo);
            onStageChange("");
          }}
          disabled={pipelinesLoading}
        >
          <SelectTrigger id={`${idPrefix}-pipeline`}>
            <SelectValue placeholder={t("Escolha o funil")} />
          </SelectTrigger>
          <SelectContent>
            {pipelines.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-stage`}>{t("Estágio de entrada")}</Label>
        <Select
          value={stageId}
          onValueChange={onStageChange}
          disabled={!pipelineId || stagesLoading}
        >
          <SelectTrigger id={`${idPrefix}-stage`}>
            <SelectValue
              placeholder={pipelineId ? t("Escolha o estágio") : t("Escolha o funil primeiro")}
            />
          </SelectTrigger>
          <SelectContent>
            {stages.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
