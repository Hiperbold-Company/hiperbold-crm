/**
 * MENSAGEM AGENDADA — o lado do servidor das rotas (migration 1017).
 *
 * Duas regras de cliente, e elas não se misturam:
 *
 *   - a CONVERSA é lida com o cliente da SESSÃO: a RLS de `conversations` é que
 *     diz se esta pessoa enxerga a conversa. Quem não a vê não agenda nela, nem
 *     lista, nem edita o que outra pessoa marcou ali;
 *   - `scheduled_messages` é escrita pelo cliente de SERVIÇO, com
 *     `organization_id` vindo da sessão (nunca do corpo). `authenticated` só tem
 *     SELECT na tabela: a escrita passa por aqui, com as checagens daqui.
 *
 * A trava contra o worker é o próprio UPDATE: editar e cancelar só alcançam a
 * linha `agendada` com o `updated_at` que a tela viu. O worker reserva a linha
 * trocando o status para `enviando` (`fn_reservar_mensagens_agendadas`, `for
 * update skip locked`); quem chega depois afeta 0 linhas e recebe 409.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { linhaDoEspelho } from "@/lib/channels/linha-do-espelho";
import { lerConteudo } from "@/lib/channels/template-conteudo";

import {
  canalTemModelo,
  exigenciaAoAgendar,
  horarioValido,
  MAX_PENDENTES_POR_CONVERSA,
  MAX_PENDENTES_POR_USUARIO,
  type ExigenciaAoAgendar,
  type ModeloDaAgendada,
  type ModeloEscolhido,
  type StatusDaAgendada,
} from "./regras";
import { MENSAGEM_HORARIO_INVALIDO } from "./textos";

export const COLUNAS_DA_AGENDADA =
  "id, organization_id, conversation_id, contact_id, channel_session_id, created_by, body, template, send_at, status, motivo, message_id, adiada_ate, reservada_em, concluida_em, created_at, updated_at";

export interface LinhaDaAgendada {
  id: string;
  organization_id: string;
  conversation_id: string;
  contact_id: string | null;
  channel_session_id: string | null;
  created_by: string | null;
  body: string;
  template: ModeloDaAgendada | null;
  send_at: string;
  status: StatusDaAgendada;
  motivo: string | null;
  message_id: string | null;
  adiada_ate: string | null;
  reservada_em: string | null;
  concluida_em: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversaDoAgendamento {
  id: string;
  contact_id: string | null;
  channel_session_id: string | null;
  last_inbound_at: string | null;
  provider: string | null;
}

type Leitura<T> = { ok: true; valor: T } | { ok: false; erro: unknown };

/**
 * A conversa como ESTA pessoa a enxerga (`sessao`), mais o provider do canal
 * (`servico`, filtrado pela organização). `null` = não existe ou não é visível.
 */
