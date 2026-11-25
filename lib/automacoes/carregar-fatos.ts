/**
 * Carrega os fatos de uma execução de automação pelo client service-role.
 *
 * ⚠️ Service role ignora RLS: TODA consulta filtra `organization_id` (vem da
 * inscrição, que veio do banco — nunca de corpo de requisição).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { chavesRestritasDaOrganizacao } from "@/lib/campos/chaves-restritas";
import { idsDoContatoEGemeos } from "@/lib/channels/contato-por-telefone";

import { anuncioDoFluxo } from "./anuncio-do-contato";
import { conversaDoEnvio, janelaDaConversa } from "./conversa-de-whatsapp";
import { fatosTemCamposPersonalizados, negocioDaExecucao, type FatosDaAutomacao, type NegocioDosFatos } from "./fatos";

const COLUNAS_DO_NEGOCIO =
  "id, title, pipeline_id, stage_id, status, value_cents, owner_user_id, source, tags, expected_close_date, custom_fields, updated_at";

function objeto(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function negocioDe(row: Record<string, unknown>): NegocioDosFatos {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    pipeline_id: String(row.pipeline_id),
    stage_id: String(row.stage_id),
    status: String(row.status),
    value_cents: typeof row.value_cents === "number" ? row.value_cents : null,
    owner_user_id: (row.owner_user_id as string | null) ?? null,
    source: String(row.source ?? ""),
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    expected_close_date: (row.expected_close_date as string | null) ?? null,
    custom_fields: objeto(row.custom_fields),
  };
}

/** O que só alguns passos leem — e só eles pagam a consulta. */
export interface OpcoesDosFatos {
  /** A janela de 24h da conversa do envio (condição "Janela de 24h aberta?"; ver `conversaDoEnvio`). */
  janela?: boolean;
  agora?: Date;
}

export async function carregarFatosDaAutomacao(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
  vars: Record<string, unknown>,
  opcoes: OpcoesDosFatos = {},
): Promise<FatosDaAutomacao> {
  const [{ data: contato, error: erroContato }, { data: negocios, error: erroNegocios }] = await Promise.all([
    admin
      .from("contacts")
      .select("id, name, email, phone_number, birthdate, tags, custom_fields, source_metadata, carteira_user_id")
      .eq("organization_id", orgId)
      .eq("id", contactId)
      .maybeSingle(),
    admin
      .from("crm_leads")
      .select(COLUNAS_DO_NEGOCIO)
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .order("updated_at", { ascending: false })
      .limit(200),
  ]);
  if (erroContato) throw new Error(`fatos_contato: ${erroContato.message}`);
  if (erroNegocios) throw new Error(`fatos_negocios: ${erroNegocios.message}`);

  const lista = ((negocios ?? []) as Array<Record<string, unknown>>).map(negocioDe);
  const idDaExecucao = negocioDaExecucao(vars);
  const negocio =
    (idDaExecucao ? lista.find((n) => n.id === idDaExecucao) : undefined) ??
    lista.find((n) => n.status === "open") ??
    null;

  const c = contato as Record<string, unknown> | null;
  // A janela da MESMA conversa por onde o bloco de mensagem enviaria: o Direct
  // de quem comentou, na execução que nasceu de comentário; senão, o WhatsApp.
  const janela = opcoes.janela
    ? janelaDaConversa(
        await conversaDoEnvio(admin, orgId, vars, await idsDoContatoEGemeos(admin, orgId, contactId)),
        opcoes.agora ?? new Date(),
      )
    : undefined;
  const fatos: FatosDaAutomacao = {
    contato: c
      ? {
          id: String(c.id),
          name: (c.name as string | null) ?? null,
          email: (c.email as string | null) ?? null,
          phone_number: (c.phone_number as string | null) ?? null,
          birthdate: (c.birthdate as string | null) ?? null,
          tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
          custom_fields: objeto(c.custom_fields),
          anuncio: anuncioDoFluxo(c.source_metadata),
          carteira_user_id: (c.carteira_user_id as string | null | undefined) ?? null,
        }
      : null,
    negocio,
    negocios: lista.map((n) => ({ id: n.id, pipeline_id: n.pipeline_id, stage_id: n.stage_id, status: n.status })),
    vars,
    ...(janela ? { janela } : {}),
  };
  // 1015: só lê quando há valor a esconder (e falha de leitura = nenhum campo vira texto).
  if (fatosTemCamposPersonalizados(fatos)) {
    const lidas = await chavesRestritasDaOrganizacao(admin, orgId);
    fatos.camposRestritos = lidas.ok ? [...lidas.chaves] : "todas";
  }
  return fatos;
}
