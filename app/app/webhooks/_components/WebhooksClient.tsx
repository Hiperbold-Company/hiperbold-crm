"use client";
import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import type { BloqueioDoBotao } from "@/lib/billing/planos/estado-do-bloqueio";
import { SourcesTab } from "./SourcesTab";
import { RulesTab } from "./RulesTab";
import { ActivityTab } from "./ActivityTab";
import { CapturasTab } from "./CapturasTab";
import { useT } from "@/hooks/i18n/useT";
import { ABA_PADRAO_DE_AUTOMACOES, type AbaDeAutomacoes } from "./abas";

export function WebhooksClient({
  bloqueio,
  abaInicial = ABA_PADRAO_DE_AUTOMACOES,
}: { bloqueio?: BloqueioDoBotao; abaInicial?: AbaDeAutomacoes } = {}) {
  const t = useT();
  // Radix Tabs gera ids via useId; com SSR streamado (Next 15) os ids divergem
  // entre server e client e o React acusa hydration mismatch. Nenhuma outra
  // página do app SSRa Tabs no primeiro paint (todas montam pós-fetch) —
  // seguimos o mesmo padrão: skeleton no SSR, Tabs após mount.
  const mounted = React.useSyncExternalStore(
    React.useCallback(() => () => {}, []),
    () => true,
    () => false,
  );

  if (!mounted) {
    // Mesma altura do TabsList (h-9) e largura MEDIDA da tablist — zero layout
    // shift. 540px é a medida com QUATRO abas (`getBoundingClientRect` em
    // 1440px, abas Automações, Receber dados, Leads recebidos e Registro de
    // atividade); eram 432px com "Atividade" e 306px com três abas, e um
    // skeleton estreito demais faz a página saltar no primeiro paint.
    // Ao acrescentar ou renomear aba, MEDIR de novo — este número não se
    // estima a olho.
    return (
      <div className="flex-1">
        <Skeleton className="h-9 w-[540px]" />
      </div>
    );
  }

  return (
    <Tabs defaultValue={abaInicial} className="flex-1">
      <TabsList>
        <TabsTrigger value="rules">{t("Automações")}</TabsTrigger>
        <TabsTrigger value="sources">{t("Receber dados")}</TabsTrigger>
        <TabsTrigger value="capturas">{t("Leads recebidos")}</TabsTrigger>
        <TabsTrigger value="activity">{t("Registro de atividade")}</TabsTrigger>
      </TabsList>
      <TabsContent value="rules"><RulesTab /></TabsContent>
      <TabsContent value="sources"><SourcesTab bloqueio={bloqueio} /></TabsContent>
      <TabsContent value="capturas"><CapturasTab /></TabsContent>
      <TabsContent value="activity"><ActivityTab /></TabsContent>
    </Tabs>
  );
}