export async function lerConversaDoAgendamento(
  sessao: SupabaseClient,
  servico: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<Leitura<ConversaDoAgendamento | null>> {
  const { data, error } = await sessao
    .from("conversations")
    .select("id, contact_id, channel_session_id, last_inbound_at")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { ok: false, erro: error };
  if (!data) return { ok: true, valor: null };
  const conversa = data as Omit<ConversaDoAgendamento, "provider">;

  let provider: string | null = null;
  if (conversa.channel_session_id) {
    const canal = await servico
      .from("channel_sessions")
      .select("id, provider")
      .eq("id", conversa.channel_session_id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (canal.error) return { ok: false, erro: canal.error };
    provider = ((canal.data as { provider?: string | null } | null)?.provider ?? null) || null;
  }
  return { ok: true, valor: { ...conversa, provider } };
}

export interface RecusaDoAgendamento {
  codigo:
    | "horario_invalido"
    | "modelo_obrigatorio"
    | "modelo_sem_canal"
    | "modelo_nao_aprovado"
    | "limite_da_conversa"
    | "limite_do_usuario";
  /** Chave do dicionário (pt-BR). A rota traduz. */
  mensagem: string;
}

export { MENSAGEM_HORARIO_INVALIDO };
export const MENSAGEM_MODELO_OBRIGATORIO =
  "A janela de 24 horas estará fechada no horário escolhido. Escolha um modelo aprovado para enviar se o cliente não responder antes.";
export const MENSAGEM_MODELO_SEM_CANAL = "Este canal não envia modelo aprovado.";
export const MENSAGEM_MODELO_NAO_APROVADO =
  "Este modelo não está aprovado na conexão desta conversa. Escolha um modelo aprovado.";
export const MENSAGEM_LIMITE_DA_CONVERSA =
  "Esta conversa já tem 20 mensagens agendadas para sair. Cancele uma antes de agendar outra.";
export const MENSAGEM_LIMITE_DO_USUARIO =
  "Você já tem 200 mensagens agendadas para sair. Cancele alguma antes de agendar outra.";

/**
 * O que impede este agendamento, ou `null` quando ele pode ser gravado.
 *
 * `conferirHorario: false` é a edição que não troca o horário: a hora gravada
 * pode já ter passado (a linha espera a janela de horário do canal abrir), e
 * isso não é motivo para recusar uma troca de texto. A janela de 24h é medida
 * então no mais tarde entre o horário gravado e agora.
 */
export function conferirAgendamento(
  conversa: Pick<ConversaDoAgendamento, "provider" | "last_inbound_at">,
  sendAt: Date,
  modelo: Pick<ModeloEscolhido, "name" | "language"> | null,
  agora: Date,
  opcoes: { conferirHorario?: boolean } = {},
): RecusaDoAgendamento | null {
  if (opcoes.conferirHorario !== false && !horarioValido(sendAt, agora)) {
    return { codigo: "horario_invalido", mensagem: MENSAGEM_HORARIO_INVALIDO };
  }
  if (modelo && !canalTemModelo(conversa.provider)) {
    return { codigo: "modelo_sem_canal", mensagem: MENSAGEM_MODELO_SEM_CANAL };
  }
  const medirEm = new Date(Math.max(sendAt.getTime(), agora.getTime()));
  const exigencia: ExigenciaAoAgendar = exigenciaAoAgendar(conversa.provider, conversa.last_inbound_at, medirEm);
  if (exigencia.tipo === "modelo_obrigatorio" && !modelo) {
    return { codigo: "modelo_obrigatorio", mensagem: MENSAGEM_MODELO_OBRIGATORIO };
  }
  return null;
}

/**
 * O modelo escolhido, conferido contra o espelho (`meta_templates`) DA CONEXÃO
 * DA CONVERSA — a mesma busca do envio (`linhaDoEspelho`: a linha da conexão
 * ou, no canal oficial, a da WABA dela) — e só se estiver APROVADO. O `body`
 * sai da definição guardada, nunca do navegador. `null` = não existe nessa
 * conexão ou não está aprovado. Erro de leitura volta como erro.
 *
 * Usada na criação, na edição e de novo pelo worker antes de enviar: o modelo
 * aprovado hoje pode ter sido pausado ou apagado até a hora marcada.
 */
export async function modeloAprovadoDaConexao(
  servico: SupabaseClient,
  organizationId: string,
  channelSessionId: string | null,
  escolhido: ModeloEscolhido,
): Promise<Leitura<ModeloDaAgendada | null>> {
  // Sem conexão não há conta onde o modelo seria aprovado.
  if (!channelSessionId) return { ok: true, valor: null };
  const { data, error } = await linhaDoEspelho<{ name: string; language: string; status: string | null; components: unknown }>(
    servico,
    "name, language, status, components",
    { organizationId, name: escolhido.name, language: escolhido.language, channelSessionId },
  );
  if (error) return { ok: false, erro: error };
  if (!data || String(data.status ?? "").toUpperCase() !== "APPROVED") return { ok: true, valor: null };
  const componentes = Array.isArray(data.components) ? (data.components as unknown[]) : [];
  const body = lerConteudo(componentes).body?.trim() || data.name;
  return { ok: true, valor: { name: data.name, language: data.language, values: escolhido.values, body } };
}

/**
 * O teto de pendentes (`agendada`/`enviando`) da conversa e de quem agenda.
 * `null` = cabe mais uma. Conta antes do insert (ver `MAX_PENDENTES_POR_CONVERSA`).
 */
export async function conferirTetoDePendentes(
  servico: SupabaseClient,
  entrada: { organizationId: string; conversationId: string; userId: string },
): Promise<Leitura<RecusaDoAgendamento | null>> {
  const contar = async (coluna: "conversation_id" | "created_by", valor: string) => {
    const { count, error } = await servico
      .from("scheduled_messages")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", entrada.organizationId)
      .eq(coluna, valor)
      .in("status", ["agendada", "enviando"]);
    if (error) throw error;
    return count ?? 0;
  };
  try {
    if ((await contar("conversation_id", entrada.conversationId)) >= MAX_PENDENTES_POR_CONVERSA) {
      return { ok: true, valor: { codigo: "limite_da_conversa", mensagem: MENSAGEM_LIMITE_DA_CONVERSA } };
    }
    if ((await contar("created_by", entrada.userId)) >= MAX_PENDENTES_POR_USUARIO) {
      return { ok: true, valor: { codigo: "limite_do_usuario", mensagem: MENSAGEM_LIMITE_DO_USUARIO } };
    }
    return { ok: true, valor: null };
  } catch (erro) {
    return { ok: false, erro };
  }
}

/** Grava a agendada. `id` e carimbos saem daqui para a linha devolvida ser a gravada. */
export async function inserirAgendada(
  servico: SupabaseClient,
  entrada: {
    organizationId: string;
    userId: string;
    conversa: ConversaDoAgendamento;
    body: string;
    sendAt: Date;
    modelo: ModeloDaAgendada | null;
    agora: Date;
  },
): Promise<Leitura<LinhaDaAgendada>> {
  const agoraIso = entrada.agora.toISOString();
  const { data, error } = await servico
    .from("scheduled_messages")
    .insert({
      id: randomUUID(),
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversa.id,
      contact_id: entrada.conversa.contact_id,
      channel_session_id: entrada.conversa.channel_session_id,
      created_by: entrada.userId,
      body: entrada.body,
      template: entrada.modelo,
      send_at: entrada.sendAt.toISOString(),
      status: "agendada",
      created_at: agoraIso,
      updated_at: agoraIso,
    })
    .select(COLUNAS_DA_AGENDADA)
    .single();
  if (error || !data) return { ok: false, erro: error ?? new Error("insert sem linha") };
  return { ok: true, valor: data as unknown as LinhaDaAgendada };
}

/**
 * O que a conversa mostra: as que ainda vão sair (`agendada`, `enviando`) e as
 * que falharam ANTES de virar mensagem. Falha que gerou mensagem já aparece como
 * a bolha de falha da própria mensagem — mostrar as duas diria a mesma coisa duas vezes.
 */
export async function listarAgendadasDaConversa(
  servico: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<Leitura<LinhaDaAgendada[]>> {
  const { data, error } = await servico
    .from("scheduled_messages")
    .select(COLUNAS_DA_AGENDADA)
    .eq("organization_id", organizationId)
    .eq("conversation_id", conversationId)
    .in("status", ["agendada", "enviando", "falhou"])
    .order("send_at", { ascending: true })
    .limit(50);
  if (error) return { ok: false, erro: error };
  const linhas = ((data ?? []) as unknown as LinhaDaAgendada[]).filter(
    (l) => l.status !== "falhou" || l.message_id === null,
  );
  return { ok: true, valor: linhas };
}

/** Uma agendada da organização, por id. `null` = não existe aqui. */
export async function lerAgendada(
  servico: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<Leitura<LinhaDaAgendada | null>> {
  const { data, error } = await servico
    .from("scheduled_messages")
    .select(COLUNAS_DA_AGENDADA)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { ok: false, erro: error };
  return { ok: true, valor: (data as unknown as LinhaDaAgendada | null) ?? null };
}

export type DesfechoDaEscrita =
  | { tipo: "ok"; linha: LinhaDaAgendada }
  /** A linha mudou desde que a tela a leu (o worker reservou, outra aba editou ou cancelou). */
  | { tipo: "conflito" }
  | { tipo: "erro"; erro: unknown };

/**
 * Edita só a linha `agendada` com o `updated_at` visto. Trocar o horário zera o
 * adiamento pela janela de horário do canal: a conta recomeça do horário novo.
 */
export async function editarAgendada(
  servico: SupabaseClient,
  entrada: {
    organizationId: string;
    id: string;
    vistoEm: string;
    patch: { body?: string; send_at?: string; template?: ModeloDaAgendada | null };
    agora: Date;
  },
): Promise<DesfechoDaEscrita> {
  const patch: Record<string, unknown> = { ...entrada.patch, updated_at: entrada.agora.toISOString() };
  if (entrada.patch.send_at !== undefined) patch.adiada_ate = null;
  const { data, error } = await servico
    .from("scheduled_messages")
    .update(patch)
    .eq("id", entrada.id)
    .eq("organization_id", entrada.organizationId)
    .eq("status", "agendada")
    .eq("updated_at", entrada.vistoEm)
    .select(COLUNAS_DA_AGENDADA)
    .maybeSingle();
  if (error) return { tipo: "erro", erro: error };
  if (!data) return { tipo: "conflito" };
  return { tipo: "ok", linha: data as unknown as LinhaDaAgendada };
}

export const MOTIVO_CANCELADA_PELA_EQUIPE = "Cancelada pela equipe.";

/**
 * Cancela a que ainda vai sair (`agendada`) ou dispensa a que falhou antes de
 * virar mensagem (`falhou`). `enviando` não se cancela: o envio já começou, e
 * mudar o status por baixo dele diria "cancelada" de uma mensagem que saiu.
 */
export async function cancelarAgendada(
  servico: SupabaseClient,
  entrada: { organizationId: string; id: string; agora: Date },
): Promise<DesfechoDaEscrita> {
  const agoraIso = entrada.agora.toISOString();
  const { data, error } = await servico
    .from("scheduled_messages")
    .update({ status: "cancelada", motivo: MOTIVO_CANCELADA_PELA_EQUIPE, concluida_em: agoraIso, updated_at: agoraIso })
    .eq("id", entrada.id)
    .eq("organization_id", entrada.organizationId)
    .in("status", ["agendada", "falhou"])
    .select(COLUNAS_DA_AGENDADA)
    .maybeSingle();
  if (error) return { tipo: "erro", erro: error };
  if (!data) return { tipo: "conflito" };
  return { tipo: "ok", linha: data as unknown as LinhaDaAgendada };
}
