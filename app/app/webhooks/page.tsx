import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  bloqueioDoBotao,
  estadoDoBloqueio,
  MOTIVO_CONTA_SUSPENSA_ASSINATURA,
} from "@/lib/billing/planos/estado-do-bloqueio";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { ABAS_DOS_WEBHOOKS, abaInicialDeAutomacoes } from "./_components/abas";
import { WebhooksClient } from "./_components/WebhooksClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Webhooks e regras antigas" };

export default async function WebhooksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const canManage = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  if (!canManage) redirect("/app/inbox");
  const idioma = user.idioma;
  const { tab, aba } = await searchParams;
  // Dois formatos de link: `?aba=automacoes` (upstream, a volta do designer) e
  // `?tab=rules` (Hiperbold). O `aba` conhecido vence; o resto cai no `tab`.
  const pedida = Array.isArray(aba) ? aba[0] : aba;
  const abaDoLink =
    pedida && Object.hasOwn(ABAS_DOS_WEBHOOKS, pedida)
      ? ABAS_DOS_WEBHOOKS[pedida as keyof typeof ABAS_DOS_WEBHOOKS]
      : null;
  const abaInicial = abaDoLink ?? abaInicialDeAutomacoes(Array.isArray(tab) ? tab[0] : tab);

  // Fase F3, tarefa 9: item "integracoes_webhook" para "Nova fonte"/"Criar
  // primeira fonte" e para reativar uma fonte pausada.
  const estado = await estadoDoBloqueio(createAdminClient(), activeOrg.orgId, {}, logger);
  const bloqueioCru = bloqueioDoBotao(estado, "integracoes_webhook");
  // Tarefa 2, fase F4: "integracoes_webhook" é uma das quatro chaves paradas
  // pela conta suspensa (ver estado-do-bloqueio.ts), motivo traduzido aqui,
  // no servidor, antes de atravessar para o componente `use client`.
  const bloqueio = bloqueioCru.suspensa
    ? { ...bloqueioCru, motivo: traduzir(MOTIVO_CONTA_SUSPENSA_ASSINATURA, idioma) }
    : bloqueioCru;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Webhooks e regras antigas", idioma)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Regras que agem sozinhas, entrada de leads de sites e formulários, e o registro do que chegou e do que rodou.",
            idioma,
          )}
        </p>
      </header>
      <WebhooksClient bloqueio={bloqueio} abaInicial={abaInicial} />
    </div>
  );
}
