"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { conditionConfigSchema, type NovaConditionCheck } from "@/lib/followup/graph-schema";
import { COMBINADORES } from "@/lib/followup/vocabulario";
import { OPERADORES_DE_CAMPO, type OperadorDeCampo } from "@/lib/automacoes/schemas";
import {
  ALVOS,
  fraseDaRegraNova,
  OPERADORES,
  OPERADORES_DE_ETAPA,
  OPERADORES_DE_TAG,
  OPERADORES_SEM_VALOR,
  REGRAS_NOVAS,
  SITUACOES_DO_NEGOCIO,
} from "@/lib/automacoes/vocabulario";
import { useT } from "@/hooks/i18n/useT";
import { Plus, Trash } from "@/lib/ui/icons";

import type { ConfigOf } from "../shared";
import {
  Campo,
  listaDeTags,
  opcoesDeEtapa,
  Seletor,
  SeletorDeCampo,
  useFunis,
  useNomesDaAutomacao,
  type Opcao,
} from "./comum";

type ConditionConfig = ConfigOf<"condition">;
type Kind = NovaConditionCheck["kind"];

/** Regra nova em branco: "Origem do negócio contém …" é o caso mais comum. */
export function regraDeAutomacaoEmBranco(kind: Kind = "field"): NovaConditionCheck {
  switch (kind) {
    case "field":
      return { kind, field: { scope: "lead", key: "source" }, op: "contains", value: "" };
    case "tag":
      return { kind, target: "lead", op: "has_any", tags: [] as unknown as [string] };
    case "stage":
      return { kind, op: "in", stage_ids: [] as unknown as [string] };
    case "open_deal_in_pipeline":
      return { kind, pipeline_id: "" };
    case "deal_exists":
      return { kind };
    case "deal_status":
      return { kind, status: "open" };
    case "business_hours":
      // O mesmo padrão do horário da espera: dias úteis, horário comercial.
      return { kind, start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] };
  }
}

const opcoesDe = <K extends string>(mapa: Record<K, string>, t: (s: string) => string): Opcao[] =>
  (Object.keys(mapa) as K[]).map((k) => ({ valor: k, rotulo: t(mapa[k]) }));

/**
 * A condição de uma AUTOMAÇÃO: regras sobre campo, tag, etapa e negócio, com
 * saídas "Sim" e "Não". As regras legadas dos follow-ups não aparecem aqui.
 */
export function CondicaoAutomacaoForm({
  config,
  onChange,
}: {
  config: ConditionConfig;
  onChange: (config: ConditionConfig) => void;
}) {
  const t = useT();
  const nomes = useNomesDaAutomacao();
  const novas = config.checks.filter((c): c is NovaConditionCheck => "kind" in c);
  const [rascunho, setRascunho] = useState<ConditionConfig>({
    ...config,
    checks: novas.length > 0 ? novas : [regraDeAutomacaoEmBranco()],
  });
  const [erro, setErro] = useState<string | null>(null);
  const regras = rascunho.checks as NovaConditionCheck[];

  const gravar = (novo: ConditionConfig) => {
    setRascunho(novo);
    const r = conditionConfigSchema.safeParse(novo);
    if (!r.success) {
      const i = r.error.issues[0]?.path[1];
      setErro(
        typeof i === "number"
          ? `${t("Complete a condição")} ${i + 1}.`
          : t("Adicione ao menos uma condição."),
      );
      return;
    }
    setErro(null);
    onChange(r.data);
  };
  const trocar = (i: number, regra: NovaConditionCheck) =>
    gravar({
      ...rascunho,
      checks: regras.map((x, j) => (j === i ? { ...regra, ...(x.id ? { id: x.id } : {}) } : x)),
    });

  return (
    <div className="space-y-4" data-testid="condicao-automacao-form">
      {regras.length > 1 && (
        <Campo id="condicao-combinador" rotulo={t("Seguir por “Sim” quando")}>
          <Seletor
            id="condicao-combinador"
            valor={rascunho.combinator}
            opcoes={opcoesDe(COMBINADORES, t)}
            onChange={(v) => gravar({ ...rascunho, combinator: v as "and" | "or" })}
          />
        </Campo>
      )}
      {regras.map((regra, i) => (
        <div
          key={regra.id ?? i}
          className="space-y-3 rounded-sm border border-border p-2"
          data-testid={`regra-${i}`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-muted">
              {t("Condição")} {i + 1}
            </span>
            {regras.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("Remover condição")}
                onClick={() => gravar({ ...rascunho, checks: regras.filter((_, j) => j !== i) })}
              >
                <Trash size={14} aria-hidden />
              </Button>
            )}
          </div>
          <Campo id={`regra-${i}-tipo`} rotulo={t("Verificar")}>
            <Seletor
              id={`regra-${i}-tipo`}
              valor={regra.kind}
              opcoes={opcoesDe(REGRAS_NOVAS, t)}
              onChange={(v) => trocar(i, regraDeAutomacaoEmBranco(v as Kind))}
            />
          </Campo>
          <CamposDaRegra prefixo={`regra-${i}`} regra={regra} onChange={(r) => trocar(i, r)} />
          <p className="text-xs text-text-muted">{fraseDaRegraNova(regra, nomes)}</p>
        </div>
      ))}
      {regras.length < 10 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => gravar({ ...rascunho, checks: [...regras, regraDeAutomacaoEmBranco()] })}
        >
          <Plus size={14} aria-hidden className="mr-1" /> {t("Condição")}
        </Button>
      )}
      {erro && <p className="text-xs text-error-fg">{erro}</p>}
    </div>
  );
}

