/**
 * O catálogo de uma organização para `portabilidade.ts`: toda linha que um grafo
 * de automação pode citar, com o nome legível. A exportação o usa para dar nome
 * aos ids da ORIGEM; a importação, para oferecer as opções do DESTINO.
 *
 * Lê com a service role (como o publish, `lib/followup/administracao.ts`), e por
 * isso TODA consulta filtra `organization_id` explicitamente. O e-mail de pessoa
 * nunca entra no nome: o nome vai para um arquivo que sai da conta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CatalogoDaConta, ItemDoCatalogo } from "./portabilidade";

type Linha = Record<string, unknown>;

async function linhas(
  consulta: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<Linha[]> {
  const { data, error } = await consulta;
  if (error) throw new Error(error.message);
  return (data ?? []) as Linha[];
}

const LIMITE = 2000;

export async function catalogoDaConta(admin: SupabaseClient, organizationId: string): Promise<CatalogoDaConta> {
  const org = organizationId;
  const [funis, etapas, membros, fontes, canais, segredos, automacoes, mensagens, aprovados] = await Promise.all([
    linhas(admin.from("crm_pipelines").select("id, name, is_archived").eq("organization_id", org).limit(LIMITE)),
    linhas(
      admin.from("crm_stages").select("id, name, pipeline_id, is_archived").eq("organization_id", org).limit(LIMITE),
    ),
    linhas(
      admin
        .from("user_organizations")
        .select("user_id, accepted_at, revoked_at")
        .eq("organization_id", org)
        .limit(LIMITE),
    ),
    linhas(admin.from("webhook_sources").select("id, name, is_active").eq("organization_id", org).limit(LIMITE)),
    linhas(
      admin
        .from("channel_sessions")
        .select("id, display_name")
        .eq("organization_id", org)
        .limit(LIMITE),
    ),
    linhas(admin.from("automacao_segredos").select("id, nome").eq("organization_id", org).limit(LIMITE)),
    linhas(
      admin
        .from("followup_flow_pointers")
        .select("id, name")
        .eq("organization_id", org)
        .eq("surface", "automacao")
        .limit(LIMITE),
    ),
    linhas(admin.from("message_templates").select("id, title").eq("organization_id", org).limit(LIMITE)),
    linhas(admin.from("meta_templates").select("id, name, language").eq("organization_id", org).limit(LIMITE)),
  ]);

  const funilPorId = new Map(funis.map((f) => [String(f.id), f]));
  const itens: ItemDoCatalogo[] = [];
  for (const f of funis) itens.push({ id: String(f.id), tipo: "funil", nome: String(f.name), ativo: !f.is_archived });
  for (const e of etapas) {
    const funil = funilPorId.get(String(e.pipeline_id));
    itens.push({
      id: String(e.id),
      tipo: "etapa",
      nome: funil ? `${String(e.name)} · ${String(funil.name)}` : String(e.name),
      ativo: !e.is_archived && !!funil && !funil.is_archived,
    });
  }
  // Nome da pessoa: o `full_name` do cadastro (o mesmo que o seletor de responsável mostra).
  const nomes = await Promise.all(
    membros.map(async (m) => {
      const { data } = await admin.auth.admin.getUserById(String(m.user_id));
      const nome = (data?.user?.user_metadata?.full_name as string | undefined)?.trim();
      return nome || "Pessoa sem nome";
    }),
  );
  membros.forEach((m, i) =>
    itens.push({
      id: String(m.user_id),
      tipo: "pessoa",
      nome: nomes[i]!,
      ativo: !!m.accepted_at && !m.revoked_at,
    }),
  );
  for (const s of fontes) itens.push({ id: String(s.id), tipo: "fonte", nome: String(s.name), ativo: s.is_active !== false });
  for (const c of canais) {
    // Só o nome dado ao canal: o telefone iria para um arquivo que sai da conta.
    const nome = typeof c.display_name === "string" && c.display_name.trim() ? c.display_name : null;
    itens.push({ id: String(c.id), tipo: "canal", nome: String(nome ?? "Canal"), ativo: true });
  }
  for (const s of segredos) itens.push({ id: String(s.id), tipo: "segredo", nome: String(s.nome), ativo: true });
  for (const a of automacoes) itens.push({ id: String(a.id), tipo: "automacao", nome: String(a.name), ativo: true });
  for (const m of mensagens) itens.push({ id: String(m.id), tipo: "modelo", nome: String(m.title), ativo: true });
  for (const m of aprovados) {
    itens.push({ id: String(m.id), tipo: "modelo", nome: `${String(m.name)} (${String(m.language)})`, ativo: true });
  }
  return itens;
}
