/**
 * RECADASTRO — a pessoa que já tem um lead aberto neste funil e se cadastra de novo.
 *
 * Decisão do dono do produto (16/10/2026): a fonte de captação não cria um
 * segundo lead para quem já tem um ABERTO no funil padrão dela. Ela registra o
 * recadastro na linha do tempo do lead que já existe e deixa a etapa onde está.
 * Três casos, e só o primeiro é novo:
 *
 *   1. há lead ABERTO do contato no funil da fonte  -> recadastro (nenhum lead novo);
 *   2. só há lead GANHO ou PERDIDO no funil         -> lead novo (nova oportunidade);
 *   3. nenhum lead no funil (mesmo que haja em outro) -> lead novo, como sempre.
 *
 * "Aberto" é `crm_leads.status = 'open'` — a mesma definição de todo o resto do
 * produto (kanban, radar de risco, roteamento do agente). A tabela não tem
 * coluna de arquivado nem de mesclado: contato mesclado nem chega aqui (a rota
 * só reaproveita contato com `is_merged_into is null`).
 *
 * A decisão é PURA (`decidirRecadastro`), separada da consulta, para ser provada
 * sem banco: é ela que impede o lead duplicado, e a regra "ganho/perdido não
 * conta" é a que mais facilmente se quebraria em silêncio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** O mínimo de um lead do contato, no funil da fonte, para decidir. */
export interface LeadDoContatoNoFunil {
  id: string;
  status: string;
  last_activity_at: string | null;
  created_at: string;
}

export type DecisaoDeRecadastro =
  | { acao: "recadastrar"; leadId: string }
  | { acao: "criar" };

function instante(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * Quando o contato tem mais de um lead aberto no funil (estado que o produto
 * permite por outros caminhos), o recadastro vai para o mais recentemente
 * mexido — e, empatando, para o criado por último e depois pelo menor id. O
 * desempate final é arbitrário de propósito: o que importa é ser ESTÁVEL, para
 * o mesmo envio repetido cair sempre no mesmo lead.
 */
export function decidirRecadastro(leadsDoContatoNoFunil: readonly LeadDoContatoNoFunil[]): DecisaoDeRecadastro {
  const abertos = leadsDoContatoNoFunil.filter((l) => l.status === "open");
  if (abertos.length === 0) return { acao: "criar" };

  // Maior primeiro. Compara com `<`/`>` e não por subtração: `-Infinity - -Infinity`
  // é NaN, e um comparador que devolve NaN deixa a ordem indefinida.
  const maiorPrimeiro = (a: number, b: number): number => (a === b ? 0 : a > b ? -1 : 1);
  const ordenados = [...abertos].sort(
    (a, b) =>
      maiorPrimeiro(instante(a.last_activity_at), instante(b.last_activity_at)) ||
      maiorPrimeiro(instante(a.created_at), instante(b.created_at)) ||
      a.id.localeCompare(b.id),
  );
  return { acao: "recadastrar", leadId: ordenados[0]!.id };
}

/**
 * Procura o lead aberto do contato no funil da fonte.
 *
 * Toda consulta carrega `organization_id` (resolvido da FONTE, nunca do body):
 * o admin client ignora RLS.
 *
 * Falha ABERTA: se a consulta quebrar, devolve `criar` — o comportamento de
 * antes. Perder a captação por causa de uma leitura é pior do que um lead
 * duplicado, e o erro vai para o log com a causa.
 */
export async function decidirRecadastroDoContato(
  admin: SupabaseClient,
  alvo: { organizationId: string; contactId: string; pipelineId: string },
): Promise<DecisaoDeRecadastro> {
  const { data, error } = await admin
    .from("crm_leads")
    .select("id, status, last_activity_at, created_at")
    .eq("organization_id", alvo.organizationId)
    .eq("contact_id", alvo.contactId)
    .eq("pipeline_id", alvo.pipelineId)
    .eq("status", "open")
    .limit(50);

  if (error) {
    logger.error("[webhooks.recadastro] não foi possível consultar os leads do contato", {
      organizationId: alvo.organizationId,
      contactId: alvo.contactId,
      errorCode: error.code,
      errorMessage: error.message,
    });
    return { acao: "criar" };
  }

  const decisao = decidirRecadastro((data ?? []) as LeadDoContatoNoFunil[]);
  if (decisao.acao === "criar") return decisao;

  // Contato anonimizado (LGPD) não recebe dado novo na linha do tempo: segue o
  // caminho de antes (lead novo), que não escreve nada no histórico dele.
  const { data: contato } = await admin
    .from("contacts")
    .select("is_anonymized")
    .eq("organization_id", alvo.organizationId)
    .eq("id", alvo.contactId)
    .maybeSingle();
  if (contato?.is_anonymized === true) return { acao: "criar" };

  return decisao;
}
