"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FollowupFlowSurface } from "@/lib/followup/api-schemas";
import {
  TEMPO_MAXIMO_DE_ESPERA_DE_RESPOSTA_MS,
  TEMPO_MINIMO_DE_ESPERA_DE_RESPOSTA_MS,
  waitConfigSchema,
} from "@/lib/followup/graph-schema";
import { MODOS_DE_ESPERA, opcoes, type ModoDeEspera } from "@/lib/followup/vocabulario";
import { useT } from "@/hooks/i18n/useT";

import { Campo, Seletor, TempoComUnidade } from "./automacao/comum";
import { msToMin, minToMs, type ConfigOf } from "./shared";

/** Os modos que os follow-ups oferecem: segundos e "até responder" são só da automação. */
const MODOS_DO_FOLLOWUP: ReadonlyArray<ModoDeEspera> = ["fixed", "smart"];

/** Na automação, os dois modos novos vêm primeiro e com o nome que o dono usa. */
const MODOS_DA_AUTOMACAO: Record<ModoDeEspera, string> = {
  delay: "Esperar um tempo",
  until_reply: "Esperar o contato responder",
  fixed: MODOS_DE_ESPERA.fixed,
  smart: MODOS_DE_ESPERA.smart,
};

/** 90 dias: o teto da espera em segundos (o mesmo do schema). */
const MAXIMO_DO_DELAY_MS = 7_776_000 * 1000;

interface Estado {
  mode: ModoDeEspera;
  durationMin: number;
  minMin: number;
  maxMin: number;
  guidance: string;
  /** `null` = o número digitado não serve. */
  delayMs: number | null;
  replyMs: number | null;
}

