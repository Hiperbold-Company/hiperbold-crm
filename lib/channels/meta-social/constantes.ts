/**
 * Vocabulário do canal social OFICIAL da Meta (Instagram Direct pela Instagram
 * API com login unificado; Messenger pela Página do Facebook). Puro, sem banco
 * nem rede.
 *
 * Os dois falam com `graph.facebook.com` e entram pelo diálogo de
 * `www.facebook.com`. O Instagram pelo login unificado não usa
 * `graph.instagram.com` (a doc diz que o token dele não funciona lá):
 * https://developers.facebook.com/documentation/instagram-platform/webhooks/setup
 *
 * A versão da Graph API é constante PRÓPRIA deste canal, e não a de
 * `lib/graph-version.ts`: o WhatsApp oficial segue na versão dele, e um bump
 * aqui não pode mexer no envio de template de ninguém.
 */
import { VERSAO_DA_GRAPH_DO_CANAL_SOCIAL } from "@/lib/graph-version";

export const VERSAO_DA_GRAPH_SOCIAL = VERSAO_DA_GRAPH_DO_CANAL_SOCIAL;

export const HOST_GRAPH_FACEBOOK = "https://graph.facebook.com";
export const HOST_AUTORIZACAO_FACEBOOK = "https://www.facebook.com";

export const PLATAFORMAS_META_SOCIAL = ["instagram", "messenger"] as const;
export type PlataformaMetaSocial = (typeof PLATAFORMAS_META_SOCIAL)[number];

export function ehPlataformaMetaSocial(v: unknown): v is PlataformaMetaSocial {
  return typeof v === "string" && (PLATAFORMAS_META_SOCIAL as readonly string[]).includes(v);
}

/**
 * Plataforma → `conversations.channel` (e `metadata.social_platform` da sessão).
 * O CHECK da conversa fala `facebook`, o mesmo que o canal intermediado grava;
 * o produto chama de Messenger. A tradução mora num lugar só.
 */
export function canalDaConversa(plataforma: PlataformaMetaSocial): "instagram" | "facebook" {
  return plataforma === "instagram" ? "instagram" : "facebook";
}

/**
 * O Instagram (login unificado) NÃO manda `scope` na URL: as permissões
 * (`instagram_basic`, `instagram_manage_messages`) são as da CONFIGURAÇÃO do
 * painel, identificada pelo `config_id`. Listadas aqui só como documentação do
 * que a configuração precisa ter.
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/permissions
 */
export const PERMISSOES_DA_CONFIGURACAO_INSTAGRAM = ["instagram_basic", "instagram_manage_messages"] as const;

export const ESCOPOS_MESSENGER = [
  "pages_show_list",
  "pages_manage_metadata",
  "pages_messaging",
  "pages_read_engagement",
] as const;

/**
 * Os campos assinados por conta. Só o que o parser lê: campo assinado e
 * ignorado é tráfego e reentrega sem uso. `messaging_seen` (Instagram) e
 * `message_reads` (Messenger) carimbam a leitura da mensagem de saída;
 * `message_echoes` é o eco do que a Página enviou (o Instagram manda o eco em
 * `messages`, com `is_echo`). Reação fica de fora: o parser não a lê.
 */
export const CAMPOS_DO_WEBHOOK_INSTAGRAM = "messages,messaging_postbacks,messaging_seen";
export const CAMPOS_DO_WEBHOOK_MESSENGER =
  "messages,messaging_postbacks,message_echoes,message_reads";

/** Teto do texto por mensagem, em BYTES UTF-8 (Instagram: 1000; Messenger: 2000 caracteres). */
export function tetoDoTexto(plataforma: PlataformaMetaSocial): number {
  return plataforma === "instagram" ? 1000 : 2000;
}

/** Onde o callback do OAuth volta. O cookie de vínculo vale para o prefixo. */
export const CAMINHO_DO_CALLBACK_META_SOCIAL = "/api/v1/channels/meta-social/callback";

export function caminhoDoCallback(plataforma: PlataformaMetaSocial): string {
  return `${CAMINHO_DO_CALLBACK_META_SOCIAL}/${plataforma}`;
}

/** Tela de destino de todo desfecho do OAuth (é do outro lado: `app/app/connections`). */
export const CAMINHO_DA_TELA_DE_CONEXOES = "/app/connections";
