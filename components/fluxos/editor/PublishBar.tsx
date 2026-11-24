"use client";

import Link from "next/link";
import { useState } from "react";

import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ApiError } from "@/lib/api/types";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { PublishValidationError } from "@/lib/followup/validate-publish";
import { useT } from "@/hooks/i18n/useT";
import { useMarcaDasAutomacoes } from "@/lib/redesign/automacoes";
import { useRedesign } from "@/lib/redesign/contexto";
import { MaisAcoesRecolhidas } from "@/components/redesign/MaisAcoesRecolhidas";
import {
  useDisableFollowupFlow,
  usePublishFollowupFlow,
  useRollbackFollowupFlow,
  useSaveFollowupFlowDraft,
  useUpdateHandoffPolicy,
  type FollowupFlowDetailRow,
} from "@/hooks/followup/useFollowupFlow";
import { CaretLeft, Trash, TreeStructure } from "@/lib/ui/icons";
import { FlowStatusBadge } from "@/app/app/ai/followups/_components/FlowStatusBadge";
import { DeleteFollowupFlowButton } from "@/app/app/ai/followups/_components/DeleteFollowupFlowButton";
import { RenameFollowupFlowButton } from "@/app/app/ai/followups/_components/RenameFollowupFlowButton";
import { ExportarAutomacaoButton } from "@/app/app/automacoes/_components/ExportarAutomacaoButton";
import { TestarAutomacao } from "./TestarAutomacao";
import { TriggerConfigControl } from "./TriggerConfigControl";

interface Props {
  flowId: string;
  flow: FollowupFlowDetailRow;
  graph: FlowGraph;
  dirty: boolean;
  selection: "node" | "edge" | null;
  onDeleteSelection: () => void;
  onSaved: (graph: FlowGraph) => void;
  onPublishErrors: (errorsByNode: Record<string, string[]>) => void;
  onPublishSuccess: () => void;
  onAutoFit?: () => void;
  canAutoFit?: boolean;
}

const HANDOFF_LABEL: Record<FollowupFlowDetailRow["handoff_policy"], string> = {
  pause: "Pausar durante handoff",
  cancel: "Cancelar durante handoff",
  allow: "Permitir durante handoff",
};

// O link de volta do redesign: o nome da lista para onde `listHref` leva.
const ROTULO_DA_LISTA: Record<"automacao" | "atendimento" | "followup", string> = {
  automacao: "Automações",
  atendimento: "Fluxos de atendimento",
  followup: "Follow-ups",
};

