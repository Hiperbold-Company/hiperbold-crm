import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/server";
import { env } from "@/lib/env";
import { baseDaCentralDeAjuda, CAMINHO_PADRAO_DA_AJUDA, urlNaCentral } from "@/lib/ajuda/artigos";

/**
 * Hiperbold (04/11/2026, decisão do dono do produto): a única ajuda do produto é
 * a nossa Central externa (`HELP_CENTER_URL`). A ajuda interna do autor original
 * (issue #3567) não aparece; quem chega a este endereço vai para a Central, ou
 * para o início do app quando a instalação não tem Central configurada.
 */
export const dynamic = "force-dynamic";

export default async function AjudaPage() {
  await requireAuth();
  const base = baseDaCentralDeAjuda(env.HELP_CENTER_URL);
  redirect(base ? urlNaCentral(base, CAMINHO_PADRAO_DA_AJUDA) : "/app");
}
