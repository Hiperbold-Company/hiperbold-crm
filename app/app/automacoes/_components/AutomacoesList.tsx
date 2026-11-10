"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { AvisoDeLimiteDoPlano } from "@/components/billing/AvisoDeLimiteDoPlano";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FlowStatusBadge } from "@/app/app/ai/followups/_components/FlowStatusBadge";
import { DeleteFollowupFlowButton } from "@/app/app/ai/followups/_components/DeleteFollowupFlowButton";
import {
  useCreateFollowupFlow,
  useFollowupFlows,
  type FollowupFlowPointerRow,
} from "@/hooks/followup/useFollowupFlows";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { FlowArrow, Plus } from "@/lib/ui/icons";
import {
  ROTULO_DO_TIPO,
  TIPOS_DA_LISTA,
  filtrarLista,
  montarListaUnica,
  type LinhaDaLista,
  type PonteiroDaLista,
  type RegraDaLista,
  type TipoDaLista,
} from "@/lib/automacoes/lista-unica";

import { ModelosDeAutomacaoDialog, type OpcaoDeCampo, type OpcaoDeEtapa } from "./ModelosDeAutomacaoDialog";

export function AutomacoesList({
  initialData,
  followups = [],
  regras = [],
  ultimasExecucoes = {},
  etapas = [],
  camposDeData = [],
  motivoDoBloqueio = null,
}: {
  initialData: FollowupFlowPointerRow[];
  /** Lote 5 — tela única: follow-ups e regras antigas lidos no servidor (filtro de organização). */
  followups?: PonteiroDaLista[];
  regras?: RegraDaLista[];
  ultimasExecucoes?: Record<string, string>;
  etapas?: OpcaoDeEtapa[];
  camposDeData?: OpcaoDeCampo[];
  /** D-227: o teto de automações do plano está cheio (frase pronta do servidor); `null` = pode criar. */
  motivoDoBloqueio?: string | null;
}) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const { data } = useFollowupFlows({ initialData, surface: "automacao" });
  const [aberto, setAberto] = useState(false);
  const [modelosAberto, setModelosAberto] = useState(false);
  const [tipo, setTipo] = useState<TipoDaLista | "todos">("todos");
  const [busca, setBusca] = useState("");
  const todas = useMemo(
    () =>
      montarListaUnica({
        automacoes: (data ?? []).map((a) => ({ id: a.id, name: a.name, status: a.status, surface: "automacao", updated_at: a.updated_at })),
        followups,
        regras,
        ultimasExecucoes,
      }),
    [data, followups, regras, ultimasExecucoes],
  );
  const lista = filtrarLista(todas, tipo, busca);
  const data_ = (iso: string) =>
    new Date(iso).toLocaleDateString(idioma, { day: "2-digit", month: "2-digit", year: "numeric" });

  const botaoNova = (
    <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-start">
      <Button
        variant="outline"
        onClick={() => setModelosAberto(true)}
        data-testid="usar-modelo-de-automacao"
        className="w-full sm:w-auto"
        disabled={motivoDoBloqueio !== null}
      >
        {t("Usar um modelo")}
      </Button>
      <div className="flex flex-col items-end">
      <Button
        onClick={() => setAberto(true)}
        data-testid="nova-automacao"
        className="w-full sm:w-auto"
        disabled={motivoDoBloqueio !== null}
      >
        <Plus size={14} aria-hidden className="mr-2" /> {t("Nova automação")}
      </Button>
      <AvisoDeLimiteDoPlano motivo={motivoDoBloqueio} testId="aviso-limite-de-automacoes" />
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {todas.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <FlowArrow size={36} aria-hidden className="text-text-muted" />
          <h2 className="font-medium">{t("Nenhuma automação ainda")}</h2>
          <p className="max-w-sm text-sm text-text-muted">
            {t(
              "Exemplo: quando um lead chegar pelo Facebook, criar o negócio no funil de vendas, pôr a tag Facebook e definir o responsável por rodízio.",
            )}
          </p>
          {botaoNova}
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder={t("Buscar pelo nome")}
                aria-label={t("Buscar pelo nome")}
                className="w-56"
                data-testid="busca-de-automacoes"
              />
              <div role="group" aria-label={t("Filtrar por tipo")} className="flex flex-wrap gap-1">
                {(["todos", ...TIPOS_DA_LISTA] as const).map((v) => (
                  <Button
                    key={v}
                    type="button"
                    size="sm"
                    variant={tipo === v ? "default" : "outline"}
                    aria-pressed={tipo === v}
                    onClick={() => setTipo(v)}
                    data-testid={`filtro-tipo-${v}`}
                  >
                    {v === "todos" ? t("Todos") : t(ROTULO_DO_TIPO[v])}
                  </Button>
                ))}
              </div>
            </div>
            {botaoNova}
          </div>
          {lista.length === 0 ? (
            <p className="text-sm text-text-muted">{t("Nada encontrado com esse filtro.")}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="lista-de-automacoes">
              {lista.map((a) => (
                <LinhaDaListaUnica key={`${a.tipo}:${a.id}`} linha={a} data_={data_} />
              ))}
            </ul>
          )}
        </>
      )}
      <NovaAutomacaoDialog aberto={aberto} onAberto={setAberto} />
      <ModelosDeAutomacaoDialog aberto={modelosAberto} onAberto={setModelosAberto} etapas={etapas} camposDeData={camposDeData} />
    </div>
  );
}

