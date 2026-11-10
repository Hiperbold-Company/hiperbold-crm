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
import type { HorarioDaEspera } from "@/lib/followup/espera-no-horario";
import { useT } from "@/hooks/i18n/useT";

import { Campo, Seletor, TempoComUnidade, useCamposPersonalizados } from "./automacao/comum";
import { escopoDoCampo } from "@/lib/leads/campos-do-funil";
import type { QuandoDaEspera } from "@/lib/automacoes/plano-de-tempo";
import { QUANDO_DA_ESPERA_ROTULOS } from "@/lib/automacoes/vocabulario";
import { HorarioDaEsperaEditor } from "./HorarioDaEsperaEditor";
import { msToMin, minToMs, type ConfigOf } from "./shared";

/** Os modos que os follow-ups oferecem: segundos e "até responder" são só da automação. */
const MODOS_DO_FOLLOWUP: ReadonlyArray<ModoDeEspera> = ["fixed", "smart"];

/** Na automação, os dois modos novos vêm primeiro e com o nome que o dono usa. */
const MODOS_DA_AUTOMACAO: Record<ModoDeEspera, string> = {
  delay: "Esperar um tempo",
  until_reply: "Esperar o contato responder",
  until_time: "Esperar até um dia e horário",
  until_date_field: "Esperar até a data de um campo do negócio",
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
  /** O horário em que a espera fixa pode terminar (`ate_o_horario`); `null` = desligado. */
  horario: HorarioDaEspera | null;
  /** Lote 6: "até um dia e horário". */
  quando: QuandoDaEspera;
  dias: number | null;
  diaDaSemana: number;
  hora: string;
  /** Lote 6: "até a data de um campo". */
  campo: string;
  /** Quantos dias antes/depois da data (sempre ≥ 0; o sentido vem de `sentido`). */
  deslocamento: number | null;
  sentido: "antes" | "no_dia" | "depois";
}

