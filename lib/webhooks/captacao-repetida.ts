/**
 * CAPTAÇÃO REPETIDA — o mesmo formulário enviado duas vezes em segundos (clique
 * duplo) vira UM negócio, também quando os dois envios chegam juntos.
 *
 * Medido em produção (27/10/2026, CBEXS): dois envios em 1 s, com external_id
 * diferentes, passaram juntos pelo recadastro (que pergunta antes de criar) e
 * criaram dois negócios abertos no mesmo funil. Quem fecha a corrida é o banco:
 * o gatilho `trg_crm_leads_captacao_repetida` (migration 0977) toma um lock por
 * (organização, contato, funil) no INSERT e recusa o segundo negócio com a
 * mensagem `captacao_repetida_na_janela` quando já há negócio aberto do contato
 * no funil criado há no máximo `JANELA_DA_CAPTACAO_REPETIDA_MS`.
 *
 * Este módulo é o lado da rota: reconhecer a recusa e achar o negócio vencedor,
 * para responder como no reenvio do mesmo external_id.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Janela em que um segundo negócio aberto do mesmo contato no mesmo funil é tido
 * como o MESMO envio repetido. Tem de ser igual ao `interval '10 minutes'` da
 * função `fn_crm_leads_captacao_repetida` (cobrado por teste).
 */
export const JANELA_DA_CAPTACAO_REPETIDA_MS = 10 * 60 * 1000;

/** A mensagem da recusa do gatilho (sqlstate PT409). */
export const MENSAGEM_DA_CAPTACAO_REPETIDA = "captacao_repetida_na_janela";

/** A recusa veio do gatilho da captação repetida? `createLeadHandler` repassa a mensagem do banco. */
export function ehCaptacaoRepetida(erro: unknown): boolean {
  if (!erro || typeof erro !== "object") return false;
  const mensagem = (erro as { message?: unknown }).message;
  return typeof mensagem === "string" && mensagem.includes(MENSAGEM_DA_CAPTACAO_REPETIDA);
}

export interface NegocioCandidato {
  id: string;
  status: string;
  pipeline_id: string;
  created_at: string;
}

/**
 * A mesma regra do gatilho, sobre negócios já lidos do contato: aberto, no funil
 * da fonte, criado dentro da janela. Vence o criado primeiro (e, empatando, o
 * menor id), como no `order by created_at, id` da função.
 */
export function negocioDaCaptacaoRepetida(
  negocios: readonly NegocioCandidato[],
  alvo: { pipelineId: string; agora: number },
): string | null {
  const limite = alvo.agora - JANELA_DA_CAPTACAO_REPETIDA_MS;
  const dentro = negocios.filter((n) => {
    const criado = new Date(n.created_at).getTime();
    return (
      n.status === "open" &&
      n.pipeline_id === alvo.pipelineId &&
      Number.isFinite(criado) &&
      criado >= limite
    );
  });
  if (dentro.length === 0) return null;
  const [primeiro] = [...dentro].sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return primeiro!.id;
}

/**
 * Procura o negócio que venceu a corrida. `organization_id` vem da FONTE, nunca
 * do body: o admin client ignora RLS.
 */
export async function buscarNegocioDaCaptacaoRepetida(
  admin: SupabaseClient,
  alvo: { organizationId: string; contactId: string; pipelineId: string },
): Promise<string | null> {
  const agora = Date.now();
  const { data, error } = await admin
    .from("crm_leads")
    .select("id, status, pipeline_id, created_at")
    .eq("organization_id", alvo.organizationId)
    .eq("contact_id", alvo.contactId)
    .eq("pipeline_id", alvo.pipelineId)
    .eq("status", "open")
    .gte("created_at", new Date(agora - JANELA_DA_CAPTACAO_REPETIDA_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) return null;
  return negocioDaCaptacaoRepetida((data ?? []) as NegocioCandidato[], {
    pipelineId: alvo.pipelineId,
    agora,
  });
}
