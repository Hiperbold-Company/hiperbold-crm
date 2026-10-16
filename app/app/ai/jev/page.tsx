import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { PainelDoJev } from "./_components/PainelDoJev";

export const dynamic = "force-dynamic";

/**
 * Decisões rápidas (Jev): a porta própria do cartão que mora em Provedores.
 *
 * Provedores de IA está oculto na instalação da Hiperbold (`provedores-ia`, hiperbold/FUNCOES.md),
 * e era lá que o Jev se ligava. Esta página mostra o MESMO cartão (`CartaoDoJev`) e usa a mesma
 * rota (`/api/v1/ai/jev`), então não há regra duplicada. O papel mínimo é o da tela de Provedores:
 * gestor ou acima.
 */
export default async function JevPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  return <PainelDoJev />;
}
