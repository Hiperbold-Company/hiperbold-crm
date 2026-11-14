/**
 * Conversa com a Meta do Cadastro Incorporado do WhatsApp (migration 1014): trocar
 * o código do `FB.login` pelo token de integração do cliente e descobrir a qual
 * WABA esse token dá acesso.
 * https://developers.facebook.com/docs/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
 *
 * Regras (as mesmas de `lib/channels/meta-social/oauth.ts`, cujo `chamarMeta` é
 * reaproveitado):
 *  - `client_secret` NUNCA em query string: a troca vai por POST com corpo
 *    `application/x-www-form-urlencoded`. SEM `redirect_uri`: o código do
 *    `FB.login` pelo JS SDK não tem redirecionamento, e a doc da troca não o pede.
 *  - O token do app (`id|secret`) do `debug_token` vai no header Authorization.
 *  - Token, segredo e corpo cru da Meta nunca vão para log nem para a resposta:
 *    `motivoDaFalhaDaMeta` devolve só um texto fixo em português.
 */
import { chamarMeta, ErroDaMeta } from "@/lib/channels/meta-social/oauth";
import { HOST_GRAPH_FACEBOOK, VERSAO_DA_GRAPH_SOCIAL } from "@/lib/channels/meta-social/constantes";

const GRAPH = `${HOST_GRAPH_FACEBOOK}/${VERSAO_DA_GRAPH_SOCIAL}`;

export interface AppDoCadastroIncorporado {
  appId: string;
  appSecret: string;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null;

/** Código do `FB.login` → token de integração do cliente (vale 30 segundos, uso único). */
export async function trocarCodigo(
  app: AppDoCadastroIncorporado,
  code: string,
  fetcher?: typeof fetch,
): Promise<string> {
  const r = await chamarMeta(
    "whatsapp_troca_de_codigo",
    `${GRAPH}/oauth/access_token`,
    { form: { client_id: app.appId, client_secret: app.appSecret, code } },
    fetcher,
  );
  const token = str(r.access_token);
  if (!token) throw new ErroDaMeta("whatsapp_troca_de_codigo", 200, null, "sem access_token");
  return token;
}

/**
 * As WABAs que o token alcança: os `target_ids` do escopo
 * `whatsapp_business_management` no `granular_scopes` do `debug_token`.
 * https://developers.facebook.com/docs/graph-api/reference/debug_token
 */
export async function wabaDoToken(
  app: AppDoCadastroIncorporado,
  token: string,
  fetcher?: typeof fetch,
): Promise<string[]> {
  const u = new URL(`${GRAPH}/debug_token`);
  u.searchParams.set("input_token", token);
  const r = await chamarMeta(
    "whatsapp_debug_token",
    u.toString(),
    { token: `${app.appId}|${app.appSecret}` },
    fetcher,
  );
  const dados = (r.data && typeof r.data === "object" ? r.data : {}) as Record<string, unknown>;
  const granulares = Array.isArray(dados.granular_scopes) ? (dados.granular_scopes as Record<string, unknown>[]) : [];
  const ids = new Set<string>();
  for (const g of granulares) {
    if (g?.scope !== "whatsapp_business_management") continue;
    for (const alvo of Array.isArray(g.target_ids) ? (g.target_ids as unknown[]) : []) {
      const id = str(alvo);
      if (id && /^[0-9]{5,30}$/.test(id)) ids.add(id);
    }
  }
  return [...ids];
}

export type EscolhaDaWaba =
  | { ok: true; wabaId: string }
  | { ok: false; erro: "waba_indefinida" | "waba_nao_autorizada" };

/**
 * Regra pura da WABA que vale:
 *  - o navegador mandou e o token listou alvos: tem de estar entre eles;
 *  - o navegador mandou e o token não listou nada: vale a do navegador (a
 *    validação seguinte confere, com o próprio token, que o número é dela);
 *  - o navegador não mandou: só com exatamente UM alvo.
 */
export function escolherWaba(alvos: readonly string[], doNavegador: string | null | undefined): EscolhaDaWaba {
  if (doNavegador) {
    if (alvos.length > 0 && !alvos.includes(doNavegador)) return { ok: false, erro: "waba_nao_autorizada" };
    return { ok: true, wabaId: doNavegador };
  }
  if (alvos.length === 1) return { ok: true, wabaId: alvos[0]! };
  return { ok: false, erro: "waba_indefinida" };
}

export const MENSAGEM_CODIGO_VENCIDO =
  "O código da Meta venceu (vale 30 segundos). Clique em Conectar de novo.";

/** O motivo legível de uma falha da Meta. Nunca devolve o texto cru dela. */
export function motivoDaFalhaDaMeta(err: unknown): { codigo: string; mensagem: string } {
  if (!(err instanceof ErroDaMeta)) {
    return { codigo: "meta_indisponivel", mensagem: "Não foi possível falar com a Meta agora. Tente de novo." };
  }
  if (err.status === null) {
    return { codigo: "meta_indisponivel", mensagem: "A Meta não respondeu a tempo. Tente de novo." };
  }
  const detalhe = err.message.toLowerCase();
  if (
    err.etapa === "whatsapp_troca_de_codigo" &&
    (/expired|been used|already used|invalid verification code|authorization code/.test(detalhe) ||
      err.codigoDaMeta === 100)
  ) {
    return { codigo: "codigo_vencido", mensagem: MENSAGEM_CODIGO_VENCIDO };
  }
  if (err.codigoDaMeta === 101 || /client_secret|app secret|invalid client|error validating application/.test(detalhe)) {
    return {
      codigo: "app_invalido",
      mensagem: "A Meta recusou o app desta instalação (id ou chave do app). Peça a quem administra a instalação para conferir.",
    };
  }
  if (err.codigoDaMeta === 10 || err.codigoDaMeta === 200 || /permission/.test(detalhe)) {
    return {
      codigo: "sem_permissao",
      mensagem: "A Meta não deu permissão para gerenciar esta conta do WhatsApp. Conecte de novo e aceite todas as permissões.",
    };
  }
  if (err.codigoDaMeta === 190) {
    return { codigo: "token_invalido", mensagem: "A Meta recusou o acesso concedido. Clique em Conectar de novo." };
  }
  return { codigo: "meta_recusou", mensagem: "A Meta recusou a conexão. Clique em Conectar de novo." };
}
