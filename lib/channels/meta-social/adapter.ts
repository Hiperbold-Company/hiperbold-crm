/**
 * Adapter do canal social oficial (Instagram Direct e Messenger pela Meta).
 *
 * Tradutor de formato, como todo adapter: a janela de 24h é da cadeia
 * `before_send` (`freeformOutsideWindow: false` na matriz), não daqui.
 *
 * O destinatário é o IGSID/PSID guardado na conversa
 * (`conversations.provider_conversation_id`, gravado pela ingestão) e chega em
 * `envelope.providerConversationId`. `resolveRecipient` só diz "há endereço":
 * o contato não carrega o id da rede.
 */
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { lerComTeto } from "@/lib/messaging/media/ler-com-teto";
import { MAX_MEDIA_BYTES, MediaTooLargeError } from "@/lib/messaging/media/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ChannelAdapter, OutboundEnvelope } from "../types";
import { CHANNEL_PROVIDER_META_SOCIAL } from "../capabilities";
import { tetoDoTexto } from "./constantes";
import { enviar, montarEnvios } from "./oauth";
import { credencialDaConta } from "./store";

export const metaSocialAdapter: ChannelAdapter = {
  provider: CHANNEL_PROVIDER_META_SOCIAL,
  resolveRecipient: (input) => (input.isGroup ? null : "provider-thread"),
  // A credencial é por conta, na sessão: não há configuração global a faltar.
  isConfigured: () => true,
  codes: {
    notConfigured: "meta_social_not_configured",
    sendFailed: "meta_social_send_failed",
    unknownError: "meta_social_error",
  },

  async send(envelope: OutboundEnvelope) {
    if (!envelope.providerConversationId)
      throw new Error("Aguarde uma mensagem do cliente para responder nesta rede.");
    if (envelope.kind !== "text" && envelope.kind !== "image")
      throw new Error("Este tipo de mensagem ainda não é suportado nesta rede.");
    const cred = await credencialDaConta(
      createAdminClient(),
      envelope.organizationId,
      envelope.sessionRef,
    );
    if (!cred) throw new Error("Reconecte esta conta em Conexões › Redes sociais.");
    const envios = montarEnvios({
      plataforma: cred.plataforma,
      contaId: envelope.sessionRef,
      destinatario: envelope.providerConversationId,
      texto: envelope.kind === "image" ? (envelope.media?.caption ?? null) : (envelope.body ?? ""),
      imagemUrl: envelope.kind === "image" ? (envelope.media?.url ?? null) : null,
      teto: tetoDoTexto(cred.plataforma),
    });
    if (envios.length === 0) throw new Error("Mensagem vazia.");
    await envelope.beforeSend?.();
    let ultimo: string | null = null;
    for (const r of envios) ultimo = await enviar(r, cred.token);
    return { externalId: ultimo };
  },

  /** A mídia recebida vem com URL assinada da CDN da Meta, sem token. */
  async fetchInboundMedia(input) {
    const url = new URL(input.url);
    if (url.protocol !== "https:") throw new Error("Endereço de mídia inválido.");
    assertSafeOutboundUrl(url.toString());
    await assertDestinoResolvidoSeguro(url.hostname);
    const resposta = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!resposta.ok) throw new Error(`Falha ao baixar mídia (HTTP ${resposta.status}).`);
    const buffer = await lerComTeto(resposta, MAX_MEDIA_BYTES);
    if (!buffer) throw new MediaTooLargeError();
    return {
      buffer,
      mime:
        resposta.headers.get("content-type")?.split(";")[0]?.trim() ||
        input.hintMime ||
        "application/octet-stream",
    };
  },

  /**
   * Saúde lida da SESSÃO, sem ir à Meta: o que derruba este canal é token
   * vencido ou renovação que falhou, e quem descobre isso é o cron
   * `meta-social-tokens`. O vigia de conexão (`channel-health`) transforma a
   * resposta em aviso na Central, como faz com os outros canais.
   */
  async checkHealth(input) {
    const { data } = await createAdminClient()
      .from("channel_sessions")
      .select("status, status_reason, meta_social_token_encrypted, meta_social_token_expires_at, metadata")
      .eq("organization_id", input.organizationId)
      .eq("provider", CHANNEL_PROVIDER_META_SOCIAL)
      .eq("meta_social_account_id", input.sessionRef)
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();
    if (!data) return { reachable: true, status: "FAILED", detail: "conexao_ausente" };
    const l = data as {
      status_reason: string | null;
      meta_social_token_encrypted: string | null;
      meta_social_token_expires_at: string | null;
      metadata: Record<string, unknown> | null;
    };
    if (!l.meta_social_token_encrypted)
      return { reachable: true, status: "FAILED", detail: "credencial_indisponivel" };
    if (l.meta_social_token_expires_at && Date.parse(l.meta_social_token_expires_at) <= Date.now())
      return { reachable: true, status: "FAILED", detail: "token_vencido" };
    if (l.metadata?.token_erro)
      return { reachable: true, status: "FAILED", detail: "renovacao_do_token_falhou" };
    if (l.status_reason === "assinatura_do_webhook_falhou")
      return { reachable: true, status: "FAILED", detail: "recebimento_nao_configurado" };
    return { reachable: true, status: "WORKING", detail: null };
  },
};
