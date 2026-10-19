"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FiltroDeDataPopover } from "@/components/kanban/FiltroDeDataPopover";
import type { OpcoesDeFiltroDeContatos } from "@/hooks/contacts/useContactFilterOptions";
import { useT } from "@/hooks/i18n/useT";
import type { FiltrosDaTela } from "@/lib/contacts/filtros-url";
import type { FiltroDeData } from "@/lib/kanban/datas-do-lead";
import { cn } from "@/lib/utils";

const CLASSE_DO_CAMPO = "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm";
const CHAVE_VALIDA = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

/** Os filtros da tela que não são busca/etiqueta/origem: datas, funil/etapa e campo = valor. */
export function FiltrosAvancadosDeContatos({
  filtros,
  opcoes,
  onChange,
}: {
  filtros: FiltrosDaTela;
  opcoes: OpcoesDeFiltroDeContatos | undefined;
  /** Aplica uma mudança parcial; chave com `undefined` apaga o filtro. */
  onChange: (mudanca: Partial<Record<keyof FiltrosDaTela, string | undefined>>) => void;
}) {
  const t = useT();

  const criado: FiltroDeData | undefined =
    filtros.criado || filtros.criado_de || filtros.criado_ate
      ? {
          predefinido: filtros.criado as FiltroDeData["predefinido"],
          de: filtros.criado_de,
          ate: filtros.criado_ate,
        }
      : undefined;
  const ativ: FiltroDeData | undefined =
    filtros.ativ || filtros.ativ_de || filtros.ativ_ate
      ? {
          predefinido: filtros.ativ as FiltroDeData["predefinido"],
          de: filtros.ativ_de,
          ate: filtros.ativ_ate,
        }
      : undefined;

  const doPeriodo = (chave: "criado" | "ativ", f: FiltroDeData | undefined) =>
    onChange({
      [chave]: f?.predefinido,
      [`${chave}_de`]: f?.predefinido ? undefined : f?.de,
      [`${chave}_ate`]: f?.predefinido ? undefined : f?.ate,
    });

  return (
    <>
      <FiltroDeDataPopover
        id="contatos-criado"
        titulo={t("Entrou no CRM")}
        valor={criado}
        onChange={(f) => doPeriodo("criado", f)}
      />
      <FiltroDeDataPopover
        id="contatos-ativ"
        titulo={t("Última atividade")}
        valor={ativ}
        onChange={(f) => doPeriodo("ativ", f)}
      />
      <FiltroDeFunil filtros={filtros} opcoes={opcoes} onChange={onChange} />
      <FiltroDeCampo filtros={filtros} opcoes={opcoes} onChange={onChange} />
    </>
  );
}

