import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { createClient } from "@/lib/supabase/server";
import type { RouterListItem } from "@/hooks/ai/useRouters";
import { traduzir } from "@/lib/i18n/dicionario";
import { redesignLigado } from "@/lib/redesign/chave";
import { marcaDasAutomacoes } from "@/lib/redesign/automacoes";
import { RoutersClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function RoutersPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const idioma = user.idioma;
  const rd = marcaDasAutomacoes(redesignLigado());

  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();

  const [{ data: routerRows }, { data: memberRows }, channelSessions] = await Promise.all([
    supabase
      .from("ai_routers")
      .select("id, name, channel_session_id, is_active, fallback_agent_id, updated_at")
      .eq("organization_id", activeOrg.orgId)
      .order("created_at", { ascending: false }),
    supabase.from("ai_router_members").select("router_id").eq("organization_id", activeOrg.orgId),
    listSelectableChannels(supabase, activeOrg.orgId),
  ]);

  const counts = new Map<string, number>();
  for (const m of memberRows ?? []) {
    counts.set(m.router_id, (counts.get(m.router_id) ?? 0) + 1);
  }

  const routers: RouterListItem[] = (routerRows ?? []).map((r) => ({
    ...r,
    member_count: counts.get(r.id) ?? 0,
  }));

  return (
    <div className="flex h-full flex-col gap-6 p-6" data-rd-automacoes={rd("pagina")}>
      <header data-rd-automacoes={rd("cabecalho")}>
        <h1 className="text-2xl font-semibold tracking-tight" data-rd-automacoes={rd("titulo")}>{traduzir("Roteadores", idioma)}</h1>
        <p className="text-sm text-muted-foreground" data-rd-automacoes={rd("descricao")}>
          {traduzir(
            "Um roteador entende o que o cliente quer e entrega a conversa para o agente certo — plugado em um número de WhatsApp.",
            idioma,
          )}
        </p>
      </header>
      <RoutersClient initialState={{ routers }} channelSessions={channelSessions} />
    </div>
  );
}
