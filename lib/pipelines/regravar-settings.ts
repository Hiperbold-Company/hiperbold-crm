/**
 * LER-MODIFICAR-GRAVAR o `settings` de um funil, com trava otimista por `updated_at`.
 *
 * `crm_pipelines.settings` tem vários escritores (configuração do funil, "Editar cartão", Cold
 * Call). Quem lia o objeto, mudava uma chave e regravava o objeto inteiro apagava em silêncio a
 * chave que outro gravou no meio (ex.: `card_lines`). Aqui o UPDATE só vale se a linha ainda tem o
 * `updated_at` lido (o gatilho `fn_set_updated_at` o move a cada escrita); senão relê e aplica a
 * mudança de novo sobre o que o outro gravou. Mesma técnica de `aplicarConfiguracaoDoFunil`.
 *
 * `mudar` recebe o `settings` atual e devolve o próximo, ou `null` quando não há nada a mudar.
 * Filtra por organização sempre (o chamador pode estar com o client admin). Erro de banco sobe.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ResultadoDaRegravacao = "gravou" | "nada_a_mudar" | "nao_encontrado" | "conflito";

export async function regravarSettingsDoFunil(
  client: SupabaseClient,
  alvo: { organizationId: string; pipelineId: string },
  mudar: (atual: Record<string, unknown>) => Record<string, unknown> | null,
  tentativas = 4,
): Promise<ResultadoDaRegravacao> {
  for (let i = 0; i < tentativas; i += 1) {
    const { data, error } = await client
      .from("crm_pipelines")
      .select("settings, updated_at")
      .eq("id", alvo.pipelineId)
      .eq("organization_id", alvo.organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return "nao_encontrado";
    const linha = data as { settings?: unknown; updated_at?: string | null };
    const atual =
      linha.settings && typeof linha.settings === "object" && !Array.isArray(linha.settings)
        ? (linha.settings as Record<string, unknown>)
        : {};
    const proximo = mudar(atual);
    if (!proximo) return "nada_a_mudar";

    let escrita = client
      .from("crm_pipelines")
      .update({ settings: proximo })
      .eq("id", alvo.pipelineId)
      .eq("organization_id", alvo.organizationId);
    if (linha.updated_at) escrita = escrita.eq("updated_at", linha.updated_at);
    const { data: gravadas, error: erroGravar } = await escrita.select("id");
    if (erroGravar) throw new Error(erroGravar.message);
    if ((gravadas ?? []).length > 0) return "gravou";
  }
  return "conflito";
}
