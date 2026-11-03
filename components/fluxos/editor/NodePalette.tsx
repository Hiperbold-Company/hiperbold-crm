"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NodeType } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import { NOS_DA_SUPERFICIE } from "@/lib/followup/validate-publish";
import type { FollowupFlowSurface } from "@/lib/followup/api-schemas";
import { REGISTRO_DE_NOS, type CategoriaDoNo } from "@/lib/followup/registro-de-nos";
import { NODE_VISUALS } from "./nodes/nodeVisuals";

/** Grupos da paleta da automação, na ordem em que aparecem. */
const GRUPOS: Array<{ categoria: CategoriaDoNo; rotulo: string }> = [
  { categoria: "inicio", rotulo: "Início" },
  { categoria: "crm", rotulo: "CRM" },
  { categoria: "logica", rotulo: "Lógica" },
  { categoria: "controle", rotulo: "Controle" },
  { categoria: "mensagem", rotulo: "Mensagens" },
];

interface Props {
  onAdd: (type: NodeType) => void;
  /**
   * Superfície do fluxo: a paleta oferece SÓ as caixas que o motor dela executa
   * (`NOS_DA_SUPERFICIE`, a mesma lista do publish). Na prova do #1130 a paleta
   * do roteiro oferecia seis caixas que o motor recusava em silêncio.
   */
  surface?: FollowupFlowSurface;
  /** "mobile" = mesmo conteúdo dentro do Sheet que `FlowCanvas` abre abaixo de
   * `lg` — a barra fixa de 224px não cabia perto do canvas num celular. */
  variant?: "desktop" | "mobile";
}

/** Sidebar palette — click to add. Native HTML5 drag-and-drop wired in FlowCanvas (increment 3). */
export function NodePalette({ onAdd, variant = "desktop", surface = "followup" }: Props) {
  const t = useT();
  const isMobile = variant === "mobile";
  const botao = (tipo: NodeType) => {
    const visual = NODE_VISUALS[tipo];
    const Icon = visual.icon;
    return (
      <Button
        key={visual.type}
        type="button"
        variant="secondary"
        size="sm"
        className="justify-start gap-2"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-followup-node-type", visual.type);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => onAdd(visual.type)}
        data-testid={`palette-add-${visual.type}`}
      >
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${visual.chipClassName}`}
        >
          <Icon size={14} aria-hidden />
        </span>
        {t(visual.paletteLabel)}
      </Button>
    );
  };
  return (
    <aside
      className={cn(
        "flex flex-col gap-1.5 overflow-y-auto p-3",
        isMobile
          ? "h-full w-full"
          : "hidden w-56 shrink-0 border-r border-border bg-surface lg:flex",
      )}
      data-testid="node-palette"
    >
      <h2 className="px-1 pb-1 text-xs font-medium tracking-wide text-text-muted uppercase">
        {t("Adicionar nó")}
      </h2>
      {surface === "automacao"
        ? GRUPOS.map(({ categoria, rotulo }) => {
            const tipos = NOS_DA_SUPERFICIE[surface].filter(
              (tipo) => REGISTRO_DE_NOS[tipo].categoria === categoria,
            );
            if (tipos.length === 0) return null;
            return (
              <div
                key={categoria}
                className="flex flex-col gap-1.5 pb-2"
                data-testid={`palette-grupo-${categoria}`}
              >
                <h3 className="px-1 text-[11px] font-medium text-text-muted">{t(rotulo)}</h3>
                {tipos.map(botao)}
              </div>
            );
          })
        : NOS_DA_SUPERFICIE[surface].map(botao)}
    </aside>
  );
}
