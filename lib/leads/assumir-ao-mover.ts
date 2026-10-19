/**
 * "Quem move um lead sem responsável passa a ser o responsável".
 *
 * Decisão do dono do produto (out/2026), por organização, DESLIGADA por padrão
 * (`settings.routing.assign_owner_on_move`, ligada em Configurações › Distribuição
 * de atendimento). Esta é a regra inteira; as rotas só chamam.
 *
 * ─── Quando vale ──────────────────────────────────────────────────────────────
 *
 *  - o interruptor da organização está ligado; E
 *  - quem move é uma PESSOA com sessão (ator `user`), em qualquer papel humano
 *    (atendente, gerente, administrador). Agente de IA, automação, webhook, cron
 *    e chave de integração (`Bearer dsk_…`, ator `api_token`) NÃO atribuem: uma
 *    chave é de uma integração, não de uma pessoa, e atribuir a "dono da chave"
 *    esconderia o negócio de quem de fato o trabalha; E
 *  - o movimento MUDA a etapa. Arrastar dentro da própria coluna é reordenar, não
 *    mover; assumir um negócio por reordená-lo seria um efeito que ninguém pediu; E
 *  - o negócio não tem responsável nenhum: `owner_user_id` E `owner_agent_id`
 *    nulos — exatamente o que a tela chama de "Sem responsável" (`resolveLeadOwner`
 *    devolve `kind: null` só aí). Negócio de um AGENTE DE IA não conta como sem
 *    responsável: o cartão o mostra como do agente, e uma pessoa que o move não o
 *    toma do agente — passar do agente para a pessoa é a passagem (handoff), que
 *    tem fluxo próprio.
 *
 * ─── Como é gravado (sem corrida) ─────────────────────────────────────────────
 *
 * UPDATE condicional `where owner_user_id is null and owner_agent_id is null`,
 * logo depois da escrita da etapa: se duas pessoas movem o mesmo negócio ao mesmo
 * tempo, só uma linha é atualizada e só uma vira dona; a outra vê `assumiu = false`
 * e não registra nada. O trio de posse sai de `resolveOwnerPatch` (regra única da
 * migration 0070) e `assigned_at` é preenchido.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { resolveOwnerPatch } from "@/lib/leads/owner-patch";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { donoAoMoverLigado } from "@/lib/schemas/routing";

export interface DecisaoAssumirAoMover {
  ligado: boolean;
  actor: { type: string; id: string };
  /** `false` quando a escrita só reordenou o negócio dentro da mesma etapa. */
  mudouDeEtapa: boolean;
  dono: { owner_user_id?: string | null; owner_agent_id?: string | null };
}

/** A decisão pura: este movimento faz o ator assumir o negócio? */
export function deveAssumirAoMover(d: DecisaoAssumirAoMover): boolean {
  if (!d.ligado) return false;
  if (d.actor.type !== "user" || !d.actor.id) return false;
  if (!d.mudouDeEtapa) return false;
  return !d.dono.owner_user_id && !d.dono.owner_agent_id;
}

/** O interruptor da organização; falha de leitura é "desligado" (nunca atribui no escuro). */
export async function lerDonoAoMoverLigado(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error || !data) return false;
  return donoAoMoverLigado((data as { settings?: unknown }).settings);
}

export const ORIGEM_ASSUMIR_AO_MOVER = "assumir_ao_mover";

/**
 * Faz o ator assumir os negócios (o UPDATE condicional) e registra o que de fato
 * mudou. Devolve os ids que ELE assumiu — os que outra pessoa já tinha assumido
 * entre a leitura e a escrita ficam de fora.
 */
export async function assumirAoMover(
  supabase: SupabaseClient,
  p: {
    organizationId: string;
    leadIds: string[];
    userId: string;
    requestId: string;
    /** Rota de origem, para o rastro de falha. */
    origem: string;
    /** `contact_id` por negócio, para a atividade aparecer na timeline do contato. */
    contatos?: Map<string, string | null>;
  },
): Promise<string[]> {
  if (p.leadIds.length === 0) return [];
  const dono = resolveOwnerPatch({ owner_user_id: p.userId });
  if (!dono.ok || !dono.patch) return [];

  const agora = new Date().toISOString();
  const { data, error } = await supabase
    .from("crm_leads")
    .update({ ...dono.patch, assigned_at: agora, updated_at: agora })
    .in("id", p.leadIds)
    .eq("organization_id", p.organizationId)
    .is("owner_user_id", null)
    .is("owner_agent_id", null)
    .select("id");
  if (error) {
    // A etapa já mudou e não se desfaz por causa disto; a perda do efeito é
    // contada em vez de sumir.
    await Promise.all(
      p.leadIds.map((leadId) =>
        registraFalhaDeAtividade(supabase, {
          organizationId: p.organizationId,
          leadId,
          tipo: "lead_owner_assumed",
          origem: p.origem,
          erro: error.message,
          requestId: p.requestId,
        }),
      ),
    );
    return [];
  }

  const assumidos = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  await Promise.all(
    assumidos.map(async (leadId) => {
      const r = await emitLeadActivity(supabase, {
        organizationId: p.organizationId,
        leadId,
        contactId: p.contatos?.get(leadId) ?? null,
        type: "lead_owner_assumed",
        sourceModule: ORIGEM_ASSUMIR_AO_MOVER,
        sourceId: leadId,
        actor: { type: "user", id: p.userId },
        reason: "Assumiu ao mover o negócio",
        payload: { owner_user_id: p.userId, via: "move" },
      });
      if (!r.ok) {
        await registraFalhaDeAtividade(supabase, {
          organizationId: p.organizationId,
          leadId,
          tipo: "lead_owner_assumed",
          origem: p.origem,
          erro: r.error,
          requestId: p.requestId,
        });
      }
      await audit({
        action: "lead.owner_assumed_on_move",
        actorUserId: p.userId,
        organizationId: p.organizationId,
        resourceType: "crm_lead",
        resourceId: leadId,
        requestId: p.requestId,
        metadata: { actor_type: "user", owner_user_id: p.userId, origem: p.origem },
      });
    }),
  );
  return assumidos;
}
