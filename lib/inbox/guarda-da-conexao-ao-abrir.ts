/**
 * O lado do SERVIDOR da regra "por qual conexão abrir" — chamado por
 * `POST /api/v1/conversations/open-with-contact` só para a sessão do navegador.
 * Token de servidor (bearer) não passa por aqui: segue o comportamento de antes.
 *
 * Lê TODAS as conversas do contato (sem o recorte de visibilidade da tela):
 * quem decide o que pode precisa saber o que existe.
 *
 * Qualquer modo, sem `channel_session_id` e com conexão própria: reaproveita a
 * conversa que já está numa conexão minha; senão sai pela minha (conectada
 * primeiro) — nunca pela mais antiga da organização.
 *
 * Modo `own_only`, papel abaixo de gerente (`decidirAbertura` é a mesma da tela):
 *  - `channel_session_id` que não é meu (ou, sem conexão própria, que não é o
 *    número geral) → `conexao_alheia`;
 *  - contato na conexão de outro atendente, sem transferência → `contato_de_outro`;
 *  - sem conexão própria nem número geral → `sem_conexao`.
 * A recusa não devolve nome de conexão: quem não enxerga a conversa do colega
 * não fica sabendo dela por aqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  conexaoPermitidaNoModoRestrito,
  decidirAbertura,
  type MotivoDaRecusa,
} from "@/lib/inbox/conexao-ao-abrir";
import { carregarOpcoesDeAbertura } from "@/lib/inbox/opcoes-de-abertura";
import type { OpenSharedContactInput } from "@/lib/messaging/open-shared-contact-conversation";

export type GuardaDaConexao =
  | { ok: true; channelSessionId: string | undefined }
  | { ok: false; motivo: MotivoDaRecusa };

export async function guardarConexaoAoAbrir(
  admin: SupabaseClient,
  p: {
    organizationId: string;
    userId: string;
    role: string | undefined;
    input: OpenSharedContactInput & { lead_id?: string };
  },
): Promise<GuardaDaConexao> {
  const { input } = p;
  const opcoes = await carregarOpcoesDeAbertura(admin, {
    organizationId: p.organizationId,
    userId: p.userId,
    role: p.role,
    contactId: input.contact_id ?? null,
    phone: input.contact_id ? null : (input.phone_number ?? null),
    leadId: input.lead_id ?? null,
  });

  if (opcoes.restrito) {
    if (input.channel_session_id && !conexaoPermitidaNoModoRestrito(opcoes, input.channel_session_id)) {
      return { ok: false, motivo: "conexao_alheia" };
    }
    const decisao = decidirAbertura(opcoes);
    if (decisao.tipo === "recusar") return { ok: false, motivo: decisao.motivo };
    if (input.channel_session_id) return { ok: true, channelSessionId: input.channel_session_id };
    if (decisao.tipo === "abrir") {
      const c = opcoes.conversas.find((x) => x.conversation_id === decisao.conversationId);
      return { ok: true, channelSessionId: c?.channel_session_id };
    }
    if (decisao.tipo === "iniciar") return { ok: true, channelSessionId: decisao.conexao.id };
    return { ok: true, channelSessionId: undefined };
  }

  if (input.channel_session_id || !opcoes.minha_conexao) {
    return { ok: true, channelSessionId: input.channel_session_id };
  }
  const naMinha = opcoes.conversas.find((c) => opcoes.minhas_conexoes_ids.includes(c.channel_session_id));
  return { ok: true, channelSessionId: naMinha?.channel_session_id ?? opcoes.minha_conexao.id };
}