function FiltroDeFunil({
  filtros,
  opcoes,
  onChange,
}: {
  filtros: FiltrosDaTela;
  opcoes: OpcoesDeFiltroDeContatos | undefined;
  onChange: (mudanca: Partial<Record<keyof FiltrosDaTela, string | undefined>>) => void;
}) {
  const t = useT();
  const funis = opcoes?.funis ?? [];
  // A etapa sozinha na URL (sem funil) é lida pelo servidor, mas a tela escolhe sempre
  // o funil primeiro; se o funil não existe mais, o resumo cai em "Todos".
  const funil = funis.find((f) => f.id === filtros.funil);
  const etapa = funis.flatMap((f) => f.etapas).find((e) => e.id === filtros.etapa);
  const ativo = Boolean(filtros.funil || filtros.etapa);
  const resumo = funil
    ? etapa
      ? `${funil.name} › ${etapa.name}`
      : funil.name
    : ativo
      ? t("Filtrado")
      : t("Todos");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-filtro="funil"
          className={cn(ativo && "border-accent bg-accent/10")}
          disabled={funis.length === 0}
        >
          {t("Funil")}: {resumo}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 p-3">
        <p className="text-xs font-medium">{t("Contatos que têm negócio em…")}</p>
        <div className="space-y-1">
          <Label htmlFor="contatos-funil" className="text-xs">
            {t("Funil")}
          </Label>
          <select
            id="contatos-funil"
            className={CLASSE_DO_CAMPO}
            value={filtros.funil ?? ""}
            onChange={(e) => onChange({ funil: e.target.value || undefined, etapa: undefined })}
          >
            <option value="">{t("Qualquer funil")}</option>
            {funis.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        {funil && (
          <div className="space-y-1">
            <Label htmlFor="contatos-etapa" className="text-xs">
              {t("Etapa")}
            </Label>
            <select
              id="contatos-etapa"
              className={CLASSE_DO_CAMPO}
              value={filtros.etapa ?? ""}
              onChange={(e) => onChange({ etapa: e.target.value || undefined })}
            >
              <option value="">{t("Qualquer etapa")}</option>
              {funil.etapas.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {ativo && (
          <Button variant="ghost" size="sm" onClick={() => onChange({ funil: undefined, etapa: undefined })}>
            {t("Limpar funil")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function FiltroDeCampo({
  filtros,
  opcoes,
  onChange,
}: {
  filtros: FiltrosDaTela;
  opcoes: OpcoesDeFiltroDeContatos | undefined;
  onChange: (mudanca: Partial<Record<keyof FiltrosDaTela, string | undefined>>) => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [escopo, setEscopo] = useState<"contato" | "negocio">(filtros.campo_escopo ?? "contato");
  const [campo, setCampo] = useState(filtros.campo ?? "");
  const [operador, setOperador] = useState<"contem" | "igual">(filtros.campo_op ?? "contem");
  const [valor, setValor] = useState(filtros.campo_valor ?? "");

  // "Limpar filtros" (ou voltar no navegador) muda a URL por fora: o formulário acompanha.
  useEffect(() => {
    setEscopo(filtros.campo_escopo ?? "contato");
    setCampo(filtros.campo ?? "");
    setOperador(filtros.campo_op ?? "contem");
    setValor(filtros.campo_valor ?? "");
  }, [filtros.campo_escopo, filtros.campo, filtros.campo_op, filtros.campo_valor]);

  const sugestoes = opcoes?.campos[escopo] ?? [];
  const ativo = Boolean(filtros.campo && filtros.campo_valor);
  const rotuloDoCampo = (chave: string) =>
    [...(opcoes?.campos.contato ?? []), ...(opcoes?.campos.negocio ?? [])].find((c) => c.key === chave)?.label ??
    chave;
  const podeAplicar = CHAVE_VALIDA.test(campo.trim()) && valor.trim().length > 0;

  function aplicar() {
    if (!podeAplicar) return;
    onChange({
      campo_escopo: escopo,
      campo: campo.trim(),
      campo_op: operador,
      campo_valor: valor.trim(),
    });
    setAberto(false);
  }

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-filtro="campo"
          className={cn(ativo && "border-accent bg-accent/10")}
        >
          {t("Campo")}:{" "}
          {ativo
            ? `${rotuloDoCampo(filtros.campo!)} ${filtros.campo_op === "igual" ? t("é igual a") : t("contém")} ${filtros.campo_valor}`
            : t("qualquer")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3 p-3">
        <p className="text-xs font-medium">{t("Campo personalizado")}</p>
        <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label={t("De onde é o campo")}>
          {(["contato", "negocio"] as const).map((e) => (
            <Button
              key={e}
              type="button"
              size="sm"
              variant={escopo === e ? "default" : "outline"}
              role="radio"
              aria-checked={escopo === e}
              onClick={() => setEscopo(e)}
            >
              {e === "contato" ? t("Do contato") : t("Do negócio")}
            </Button>
          ))}
        </div>
        {escopo === "negocio" && (
          <p className="text-xs text-muted-foreground">
            {t("Traz o contato que tem algum negócio com esse valor.")}
          </p>
        )}
        <div className="space-y-1">
          <Label htmlFor="contatos-campo" className="text-xs">
            {t("Campo")}
          </Label>
          <input
            id="contatos-campo"
            list="contatos-campo-sugestoes"
            className={CLASSE_DO_CAMPO}
            placeholder="utm_source, cargo, empresa…"
            value={campo}
            onChange={(e) => setCampo(e.target.value)}
            autoComplete="off"
          />
          <datalist id="contatos-campo-sugestoes">
            {sugestoes.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </datalist>
          {campo.trim() !== "" && !CHAVE_VALIDA.test(campo.trim()) && (
            <p className="text-xs text-error-fg">{t("Use só letras, números e _ (começando por letra).")}</p>
          )}
        </div>
        <div className="grid grid-cols-[7rem_1fr] gap-2">
          <div className="space-y-1">
            <Label htmlFor="contatos-campo-op" className="text-xs">
              {t("Condição")}
            </Label>
            <select
              id="contatos-campo-op"
              className={CLASSE_DO_CAMPO}
              value={operador}
              onChange={(e) => setOperador(e.target.value as "contem" | "igual")}
            >
              <option value="contem">{t("contém")}</option>
              <option value="igual">{t("é igual a")}</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="contatos-campo-valor" className="text-xs">
              {t("Valor")}
            </Label>
            <input
              id="contatos-campo-valor"
              className={CLASSE_DO_CAMPO}
              value={valor}
              maxLength={200}
              onChange={(e) => setValor(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") aplicar();
              }}
            />
          </div>
        </div>
        <div className="flex justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={!ativo}
            onClick={() => {
              onChange({ campo: undefined, campo_valor: undefined, campo_escopo: undefined, campo_op: undefined });
              setAberto(false);
            }}
          >
            {t("Limpar campo")}
          </Button>
          <Button size="sm" disabled={!podeAplicar} onClick={aplicar}>
            {t("Aplicar")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
