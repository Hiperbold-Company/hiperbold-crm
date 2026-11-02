/**
 * Ingestão do canal social oficial: evento lido e autenticado → contato,
 * conversa, mensagem.
 *
 * NÃO reimplementa o caminho do contato social. Monta o mesmo `SocialMessage`
 * que o canal intermediado monta e entrega à ingestão que já existe
 * (`ingestZernioInbound` com `socialMessage`), que já faz: contato por
 * `contacts.social_identity` (`<rede>:<conta>:<cliente>`), conversa por
 * `provider_conversation_id` (aqui, o IGSID/PSID — é o endereço do envio),
 * `conversations.channel` instagram/facebook, idempotência por
 * `unique (organization_id, external_id)` com captura do 23505, pedido de
 * persistência da mídia no Storage, efeitos pós-entrada (opt-out, lead,
 * agente) e pausa da IA quando alguém responde por fora. Uma segunda cópia
 * desse caminho seria a cópia que diverge.
 *
 * O que é DESTE canal: o eco do próprio envio, a mensagem apagada
 * (`revoked_at`), a leitura (`read_at`) e o nome do perfil, best-effort.
 *
 * O eco do próprio envio é reconhecido de três jeitos, nesta ordem:
 *   1. `app_id` do eco é de um app desta instalação (quando a Meta o manda);
 *   2. o `mid` está em `meta_social_envios` — TODO mid que a Meta devolveu num
 *      envio nosso, pedaço por pedaço e a imagem (o adapter grava ao enviar);
 *   3. o `mid` já é o `external_id` de uma mensagem desta organização.
 * Sem o 2, só o mid do ÚLTIMO pedaço ficava conhecido (é o que vira
 * `external_id`), e o eco dos pedaços anteriores, sem `app_id`, entrava como
 * "respondido pelo celular": linha duplicada e IA pausada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import type { SocialMessage } from "../social/parser";
import { ingestZernioInbound } from "../zernio/ingest";
import { CHANNEL_PROVIDER_META_SOCIAL } from "../capabilities";
import { canalDaConversa, type PlataformaMetaSocial } from "./constantes";
import { perfilDoRemetente } from "./oauth";
import type { EventoMetaSocial } from "./webhook";

export interface SessaoMetaSocial {
  id: string;
  organizationId: string;
  plataforma: PlataformaMetaSocial;
  contaId: string;
  tokenCifrado: string | null;
}

export interface DesfechoDaIngestao {
  status: "ingested" | "duplicate" | "ignored";
  reason?: string;
}

/**
 * A sessão viva de `(plataforma, conta)`. É o que escolhe a organização: a
 * linha do banco, achada pela conta do `entry.id` assinado pela Meta — não um
 * campo do corpo que diga de quem é.
 */
export async function sessaoPelaConta(
  admin: SupabaseClient,
  plataforma: PlataformaMetaSocial,
  contaId: string,
): Promise<SessaoMetaSocial | null> {
  // cerca-canal: resolucao_pela_conta_assinada (tests/unit/canal-consulta-por-organizacao.test.ts)
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, meta_social_platform, meta_social_account_id, meta_social_token_encrypted")
    .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
    .eq("meta_social_platform", plataforma)
    .eq("meta_social_account_id", contaId)
    .is("archived_at", null)
    .limit(2);
  if (error) throw new Error("meta_social_session_lookup_failed");
  const linhas = (data ?? []) as {
    id: string;
    organization_id: string;
    meta_social_token_encrypted: string | null;
  }[];
  // Duas linhas vivas não deveriam existir (índice único). Se existirem, não
  // escolhemos uma ao acaso: escrever na organização errada é o pior desfecho.
  if (linhas.length !== 1) return null;
  const l = linhas[0]!;
  return {
    id: l.id,
    organizationId: l.organization_id,
    plataforma,
    contaId,
    tokenCifrado: l.meta_social_token_encrypted,
  };
}

export function identidadeSocial(plataforma: PlataformaMetaSocial, contaId: string, clienteId: string): string {
  return `${canalDaConversa(plataforma)}:${contaId}:${clienteId}`;
}

/** Evento → o `SocialMessage` que a ingestão social compartilhada entende. */
export function mensagemSocialDoEvento(
  evento: Extract<EventoMetaSocial, { tipo: "mensagem" }>,
  nome: string | null,
  usuario: string | null,
): SocialMessage {
  return {
    platform: canalDaConversa(evento.plataforma),
    participantId: evento.clienteId,
    accountId: evento.contaId,
    conversationId: evento.clienteId,
    externalId: evento.mid,
    direction: evento.direcao,
    kind: "message",
    status: evento.direcao === "outbound" ? "sent" : undefined,
    text: evento.texto,
    sentAt: evento.enviadaEm,
    attachments: evento.anexos,
    referral: null,
    identity: { phone: null, bsuid: null, anchor: null, username: usuario, displayName: nome },
  };
}

export interface Dependencias {
  ingerir: typeof ingestZernioInbound;
  perfil: typeof perfilDoRemetente;
  decifrar: typeof decryptWebhookSecret;
}

const PADRAO: Dependencias = {
  ingerir: ingestZernioInbound,
  perfil: perfilDoRemetente,
  decifrar: decryptWebhookSecret,
};