function CamposDaRegra({
  prefixo,
  regra,
  onChange,
}: {
  prefixo: string;
  regra: NovaConditionCheck;
  onChange: (r: NovaConditionCheck) => void;
}) {
  const t = useT();
  const { funis, etapas } = useFunis();
  const [tags, setTags] = useState(regra.kind === "tag" ? regra.tags.join(", ") : "");

  switch (regra.kind) {
    case "field":
      return (
        <>
          <Campo id={`${prefixo}-campo`} rotulo={t("Campo")}>
            <SeletorDeCampo
              id={`${prefixo}-campo`}
              valor={regra.field}
              onChange={(field) => onChange({ ...regra, field })}
            />
          </Campo>
          <Campo id={`${prefixo}-op`} rotulo={t("Comparação")}>
            <Seletor
              id={`${prefixo}-op`}
              valor={regra.op}
              opcoes={OPERADORES_DE_CAMPO.map((op) => ({ valor: op, rotulo: t(OPERADORES[op]) }))}
              onChange={(v) => {
                const op = v as OperadorDeCampo;
                if (OPERADORES_SEM_VALOR.includes(op)) {
                  const { value: _antes, ...resto } = regra;
                  onChange({ ...resto, op });
                } else onChange({ ...regra, op, value: regra.value ?? "" });
              }}
            />
          </Campo>
          {!OPERADORES_SEM_VALOR.includes(regra.op) && (
            <Campo id={`${prefixo}-valor`} rotulo={t("Valor")}>
              <Input
                id={`${prefixo}-valor`}
                maxLength={500}
                value={String(regra.value ?? "")}
                onChange={(e) => onChange({ ...regra, value: e.target.value })}
              />
            </Campo>
          )}
        </>
      );
    case "tag":
      return (
        <>
          <Campo id={`${prefixo}-alvo`} rotulo={t("De quem")}>
            <Seletor
              id={`${prefixo}-alvo`}
              valor={regra.target}
              opcoes={opcoesDe(ALVOS, t)}
              onChange={(v) => onChange({ ...regra, target: v as "lead" | "contact" })}
            />
          </Campo>
          <Campo id={`${prefixo}-op`} rotulo={t("Comparação")}>
            <Seletor
              id={`${prefixo}-op`}
              valor={regra.op}
              opcoes={opcoesDe(OPERADORES_DE_TAG, t)}
              onChange={(v) => onChange({ ...regra, op: v as typeof regra.op })}
            />
          </Campo>
          <Campo id={`${prefixo}-tags`} rotulo={t("Tags (separe por vírgula)")}>
            <Input
              id={`${prefixo}-tags`}
              value={tags}
              onChange={(e) => {
                setTags(e.target.value);
                onChange({
                  ...regra,
                  tags: listaDeTags(e.target.value).slice(0, 10) as typeof regra.tags,
                });
              }}
            />
          </Campo>
        </>
      );
    case "stage":
      return (
        <>
          <Campo id={`${prefixo}-op`} rotulo={t("Comparação")}>
            <Seletor
              id={`${prefixo}-op`}
              valor={regra.op}
              opcoes={opcoesDe(OPERADORES_DE_ETAPA, t)}
              onChange={(v) => onChange({ ...regra, op: v as typeof regra.op })}
            />
          </Campo>
          <Campo id={`${prefixo}-etapa`} rotulo={t("Etapa")}>
            <Seletor
              id={`${prefixo}-etapa`}
              valor={regra.stage_ids[0] ?? ""}
              vazio={t("Escolha a etapa")}
              opcoes={opcoesDeEtapa(etapas)}
              onChange={(v) =>
                onChange({ ...regra, stage_ids: (v ? [v] : []) as typeof regra.stage_ids })
              }
            />
          </Campo>
        </>
      );
    case "open_deal_in_pipeline":
      return (
        <Campo id={`${prefixo}-funil`} rotulo={t("Funil")}>
          <Seletor
            id={`${prefixo}-funil`}
            valor={regra.pipeline_id}
            vazio={t("Escolha o funil")}
            opcoes={funis.map((f) => ({ valor: f.id, rotulo: f.nome }))}
            onChange={(v) => onChange({ ...regra, pipeline_id: v })}
          />
        </Campo>
      );
    case "deal_exists":
      return null;
    case "business_hours":
      return <HorarioDaRegra prefixo={prefixo} regra={regra} onChange={onChange} />;
    case "deal_status":
      return (
        <Campo id={`${prefixo}-situacao`} rotulo={t("Situação")}>
          <Seletor
            id={`${prefixo}-situacao`}
            valor={regra.status}
            opcoes={opcoesDe(SITUACOES_DO_NEGOCIO, t)}
            onChange={(v) => onChange({ ...regra, status: v as typeof regra.status })}
          />
        </Campo>
      );
  }
}

