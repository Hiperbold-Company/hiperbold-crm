"use client";
import { useMemo, useState } from "react";
import Link from "next/link";

import { AvisoDeLimiteDoPlano } from "@/components/billing/AvisoDeLimiteDoPlano";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Robot, Plus } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useAgentsList } from "@/hooks/ai/useAgents";
import type { AgentRow } from "@/hooks/ai/useAgent";
import { AgentCard } from "./AgentCard";
import { AgentsListFilters, type StatusFilter } from "./AgentsListFilters";
import { deriveAgentStatus } from "./AgentStatusBadge";

interface Props {
  initialData: AgentRow[];
  canWrite: boolean;
  /** D-227: o teto de agentes do plano está cheio (frase pronta do servidor); `null` = pode criar. */
  motivoDoBloqueio?: string | null;
}

/** "Criar novo": desabilitado com o motivo quando o teto de agentes do plano foi atingido. */
function BotaoCriarAgente({ motivo, className }: { motivo: string | null; className?: string }) {
  const t = useT();
  const rotulo = (
    <>
      <Plus size={14} aria-hidden className="mr-2" /> {t("Criar novo")}
    </>
  );
  if (motivo) {
    return (
      <div className="flex flex-col items-end">
        <Button className={className} disabled data-testid="criar-agente-bloqueado">
          {rotulo}
        </Button>
        <AvisoDeLimiteDoPlano motivo={motivo} testId="aviso-limite-de-agentes" />
      </div>
    );
  }
  return (
    <Link href="/app/ai/agents/new">
      <Button className={className}>{rotulo}</Button>
    </Link>
  );
}

export function AgentsList({ initialData, canWrite, motivoDoBloqueio = null }: Props) {
  const t = useT();
  const { data, isLoading } = useAgentsList({ initialData });
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const agents = data ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      const s = deriveAgentStatus(a);
      if (!showArchived && s === "archived") return false;
      if (status !== "all" && s !== status) return false;
      if (q && !a.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [agents, status, query, showArchived]);

  if (!isLoading && agents.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <Robot size={36} aria-hidden className="text-muted-foreground" />
        <h2 className="font-medium">{t("Nenhum agente configurado")}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t(
            "Crie um agente para responder a conversas no WhatsApp com IA. Você configura prompt, tools, gatilhos e janela de contexto.",
          )}
        </p>
        {canWrite && <BotaoCriarAgente motivo={motivoDoBloqueio} className="mt-1" />}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AgentsListFilters
          status={status}
          onStatusChange={setStatus}
          query={query}
          onQueryChange={setQuery}
          showArchived={showArchived}
          onShowArchivedChange={setShowArchived}
        />
        {canWrite && <BotaoCriarAgente motivo={motivoDoBloqueio} />}
      </div>

      {filtered.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {t("Nenhum agente corresponde aos filtros atuais.")}
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((agent) => (
            <li key={agent.id}>
              <AgentCard agent={agent} canWrite={canWrite} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