function LinhaDaListaUnica({ linha: a, data_ }: { linha: LinhaDaLista; data_: (iso: string) => string }) {
  const t = useT();
  return (
    <li data-testid={`linha-${a.tipo}`} data-id={a.id}>
      <Card className="flex h-full flex-col gap-3 p-4 transition-colors hover:border-accent-400">
        <Link href={a.href} className="flex flex-1 flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 flex-1 truncate font-medium" title={a.nome}>
              {a.nome}
            </h3>
            {a.tipo === "regra" ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-text-muted">
                {a.ligado ? t("Ligada") : t("Desligada")}
              </span>
            ) : (
              <FlowStatusBadge status={a.status as FollowupFlowPointerRow["status"]} />
            )}
          </div>
          <p className="text-xs font-medium text-text-muted" data-testid="tipo-da-linha">
            {t(ROTULO_DO_TIPO[a.tipo])}
          </p>
          {a.tipo === "regra" && (
            <p className="text-xs text-text-muted">
              {a.conversivel
                ? t("Dá para passar para o formato novo. Abra para ver como fica.")
                : t("Regra antiga — continua funcionando; abra na tela antiga.")}
            </p>
          )}
          <p className="text-xs text-text-muted">
            {a.ultimaExecucao ? `${t("Última execução em")} ${data_(a.ultimaExecucao)}` : t("Ainda não rodou")}
          </p>
        </Link>
        {a.tipo === "automacao" && (
          <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
            <Link href={`/app/automacoes/${a.id}/execucoes`} className="text-xs text-accent-600 hover:underline">
              {t("Ver execuções")}
            </Link>
            <DeleteFollowupFlowButton flowId={a.id} flowName={a.nome} />
          </div>
        )}
      </Card>
    </li>
  );
}

function NovaAutomacaoDialog({ aberto, onAberto }: { aberto: boolean; onAberto: (v: boolean) => void }) {
  const t = useT();
  const router = useRouter();
  const criar = useCreateFollowupFlow();
  const [nome, setNome] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  const enviar = (e: React.FormEvent) => {
    e.preventDefault();
    setErro(null);
    criar.mutate(
      { name: nome.trim(), surface: "automacao" },
      {
        // A automação nasce com Início (manual) → Fim: abre direto no editor.
        onSuccess: (fluxo) => router.push(`/app/automacoes/${fluxo.id}`),
        onError: (err: unknown) =>
          setErro(err instanceof Error && err.message ? t(err.message) : t("Não consegui criar a automação. Tente de novo.")),
      },
    );
  };

  return (
    <Dialog
      open={aberto}
      onOpenChange={(v) => {
        if (!v) {
          setNome("");
          setErro(null);
        }
        onAberto(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Nova automação")}</DialogTitle>
          <DialogDescription>
            {t("Nasce como rascunho. No editor você escolhe o gatilho e monta os passos.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={enviar} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="automacao-nome">{t("Nome")}</Label>
            <Input
              id="automacao-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder={t("Ex: Novo lead do Facebook")}
              maxLength={80}
              required
              autoFocus
            />
          </div>
          {erro && (
            <p role="alert" className="text-sm text-error-fg">
              {erro}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onAberto(false)} disabled={criar.isPending}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={criar.isPending || nome.trim().length === 0} data-testid="criar-automacao">
              {criar.isPending ? t("Criando…") : t("Criar automação")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
