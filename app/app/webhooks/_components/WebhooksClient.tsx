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
import { LinkDeAjudaDaTela } from "@/components/ajuda/LinkDeAjudaDaTela";
import { CAMINHO_CONECTAR_FORMULARIOS, artigoDaAba } from "@/lib/ajuda/artigos";

/**
 * O artigo de cada aba, no topo do conteúdo dela. Fica DENTRO do
 * `TabsContent`, e não na fila de abas: a largura da tablist é medida (ver o
 * skeleton abaixo) e não muda por causa disto. Aba sem artigo não mostra nada.
 */
function AjudaDaAba({ aba }: { aba: AbaDeAutomacoes }) {
  return <LinkDeAjudaDaTela caminho={artigoDaAba("/app/webhooks", aba)} className="mb-3" />;
}


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
    //
    // Abaixo de `lg` a aba tem 44px (`min-h-11` do trigger) e a lista quebra
    // linha (`flex-wrap` abaixo): uma fila = 44 + 8 do `p-1` = 52px. Abaixo de
    // `sm` (a 390px sobram ~310px úteis) as quatro abas viram DUAS filas, 96px.
    // Contas pelas classes, não medidas; o `max-w-full` impede que os 432px
    // empurrem o <main> para o lado no celular.
    return (
      <div className="flex-1">
        <Skeleton className="h-24 w-[432px] max-w-full sm:h-[52px] lg:h-9" />
      </div>
    );
  }

  return (
    <Tabs defaultValue={abaInicial} className="flex-1">
      <TabsList className="h-auto flex-wrap justify-start">
        <TabsTrigger value="rules">{t("Automações")}</TabsTrigger>
        <TabsTrigger value="sources">{t("Receber dados")}</TabsTrigger>
        <TabsTrigger value="capturas">{t("Leads recebidos")}</TabsTrigger>
        <TabsTrigger value="activity">{t("Registro de atividade")}</TabsTrigger>
      </TabsList>
      <TabsContent value="rules">
        <AjudaDaAba aba="rules" />
        <RulesTab />
      </TabsContent>
      <TabsContent value="sources">
        <div className="mb-3 space-y-1">
          <LinkDeAjudaDaTela caminho={artigoDaAba("/app/webhooks", "sources")} />
          <LinkDeAjudaDaTela
            caminho={CAMINHO_CONECTAR_FORMULARIOS}
            rotulo={t("Como conectar o formulário do seu site")}
            semPrefixo
          />
        </div>
        <SourcesTab bloqueio={bloqueio} />
      </TabsContent>
      <TabsContent value="capturas">
        <AjudaDaAba aba="capturas" />
        <CapturasTab />
      </TabsContent>
      <TabsContent value="activity">
        <AjudaDaAba aba="activity" />
        <ActivityTab />
      </TabsContent>
    </Tabs>
  );
}
