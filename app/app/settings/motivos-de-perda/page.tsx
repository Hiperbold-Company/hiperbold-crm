/**
 * Configurações › Motivos de perda (migration 1021, decisão do dono do produto em 24/11/2026).
 *
 * A lista é da ORGANIZAÇÃO e vale para todos os funis: a janela de perder, as automações, o Cold
 * Call e o relatório "Perdas" leem daqui. Antes cada funil tinha a sua, em Etapas do funil.
 *
 * `admin`: o mesmo piso da gravação (`salvarMotivosDePerda`, `podeAdministrarEmpresa`).
 */
import { redirect } from "next/navigation";

import { LinkDeAjudaDaTela } from "@/components/ajuda/LinkDeAjudaDaTela";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { roleAtLeast } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { listaDaOrganizacao } from "@/lib/leads/motivos-da-organizacao";
import { createAdminClient } from "@/lib/supabase/admin";

import { MotivosDePerdaClient } from "./_client";

export const metadata = { title: "Motivos de perda" };
export const dynamic = "force-dynamic";

export default async function MotivosDePerdaPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!roleAtLeast(activeOrg.role, "admin")) redirect("/403");

  // Service role com o filtro da organização da SESSÃO.
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const iniciais = listaDaOrganizacao((data as { settings?: unknown } | null)?.settings) ?? [];

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Motivos de perda")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Os motivos que a equipe escolhe ao marcar um negócio como perdido. A lista é da empresa e vale para todos os funis; a categoria agrupa o relatório de perdas.",
          )}
        </p>
        <LinkDeAjudaDaTela />
      </header>
      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
          {t("Não foi possível carregar os motivos agora. Recarregue a página.")}
        </div>
      ) : (
        <MotivosDePerdaClient iniciais={iniciais} />
      )}
    </div>
  );
}
