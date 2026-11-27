/**
 * Configurações → Campos Personalizados (migration 1015). Os campos da ORGANIZAÇÃO, em dois níveis:
 * CONTATO (ficha do contato) e NEGÓCIO (vale para todos os funis). A obrigatoriedade por etapa
 * continua em Etapas do funil.
 *
 * `admin`: é o mesmo piso da GRAVAÇÃO em `/api/v1/custom-fields` (e da rota antiga e do MCP) — a
 * tela e a rota dizem a mesma coisa (controle que a rota recusaria seria decorativo).
 */
import { redirect } from "next/navigation";

import { LinkDeAjudaDaTela } from "@/components/ajuda/LinkDeAjudaDaTela";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { roleAtLeast } from "@/lib/auth/types";
import { COLUNAS_DA_DEFINICAO, type DefinicaoDeCampo } from "@/lib/campos/definicoes";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { CamposPersonalizadosClient } from "./_client";
import { marcaDosAjustes } from "@/lib/redesign/ajustes";
import { redesignNaRequisicao } from "@/lib/redesign/chave";

export const metadata = { title: "Campos Personalizados" };
export const dynamic = "force-dynamic";

export default async function CamposPersonalizadosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!roleAtLeast(activeOrg.role, "admin")) redirect("/403");

  // Service role com o filtro da organização da SESSÃO — a mesma leitura da rota.
  const { data, error } = await createAdminClient()
    .from("custom_field_definitions")
    .select(COLUNAS_DA_DEFINICAO)
    .eq("organization_id", activeOrg.orgId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto md:p-6">
      <header data-rd-ajustes={marcaDosAjustes(await redesignNaRequisicao())("cabecalho")}>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Campos Personalizados")}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Os campos que a empresa guarda além dos dados padrão. Campos de contato aparecem na ficha do contato; campos de negócio valem para todos os funis. Quais são obrigatórios em cada etapa se escolhe em Etapas do funil.",
          )}
        </p>
        <LinkDeAjudaDaTela />
      </header>
      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
          {t("Não foi possível carregar os campos agora. Recarregue a página.")}
        </div>
      ) : (
        <CamposPersonalizadosClient iniciais={(data ?? []) as unknown as DefinicaoDeCampo[]} />
      )}
    </div>
  );
}
