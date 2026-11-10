import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { ChavesSecretas } from "./_components/ChavesSecretas";

export const dynamic = "force-dynamic";

/**
 * Chaves secretas das automações (migration 1004): os tokens de API que o bloco
 * "Requisição HTTP" envia num cabeçalho. Gerente+, como as automações. A chave
 * só é mostrada como ••••1234 — nunca volta inteira à tela.
 *
 * Porta: o link "Chaves secretas" no topo de Automações (e o seletor de chave
 * do próprio bloco HTTP).
 */
export default async function ChavesDasAutomacoesPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Chaves secretas")}</h1>
        <p className="max-w-2xl text-sm text-text-muted">
          {t(
            "Guarde aqui o token ou a chave de API de outro sistema. O bloco Requisição HTTP envia a chave num cabeçalho, sem que ela apareça no fluxo, no histórico ou para outras pessoas. Depois de salva, a chave aparece só pelos 4 últimos caracteres.",
          )}
        </p>
      </header>
      <ChavesSecretas />
    </div>
  );
}