const SENTIDOS = {
  antes: "Dias antes da data",
  no_dia: "No dia da data",
  depois: "Dias depois da data",
} as const;

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
    horario: config.mode === "smart" || config.mode === "until_reply" ? null : (config.ate_o_horario ?? null),
    quando: config.mode === "until_time" ? config.when : "tomorrow",
    dias: config.mode === "until_time" ? (config.days ?? 2) : 2,
    diaDaSemana: config.mode === "until_time" ? (config.weekday ?? 1) : 1,
    hora: config.mode === "until_time" || config.mode === "until_date_field" ? config.time : "09:00",
    campo: config.mode === "until_date_field" ? config.field_key : "",
    deslocamento: config.mode === "until_date_field" ? Math.abs(config.offset_days) : 1,
    sentido:
      config.mode === "until_date_field"
        ? config.offset_days < 0
          ? "antes"
          : config.offset_days > 0
            ? "depois"
            : "no_dia"
        : "no_dia",
  });
  const [error, setError] = useState<string | null>(null);

  // ⚠️ O QUE ESTE FORMULÁRIO NÃO EDITA, ELE CONSERVA. `commit` remontava a
  // config só com o que a tela mostra, e qualquer campo sem controle aqui
  // sumia no primeiro clique: `immune_to_reply` (a espera imune, que o grafo
  // importado ou montado por modelo traz) virava espera comum ao mudar a
  // duração. Ela não tem controle nesta tela; continua viajando intacta.
  const imune = config.mode === "fixed" && config.immune_to_reply === true;

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
    if (next.mode === "until_time" && next.quando === "in_days" && (next.dias === null || next.dias < 1 || next.dias > 365)) {
      setError(t("Os dias vão de 1 a 365."));
      return;
    }
    if (
      next.mode === "until_date_field" &&
      next.sentido !== "no_dia" &&
      (next.deslocamento === null || next.deslocamento < 1 || next.deslocamento > 3650)
    ) {
      setError(t("Os dias vão de 1 a 3650."));
      return;
    }
    const soNoHorario = next.horario ? { ate_o_horario: next.horario } : {};
    const candidate =
      next.mode === "fixed"
        ? {
            mode: "fixed" as const,
            duration_ms: minToMs(next.durationMin),
            ...(imune ? { immune_to_reply: true } : {}),
            ...(next.horario ? { ate_o_horario: next.horario } : {}),
          }
        : next.mode === "smart"
          ? {
              mode: "smart" as const,
              min_ms: minToMs(next.minMin),
              max_ms: minToMs(next.maxMin),
              ...(next.guidance.trim() ? { guidance: next.guidance } : {}),
            }
          : next.mode === "delay"
            ? { mode: "delay" as const, duration_s: Math.round((next.delayMs ?? 0) / 1000), ...soNoHorario }
            : next.mode === "until_time"
              ? {
                  mode: "until_time" as const,
                  when: next.quando,
                  ...(next.quando === "in_days" ? { days: next.dias ?? 1 } : {}),
                  ...(next.quando === "next_weekday" ? { weekday: next.diaDaSemana } : {}),
                  time: next.hora,
                  ...soNoHorario,
                }
              : next.mode === "until_date_field"
                ? {
                    mode: "until_date_field" as const,
                    field_key: next.campo,
                    offset_days:
                      next.sentido === "no_dia"
                        ? 0
                        : (next.sentido === "antes" ? -1 : 1) * (next.deslocamento ?? 1),
                    time: next.hora,
                    ...soNoHorario,
                  }
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
          ajuda={t("Uma espera curta costuma terminar em poucos segundos (no máximo em 1 minuto).")}
        >
          <TempoComUnidade
            id="wait-delay"
            ms={estado.delayMs ?? 60_000}
            unidades={["segundos", "minutos", "horas", "dias"]}
            onChange={(ms) => commit({ delayMs: ms })}
          />
        </Campo>
      )}

      {mode === "until_time" && (
        <>
          <Campo
            id="wait-quando"
            rotulo={t("Até quando")}
            ajuda={
              estado.quando === "today"
                ? t("Se já passou desse horário hoje, a automação segue na hora.")
                : estado.quando === "next_weekday"
                  ? t("Se hoje é o dia escolhido e o horário ainda não chegou, vale hoje.")
                  : undefined
            }
          >
            <Seletor
              id="wait-quando"
              valor={estado.quando}
              opcoes={opcoes(QUANDO_DA_ESPERA_ROTULOS).map(({ valor, rotulo }) => ({ valor, rotulo: t(rotulo) }))}
              onChange={(v) => commit({ quando: v as QuandoDaEspera })}
            />
          </Campo>
          {estado.quando === "in_days" && (
            <Campo id="wait-dias" rotulo={t("Quantos dias")}>
              <Input
                id="wait-dias"
                type="number"
                min={1}
                max={365}
                value={estado.dias ?? ""}
                onChange={(e) => commit({ dias: e.target.value === "" ? null : Number(e.target.value) })}
              />
            </Campo>
          )}
          {estado.quando === "next_weekday" && (
            <Campo id="wait-dia-da-semana" rotulo={t("Dia da semana")}>
              <Seletor
                id="wait-dia-da-semana"
                valor={String(estado.diaDaSemana)}
                opcoes={DIAS_DA_SEMANA.map((rotulo, i) => ({ valor: String(i), rotulo: t(rotulo) }))}
                onChange={(v) => commit({ diaDaSemana: Number(v) })}
              />
            </Campo>
          )}
        </>
      )}

      {mode === "until_date_field" && (
        <>
          <CampoDeDataDoNegocio valor={estado.campo} onChange={(campo) => commit({ campo })} />
          <Campo
            id="wait-sentido"
            rotulo={t("Quando, em relação à data")}
            ajuda={t('Se o campo estiver vazio ou a data já tiver passado, segue por "Sem data". A data é lida quando a espera começa.')}
          >
            <Seletor
              id="wait-sentido"
              valor={estado.sentido}
              opcoes={opcoes(SENTIDOS).map(({ valor, rotulo }) => ({ valor, rotulo: t(rotulo) }))}
              onChange={(v) => commit({ sentido: v as Estado["sentido"] })}
            />
          </Campo>
          {estado.sentido !== "no_dia" && (
            <Campo id="wait-deslocamento" rotulo={t("Quantos dias")}>
              <Input
                id="wait-deslocamento"
                type="number"
                min={1}
                max={3650}
                value={estado.deslocamento ?? ""}
                onChange={(e) =>
                  commit({ deslocamento: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </Campo>
          )}
        </>
      )}

      {(mode === "until_time" || mode === "until_date_field") && (
        <Campo id="wait-hora" rotulo={t("Às (hora)")} ajuda={t("Vale o fuso da organização.")}>
          <Input id="wait-hora" type="time" value={estado.hora} onChange={(e) => commit({ hora: e.target.value })} />
        </Campo>
      )}

      {naAutomacao && (mode === "delay" || mode === "until_time" || mode === "until_date_field") && (
        <HorarioDaEsperaEditor value={estado.horario} onChange={(h) => commit({ horario: h })} />
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
          <HorarioDaEsperaEditor value={estado.horario} onChange={(h) => commit({ horario: h })} />
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

/** Literais de propósito: o gate de tradução enxerga cada chave usada. */
const DIAS_DA_SEMANA = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];

/**
 * O campo de DATA do negócio (lote 6). Componente à parte para que só a espera
 * "até a data de um campo" peça a lista de campos dos funis.
 */
function CampoDeDataDoNegocio({ valor, onChange }: { valor: string; onChange: (chave: string) => void }) {
  const t = useT();
  const campos = useCamposPersonalizados().filter((c) => c.type === "date" && escopoDoCampo(c) === "negocio");
  return (
    <Campo
      id="wait-campo-de-data"
      rotulo={t("Campo de data do negócio")}
      ajuda={campos.length === 0 ? t("Nenhum funil tem campo de data. Crie um nos campos do funil.") : undefined}
    >
      <Seletor
        id="wait-campo-de-data"
        valor={valor}
        vazio={t("Escolha o campo")}
        opcoes={campos.map((c) => ({ valor: c.key, rotulo: c.label ?? c.key }))}
        onChange={onChange}
      />
    </Campo>
  );
}