export async function ingerirEventoMetaSocial(
  admin: SupabaseClient,
  sessao: SessaoMetaSocial,
  evento: EventoMetaSocial,
  opcoes: { appIdsProprios: readonly string[] },
  substitutos: Partial<Dependencias> = {},
): Promise<DesfechoDaIngestao> {
  const deps: Dependencias = { ...PADRAO, ...substitutos };
  if (evento.tipo === "apagada") {
    const { data, error } = await admin
      .from("messages")
      .update({ revoked_at: new Date().toISOString() })
      .eq("organization_id", sessao.organizationId)
      .eq("channel_session_id", sessao.id)
      .eq("external_id", evento.mid)
      .is("revoked_at", null)
      .select("id");
    if (error) throw new Error("meta_social_revoke_failed");
    return (data ?? []).length > 0
      ? { status: "ingested", reason: "apagada" }
      : { status: "ignored", reason: "mensagem_desconhecida" };
  }

  if (evento.tipo === "lida") return marcarLida(admin, sessao, evento);

  // Eco de envio feito PELA API deste app: a linha já existe (o CRM a gravou)
  // ou vai existir em instantes. Ingerir criaria uma duplicata "do celular" e
  // pausaria a IA como se uma pessoa tivesse respondido por fora.
  if (evento.direcao === "outbound" && (await ehEcoDoProprioEnvio(admin, sessao, evento, opcoes.appIdsProprios))) {
    return { status: "ignored", reason: "eco_do_proprio_envio" };
  }
  if (!evento.texto && evento.anexos.length === 0) {
    return { status: "ignored", reason: "mensagem_sem_conteudo" };
  }

  // Nome do perfil só para contato NOVO: uma ida à Meta por mensagem seria
  // custo sem ganho. Falha não bloqueia — o contato nasce sem nome.
  let nome: string | null = null;
  let usuario: string | null = null;
  const identidade = identidadeSocial(sessao.plataforma, sessao.contaId, evento.clienteId);
  const { data: existente } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", sessao.organizationId)
    .eq("social_identity", identidade)
    .is("is_merged_into", null)
    .maybeSingle();
  if (!existente && sessao.tokenCifrado) {
    const token = await deps.decifrar(admin, sessao.tokenCifrado);
    const perfil = token ? await deps.perfil(sessao.plataforma, evento.clienteId, token) : null;
    nome = perfil?.nome ?? null;
    usuario = perfil?.usuario ?? null;
  }

  const r = await deps.ingerir(admin, {
    organizationId: sessao.organizationId,
    channelSessionId: sessao.id,
    payload: null,
    socialMessage: mensagemSocialDoEvento(evento, nome, usuario),
  });
  if (r.status === "unknown_account") return { status: "ignored", reason: "conta_desconhecida" };
  if (r.status === "ignored") {
    logger.info("[meta-social.ingest] evento ignorado", {
      organization_id: sessao.organizationId,
      reason: r.reason,
    });
  }
  return { status: r.status, reason: r.reason };
}

/**
 * O eco é de um envio NOSSO? Lança se a consulta falhar: na dúvida, a rota
 * devolve 500 e a Meta reentrega — tratar como "do celular" pausaria a IA.
 */
async function ehEcoDoProprioEnvio(
  admin: SupabaseClient,
  sessao: SessaoMetaSocial,
  evento: Extract<EventoMetaSocial, { tipo: "mensagem" }>,
  appIdsProprios: readonly string[],
): Promise<boolean> {
  if (evento.appId && appIdsProprios.includes(evento.appId)) return true;
  const { data: envio, error: erroDoEnvio } = await admin
    .from("meta_social_envios")
    .select("mid")
    .eq("organization_id", sessao.organizationId)
    .eq("mid", evento.mid)
    .limit(1);
  if (erroDoEnvio) throw new Error("meta_social_echo_lookup_failed");
  if ((envio ?? []).length > 0) return true;
  const { data: gravada, error: erroDaMensagem } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", sessao.organizationId)
    .eq("external_id", evento.mid)
    .limit(1);
  if (erroDaMensagem) throw new Error("meta_social_echo_lookup_failed");
  return (gravada ?? []).length > 0;
}

/**
 * Carimba a leitura nas mensagens de SAÍDA desta sessão. Cada coluna é gravada
 * uma vez (`is null`): o primeiro evento que a alcança é o que vale, e a Meta
 * reentrega. Quem leu, recebeu: `delivered_at` vazio ganha a mesma hora.
 */
async function marcarLida(
  admin: SupabaseClient,
  sessao: SessaoMetaSocial,
  evento: Extract<EventoMetaSocial, { tipo: "lida" }>,
): Promise<DesfechoDaIngestao> {
  const quando = evento.lidaEm ?? new Date().toISOString();
  let conversaId: string | null = null;
  if (!evento.mid) {
    const { data, error } = await admin
      .from("conversations")
      .select("id")
      .eq("organization_id", sessao.organizationId)
      .eq("channel_session_id", sessao.id)
      .eq("provider_conversation_id", evento.clienteId)
      .limit(1);
    if (error) throw new Error("meta_social_read_lookup_failed");
    conversaId = ((data ?? []) as { id: string }[])[0]?.id ?? null;
    if (!conversaId) return { status: "ignored", reason: "conversa_desconhecida" };
  }
  let alcancou = 0;
  for (const coluna of ["read_at", "delivered_at"] as const) {
    let q = admin
      .from("messages")
      .update({ [coluna]: quando })
      .eq("organization_id", sessao.organizationId)
      .eq("channel_session_id", sessao.id)
      .eq("direction", "outbound");
    q = evento.mid
      ? q.eq("external_id", evento.mid)
      : q.eq("conversation_id", conversaId!).lte("created_at", new Date(evento.ateMs!).toISOString());
    const { data, error } = await q.is(coluna, null).select("id");
    if (error) throw new Error("meta_social_read_update_failed");
    if (coluna === "read_at") alcancou = (data ?? []).length;
  }
  return alcancou > 0
    ? { status: "ingested", reason: "lida" }
    : { status: "ignored", reason: "nada_a_marcar" };
}