export function PublishBar({
  flowId,
  flow,
  graph,
  dirty,
  selection,
  onDeleteSelection,
  onSaved,
  onPublishErrors,
  onPublishSuccess,
  onAutoFit,
  canAutoFit = false,
}: Props) {
  const t = useT();
  const rd = useMarcaDasAutomacoes();
  const ligado = useRedesign();
  const [openDeleteSelection, setOpenDeleteSelection] = useState(false);
  const save = useSaveFollowupFlowDraft(flowId);
  const publish = usePublishFollowupFlow(flowId);
  const disable = useDisableFollowupFlow(flowId);
  const rollback = useRollbackFollowupFlow(flowId);
  const handoffPolicy = useUpdateHandoffPolicy(flowId);
  const deRoteiro = flow.surface === "atendimento";
  // A automação leva os gatilhos no nó Início e não conversa com o cliente: nem
  // o gatilho de relógio nem a política de handoff do follow-up valem para ela.
  const deAutomacao = flow.surface === "automacao";
  const listHref = deRoteiro ? "/app/ai/atendimento" : deAutomacao ? "/app/automacoes" : "/app/ai/followups";

  const onSave = () => {
    save.mutate(graph, { onSuccess: () => onSaved(graph) });
  };

  const onPublish = async () => {
    try {
      await save.mutateAsync(graph);
      onSaved(graph);
    } catch {
      return; // save's own onError already toasted — don't attempt publish on a failed save
    }

    publish.mutate(undefined, {
      onSuccess: () => onPublishSuccess(),
      onError: (err) => {
        if (err instanceof ApiError && err.code === "validation_failed") {
          const errors = (err.details?.errors as PublishValidationError[] | undefined) ?? [];
          const byNode: Record<string, string[]> = {};
          const flowLevel: string[] = [];
          for (const e of errors) {
            if (e.node_id) (byNode[e.node_id] ??= []).push(e.message);
            else flowLevel.push(e.message);
          }
          onPublishErrors(byNode);
          toast.error(t("Fluxo reprovado na validação — corrija os nós destacados."), {
            description: flowLevel.length > 0 ? flowLevel.join(" ") : undefined,
          });
          return;
        }
        showApiError(err);
      },
    });
  };

  const onDisable = () => disable.mutate();

  const canRollback = flow.versions_count > 1 && flow.previous_version_id !== null;
  const onRollback = () => {
    if (!flow.previous_version_id) return;
    rollback.mutate(flow.previous_version_id);
  };

  const busy = save.isPending || publish.isPending || disable.isPending || rollback.isPending;

  // Cada controle é declarado uma vez e entra nos dois arranjos. Desligada, a
  // barra é a de sempre, na mesma ordem; ligada (v49), o mesmo conjunto muda de
  // lugar: o raro vai para o "Mais ações", o resto fica à vista.
  const testar = deAutomacao && <TestarAutomacao flowId={flowId} publicada={flow.status === "active"} />;
  const exportar = deAutomacao && <ExportarAutomacaoButton flowId={flowId} />;
  const gatilho = !deRoteiro && !deAutomacao && <TriggerConfigControl flowId={flowId} triggerConfig={flow.trigger_config} />;
  const handoff = !deRoteiro && !deAutomacao && (
    <Select value={flow.handoff_policy} onValueChange={(v) => handoffPolicy.mutate(v as FollowupFlowDetailRow["handoff_policy"])}>
      <SelectTrigger className="w-56" aria-label={t("Política de handoff")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(HANDOFF_LABEL) as Array<keyof typeof HANDOFF_LABEL>).map((k) => (
          <SelectItem key={k} value={k}>
            {t(HANDOFF_LABEL[k])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const salvar = (
    <Button type="button" variant="secondary" size="sm" disabled={!dirty || busy} onClick={onSave}>
      {save.isPending ? t("Salvando…") : t("Salvar")}
    </Button>
  );
  const publicar = (
    <Button type="button" size="sm" disabled={busy} onClick={onPublish} data-testid="publish-button">
      {publish.isPending ? t("Publicando…") : t("Publicar")}
    </Button>
  );
  const desativar = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy || flow.status === "disabled"}
      onClick={onDisable}
    >
      {t("Desativar")}
    </Button>
  );
  const voltarVersao = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy || !canRollback}
      onClick={onRollback}
      data-testid="rollback-button"
    >
      {t("Rollback")}
    </Button>
  );
  const organizar = onAutoFit && (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!canAutoFit}
      onClick={onAutoFit}
      data-testid="auto-fit-flow"
    >
      <TreeStructure size={14} aria-hidden className="mr-1" />
      {t("Organizar")}
    </Button>
  );
  const excluirSelecao = selection && (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="text-destructive"
        data-testid="delete-selection"
        onClick={() => setOpenDeleteSelection(true)}
      >
        <Trash size={14} aria-hidden className="mr-1" />
        {selection === "node" ? t("Excluir nó") : t("Excluir aresta")}
      </Button>
      <AlertDialog open={openDeleteSelection} onOpenChange={setOpenDeleteSelection}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selection === "node" ? t("Excluir este nó?") : t("Excluir esta aresta?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selection === "node"
                ? t("Este nó e as arestas ligadas a ele são apagados. Não é possível desfazer.")
                : t("A aresta entre os dois nós é apagada. Não é possível desfazer.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setOpenDeleteSelection(false);
                onDeleteSelection();
              }}
            >
              {t("Excluir")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
  // Com algo selecionado no canvas, o lugar do "Excluir" é do excluir-seleção (regra de sempre).
  const excluirFluxo = !selection && (
    <DeleteFollowupFlowButton
      flowId={flowId}
      flowName={flow.name}
      redirectToList
      listHref={listHref}
    />
  );

  const identidade = (
    <>
      <h1 className="text-sm font-semibold text-text" data-rd-automacoes={rd("titulo")}>{flow.name}</h1>
      <RenameFollowupFlowButton
        flowId={flowId}
        flowName={flow.name}
        variant="ghost"
        size="icon"
      />
      <FlowStatusBadge status={flow.status} />
      {dirty && (
        <Badge variant="warning" data-testid="dirty-indicator">
          {t("Alterações não salvas")}
        </Badge>
      )}
    </>
  );

  if (ligado) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3" data-rd-automacoes={rd("barra-do-editor")}>
        <div className="flex min-w-0 items-center gap-1">
          <Link href={listHref} className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text" data-rd-automacoes={rd("voltar")}>
            <CaretLeft size={14} aria-hidden />
            {t(ROTULO_DA_LISTA[flow.surface === "atendimento" ? "atendimento" : deAutomacao ? "automacao" : "followup"])}
          </Link>
          {identidade}
        </div>

        <div className="flex flex-wrap items-center gap-2" data-rd-automacoes={rd("acoes")}>
          {/* À vista: o que o v49 mostra (Execuções, Testar, Salvar, Publicar), os
              controles do follow-up que MOSTRAM estado (gatilho e handoff) e o
              excluir-seleção, que só aparece com algo selecionado no canvas. */}
          {testar}
          {gatilho}
          {handoff}
          {salvar}
          {publicar}
          {voltarVersao}
          {excluirSelecao}
          {/* No "Mais ações": ações que agem direto ou abrem diálogo. Exportar é
              download direto (sem popover). Desativar fica aqui: o estado do fluxo
              já está no selo ao lado do nome. Rollback fica À VISTA (acima): o
              desabilitado é o único lugar que diz se há versão anterior. */}
          <MaisAcoesRecolhidas
            marca={{ "data-rd-automacoes": rd("mais-acoes") }}
            marcaDaLista={{ "data-rd-automacoes": rd("mais-acoes-lista") }}
          >
            {exportar}
            {organizar}
            {desativar}
            {excluirFluxo}
          </MaisAcoesRecolhidas>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3" data-rd-automacoes={rd("barra-do-editor")}>
      <div className="flex items-center gap-1">
        {identidade}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* O roteiro de atendimento começa por palavra-gatilho ou roteador (no
            Início do grafo) e encerra quando um humano assume (0397): o gatilho
            de relógio e a política de handoff do follow-up não valem para ele —
            na prova do #1130 esta barra aparecia igual e confundia. */}
        {testar}
        {exportar}
        {gatilho}
        {handoff}
        {salvar}
        {publicar}
        {desativar}
        {voltarVersao}
        {organizar}
        {excluirSelecao || excluirFluxo}
      </div>
    </div>
  );
}