export function WaitForm({
  config,
  onChange,
  surface = "followup",
  noInstagram = false,
}: {
  config: ConfigOf<"wait">;
  onChange: (c: ConfigOf<"wait">) => void;
  surface?: FollowupFlowSurface;
  /** A automação começa por comentário do Instagram: a espera é no Direct, e a IA cede a vez. */
  noInstagram?: boolean;
}) {
  const t = useT();
  const naAutomacao = surface === "automacao";
  const [estado, setEstado] = useState<Estado>({
    // O modo vem do nó como ele está: uma espera em segundos ou "até responder"
    // abria como "Tempo fixo", e o primeiro toque no formulário a reescrevia.
    mode: config.mode,
    durationMin: config.mode === "fixed" ? msToMin(config.duration_ms) : 10,
    minMin: config.mode === "smart" ? msToMin(config.min_ms) : 5,
    maxMin: config.mode === "smart" ? msToMin(config.max_ms) : 60,
    guidance: config.mode === "smart" ? (config.guidance ?? "") : "",
    delayMs: config.mode === "delay" ? config.duration_s * 1000 : 60_000,
    replyMs: config.mode === "until_reply" ? config.timeout_ms : 86_400_000,
  });
  const [error, setError] = useState<string | null>(null);

  const commit = (patch: Partial<Estado>) => {
    const next = { ...estado, ...patch };
    setEstado(next);
    if (
      next.mode === "delay" &&
      (next.delayMs === null || next.delayMs < 1000 || next.delayMs > MAXIMO_DO_DELAY_MS)
    ) {
      setError(t("O tempo vai de 1 segundo a 90 dias."));
      return;
    }
    if (
      next.mode === "until_reply" &&
      (next.replyMs === null ||
        next.replyMs < TEMPO_MINIMO_DE_ESPERA_DE_RESPOSTA_MS ||
        next.replyMs > TEMPO_MAXIMO_DE_ESPERA_DE_RESPOSTA_MS)
    ) {
      setError(t("O tempo limite vai de 1 minuto a 30 dias."));
      return;
    }
    const candidate =
      next.mode === "fixed"
        ? { mode: "fixed" as const, duration_ms: minToMs(next.durationMin) }
        : next.mode === "smart"
          ? {
              mode: "smart" as const,
              min_ms: minToMs(next.minMin),
              max_ms: minToMs(next.maxMin),
              ...(next.guidance.trim() ? { guidance: next.guidance } : {}),
            }
          : next.mode === "delay"
            ? { mode: "delay" as const, duration_s: Math.round((next.delayMs ?? 0) / 1000) }
            : { mode: "until_reply" as const, timeout_ms: next.replyMs ?? 0 };
    const parsed = waitConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  const { mode, durationMin, minMin, maxMin, guidance } = estado;

  return (
    <div className="space-y-3" data-testid="wait-form">
      {naAutomacao ? (
        <Campo id="wait-mode" rotulo={t("Como esperar")}>
          <Seletor
            id="wait-mode"
            valor={mode}
            opcoes={opcoes(MODOS_DA_AUTOMACAO).map(({ valor, rotulo }) => ({
              valor,
              rotulo: t(rotulo),
            }))}
            onChange={(v) => commit({ mode: v as ModoDeEspera })}
          />
        </Campo>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="wait-mode">{t("Como calcular a espera")}</Label>
          <Select value={mode} onValueChange={(v) => commit({ mode: v as ModoDeEspera })}>
            <SelectTrigger id="wait-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODOS_DO_FOLLOWUP.map((valor) => (
                <SelectItem key={valor} value={valor}>
                  {t(MODOS_DE_ESPERA[valor])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {mode === "delay" && (
        <Campo
          id="wait-delay"
          rotulo={t("Esperar por")}
          ajuda={t("O relógio roda de minuto em minuto: uma espera curta termina em até 1 minuto.")}
        >
          <TempoComUnidade
            id="wait-delay"
            ms={estado.delayMs ?? 60_000}
            unidades={["segundos", "minutos", "horas", "dias"]}
            onChange={(ms) => commit({ delayMs: ms })}
          />
        </Campo>
      )}

      {mode === "until_reply" && (
        <Campo
          id="wait-reply-timeout"
          rotulo={t("Tempo limite")}
          ajuda={t(
            'Se o contato responder, segue por "Respondeu"; se o tempo acabar, por "Sem resposta". A resposta é processada em até 1 minuto.',
          )}
        >
          <TempoComUnidade
            id="wait-reply-timeout"
            ms={estado.replyMs ?? 86_400_000}
            unidades={["minutos", "horas", "dias"]}
            onChange={(ms) => commit({ replyMs: ms })}
          />
        </Campo>
      )}
      {mode === "until_reply" && naAutomacao && noInstagram && (
        <p
          className="rounded-sm border border-border bg-muted p-2 text-xs text-text-muted"
          data-testid="aviso-espera-no-direct"
        >
          {t("Enquanto espera, o agente de IA não responde nesta conversa.")}
        </p>
      )}

      {mode === "fixed" && (
        <div className="space-y-2">
          <Label htmlFor="wait-duration">{t("Duração (minutos)")}</Label>
          <Input
            id="wait-duration"
            type="number"
            min={5}
            value={durationMin}
            onChange={(e) => commit({ durationMin: Number(e.target.value) })}
          />
        </div>
      )}

      {mode === "smart" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="wait-min">{t("Mínimo (min)")}</Label>
              <Input
                id="wait-min"
                type="number"
                min={5}
                value={minMin}
                onChange={(e) => commit({ minMin: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wait-max">{t("Máximo (min)")}</Label>
              <Input
                id="wait-max"
                type="number"
                min={5}
                value={maxMin}
                onChange={(e) => commit({ maxMin: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wait-guidance">{t("Orientação (opcional)")}</Label>
            <Textarea
              id="wait-guidance"
              maxLength={500}
              value={guidance}
              onChange={(e) => commit({ guidance: e.target.value })}
            />
          </div>
        </>
      )}
      {error && (
        <p className="text-xs text-error-fg" data-testid="wait-erro">
          {error}
        </p>
      )}
    </div>
  );
}
