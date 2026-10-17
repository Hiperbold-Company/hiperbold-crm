/**
 * Botão "Ajuda": de qual tela do CRM para qual artigo da central de ajuda.
 *
 * Funções puras, sem leitura de ambiente. O ENDEREÇO da central é da
 * instalação (`HELP_CENTER_URL`, opcional), nunca do código: o produto é
 * white-label e cada revendedor pode apontar para a central dele. Sem a
 * variável, `urlDaAjuda` devolve `null` e o botão não aparece.
 *
 * Os caminhos abaixo seguem a estrutura da central: `/crm/<grupo>/<artigo>/`.
 */

/** Página do produto na central, usada quando a tela não tem artigo próprio. */
export const CAMINHO_PADRAO_DA_AJUDA = "/crm/";

/**
 * Prefixo de rota do CRM para o caminho do artigo. O prefixo MAIS LONGO vence,
 * e só casa em fronteira de segmento (`/app/team` casa `/app/team/invite`, mas
 * não `/app/teams`). A ordem aqui não importa.
 */
export const ARTIGOS_POR_ROTA: Readonly<Record<string, string>> = {
  // Primeiros passos
  "/app/inicio": "/crm/primeiros-passos/tela-inicio/",
  "/app/crm": "/crm/primeiros-passos/conhecer-o-menu/",

  // WhatsApp e conversas
  "/app/inbox": "/crm/whatsapp/conectar-pelo-qr-code/",
  "/app/connections": "/crm/whatsapp/conectar-pelo-qr-code/",
  "/app/settings/canal-oficial": "/crm/whatsapp/conectar-numero-oficial-da-meta/",

  // Funis, leads e contatos
  "/app/kanban": "/crm/funis-e-leads/funis-e-etapas/",
  "/app/pipelines": "/crm/funis-e-leads/funis-e-etapas/",
  "/app/leads": "/crm/funis-e-leads/funis-e-etapas/",
  "/app/settings/tenant/pipelines": "/crm/funis-e-leads/funis-e-etapas/",
  "/app/contacts": "/crm/funis-e-leads/contatos/",
  "/app/settings/tags": "/crm/funis-e-leads/tags/",

  // Agentes de IA
  "/app/ai": "/crm/agente-de-ia/criar-e-publicar-o-agente/",
  "/app/ai/jev": "/crm/agente-de-ia/decisoes-rapidas-jev/",
  "/app/ai/credentials": "/crm/agente-de-ia/modelos-do-plano-e-chave-propria/",
  "/app/ai/providers": "/crm/agente-de-ia/modelos-do-plano-e-chave-propria/",
  "/app/ai/usage": "/crm/agente-de-ia/modelos-do-plano-e-chave-propria/",

  // Agenda
  "/app/agenda": "/crm/agenda/google-agenda/",
  "/app/settings/tenant/agenda": "/crm/agenda/google-agenda/",

  // Equipe
  "/app/team": "/crm/equipe/convidar-pessoas/",

  // Plano e assinatura
  "/app/settings/plano": "/crm/assinatura/meu-plano/",
  "/app/settings/billing": "/crm/assinatura/meu-plano/",

  // Receber leads (fontes de captação)
  "/app/webhooks": "/crm/receber-leads/fontes-de-captacao/",

  // Integrações e API
  "/app/settings/api-tokens": "/crm/integracoes-e-api/tokens-de-api/",

  // Privacidade
  "/app/lgpd": "/crm/privacidade/lgpd/",
};

/** Tira query, âncora e barra final. `/app/team/?a=1#x` vira `/app/team`. */
function normalizarRota(rota: string): string {
  const semQuery = rota.split(/[?#]/, 1)[0] ?? "";
  const semBarra = semQuery.replace(/\/+$/, "");
  return semBarra === "" ? "/" : semBarra;
}

/**
 * Caminho do artigo (começa e termina com `/`) para a rota atual do CRM.
 * Prefixo mais longo vence; sem correspondência, a página do produto.
 */
export function caminhoDoArtigo(rota: string | null | undefined): string {
  if (!rota) return CAMINHO_PADRAO_DA_AJUDA;
  const alvo = normalizarRota(rota);
  let melhor: string | null = null;
  for (const prefixo of Object.keys(ARTIGOS_POR_ROTA)) {
    const casa = alvo === prefixo || alvo.startsWith(`${prefixo}/`);
    if (casa && (melhor === null || prefixo.length > melhor.length)) melhor = prefixo;
  }
  return melhor === null ? CAMINHO_PADRAO_DA_AJUDA : ARTIGOS_POR_ROTA[melhor]!;
}

/**
 * Normaliza o valor cru de `HELP_CENTER_URL`: só `http(s)`, sem barra final.
 * Vazio ou inválido vira `null` (o botão some em vez de apontar para lugar
 * nenhum). Nunca lança.
 */
export function baseDaCentralDeAjuda(bruto: string | null | undefined): string | null {
  const valor = bruto?.trim();
  if (!valor) return null;
  try {
    const url = new URL(valor);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** URL final do botão, ou `null` quando a instalação não configurou a central. */
export function urlDaAjuda(
  base: string | null | undefined,
  rota: string | null | undefined,
): string | null {
  const baseLimpa = baseDaCentralDeAjuda(base);
  if (!baseLimpa) return null;
  return `${baseLimpa}${caminhoDoArtigo(rota)}`;
}
