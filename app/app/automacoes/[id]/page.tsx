import { notFound, redirect } from "next/navigation";

import { FlowBuilder } from "@/components/fluxos/editor/FlowBuilder";
import type { FollowupFlowDetailRow } from "@/hooks/followup/useFollowupFlow";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { rascunhoDoFluxo } from "@/lib/followup/rascunho";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, name, status, active_version_id, draft_graph, handoff_policy, trigger_config, surface, created_at, updated_at";

/** Editor de uma automação: o mesmo construtor dos follow-ups, com a paleta e os gatilhos dela. */
export default async function AutomacaoEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  const supabase = await createClient();
  const [{ data: pointer }, { data: versoes }] = await Promise.all([
    supabase
      .from("followup_flow_pointers")
      .select(COLUNAS)
      .eq("id", id)
      .eq("organization_id", activeOrg.orgId)
      .eq("surface", "automacao")
      .maybeSingle(),
    supabase
      .from("followup_flow_versions")
      .select("id, created_at")
      .eq("organization_id", activeOrg.orgId)
      .eq("pointer_id", id)
      .order("created_at", { ascending: false }),
  ]);
  if (!pointer) notFound();

  const draft_graph = await rascunhoDoFluxo(
    supabase,
    pointer as unknown as { draft_graph: unknown; active_version_id: string | null },
    activeOrg.orgId,
  );
  const flow: FollowupFlowDetailRow = {
    ...(pointer as unknown as Omit<FollowupFlowDetailRow, "versions_count" | "previous_version_id">),
    draft_graph,
    versions_count: versoes?.length ?? 0,
    previous_version_id: versoes?.[1]?.id ?? null,
  };

  return (
    <div className="flex h-full flex-col">
      <FlowBuilder flowId={id} initialData={flow} />
    </div>
  );
}
