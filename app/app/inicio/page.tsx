/**
 * Início — o que já está feito e o que falta para o CRM trabalhar pela empresa.
 *
 * Com a compra pelo cliente ligada, `/app` abre aqui enquanto faltar algum passo obrigatório (ver
 * `lib/inicio/entrada.ts`); depois, abre no Inbox, e esta tela segue no menu. A lista é calculada
 * no servidor por `primeirosPassos` (`lib/inicio/primeiros-passos.ts`, função pura) a partir do que
 * `carregarDadosDosPrimeirosPassos` lê da organização ATIVA.
 *
 * Com os obrigatórios cumpridos, a tela vira um painel de indicadores (`InicioComPainel`) e o checklist
 * passa para uma barra lateral. Enquanto faltar algum, é só o checklist, como sempre foi.
 *
 * Gate: administrador. Os passos levam a telas de administração, e quem não administra não tem o
 * que fazer aqui.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { carregarPrimeirosPassos } from "@/lib/inicio/carregar";
import { redesignLigado } from "@/lib/redesign/chave";
import { marcaDoInicio } from "@/lib/redesign/inicio";
import { createAdminClient } from "@/lib/supabase/admin";
import { LinkDeAjudaDaTela } from "@/components/ajuda/LinkDeAjudaDaTela";

import { ListasDePassos, ProgressoDosPassos } from "./_components/ChecklistDoInicio";
import { InicioComPainel } from "./_components/InicioComPainel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Início" };

export default async function InicioPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);
  const rd = marcaDoInicio(redesignLigado());
  const { passos, contagem } = await carregarPrimeirosPassos(createAdminClient(), activeOrg.orgId, user.id);

  // Os obrigatórios cumpridos: o checklist vira barra lateral e a área principal é o painel.
  if (contagem.obrigatoriosFaltando === 0) {
    return <InicioComPainel passos={passos} contagem={contagem} userId={user.id} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6" data-rd-inicio={rd("tela")}>
      <header className="space-y-3" data-rd-inicio={rd("cabecalho")}>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Início")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Faltam poucos passos para o CRM começar a trabalhar pela sua empresa.")}
        </p>
        <LinkDeAjudaDaTela />
        <ProgressoDosPassos contagem={contagem} />
      </header>

      <ListasDePassos passos={passos} />
    </div>
  );
}