/**
 * "Está no horário?" (lote 6): início, fim e dias, no fuso da organização. Sai
 * por "Sim" dentro do horário e por "Não" fora dele.
 */
function HorarioDaRegra({
  prefixo,
  regra,
  onChange,
}: {
  prefixo: string;
  regra: Extract<NovaConditionCheck, { kind: "business_hours" }>;
  onChange: (r: NovaConditionCheck) => void;
}) {
  const t = useT();
  const invalido = regra.end <= regra.start;
  const alternar = (dia: number) => {
    const ativo = regra.weekdays.includes(dia);
    // Ao menos um dia: sem nenhum, a resposta seria "Não" para sempre.
    if (ativo && regra.weekdays.length === 1) return;
    onChange({
      ...regra,
      weekdays: ativo ? regra.weekdays.filter((d) => d !== dia) : [...regra.weekdays, dia].sort((a, b) => a - b),
    });
  };
  const rotulos = [t("Dom"), t("Seg"), t("Ter"), t("Qua"), t("Qui"), t("Sex"), t("Sáb")];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Campo id={`${prefixo}-inicio`} rotulo={t("Início")}>
          <Input
            id={`${prefixo}-inicio`}
            type="time"
            value={regra.start}
            aria-invalid={invalido}
            onChange={(e) => onChange({ ...regra, start: e.target.value })}
          />
        </Campo>
        <Campo id={`${prefixo}-fim`} rotulo={t("Fim")}>
          <Input
            id={`${prefixo}-fim`}
            type="time"
            value={regra.end}
            aria-invalid={invalido}
            onChange={(e) => onChange({ ...regra, end: e.target.value })}
          />
        </Campo>
      </div>
      {invalido && <p className="text-xs text-error-fg">{t("O fim precisa vir depois do início.")}</p>}
      <div className="flex flex-wrap gap-1" data-testid={`${prefixo}-dias`}>
        {rotulos.map((rotulo, dia) => {
          const ativo = regra.weekdays.includes(dia);
          return (
            <button
              key={dia}
              type="button"
              aria-pressed={ativo}
              onClick={() => alternar(dia)}
              className={`rounded-md border px-2 py-1 text-xs ${
                ativo ? "border-primary bg-primary/10 text-primary" : "border-border/60 text-muted-foreground"
              }`}
            >
              {rotulo}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-text-muted">
        {t("Dentro do horário segue por “Sim”; fora dele, por “Não”. Vale o fuso da organização.")}
      </p>
    </div>
  );
}
