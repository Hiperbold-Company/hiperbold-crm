/**
 * Funções ocultas da instalação da Hiperbold. ÚNICO lugar que decide o que o cliente não vê.
 *
 * Decisão do Filipe, 16/10/2026: o que ainda não foi validado para o cliente sai da tela, sem
 * apagar código nem dado. A explicação para leigo de cada item, onde ele morava e como religar
 * estão em `hiperbold/FUNCOES.md`.
 *
 * COMO FUNCIONA. Esconder é só estar em `FUNCOES_OCULTAS`. Todo o resto deriva daqui:
 *  - menu lateral, "Ver tudo em …", Configurações e ⌘K: `permitidos()` (lib/navigation/interface.ts)
 *    descarta o destino cujo caminho pertence a uma função oculta;
 *  - quem abre o endereço direto: `next.config.ts` redireciona para `/app/inicio`
 *    (`redirecionamentosDasFuncoesOcultas`), inclusive na navegação dentro do app;
 *  - blocos dentro de uma tela que continua visível (opções de Conexões, voz em Segurança, links
 *    para Credenciais): a tela pergunta `funcaoOculta(id)`.
 * O código das telas, as rotas de API e os dados no banco ficam como estão. Esconder é apresentação,
 * nunca autorização: as APIs continuam exigindo papel e organização como antes. O painel de
 * plataforma (`/admin`) não é afetado.
 *
 * COMO RELIGAR. Apague o id de `FUNCOES_OCULTAS` (e mova a linha de `hiperbold/FUNCOES.md` para
 * "Funções ativas"). Nada mais precisa mudar.
 */

/** Toda função que pode ser escondida, com os caminhos de tela que ela possui. Não esconde nada sozinho. */
export const FUNCOES = {
  prospeccao: { nome: "Prospecção", rotas: ["/app/prospecting"] },
  chamadas: { nome: "Chamadas", rotas: ["/app/calls"] },
  comandas: { nome: "Comandas", rotas: ["/app/comandas"] },
  "meta-ads": {
    nome: "Meta Ads (análise e configuração)",
    rotas: ["/app/ads/meta", "/app/settings/meta-ads"],
  },
  "trunk-sip": { nome: "Trunk SIP", rotas: ["/app/settings/voip-trunk"] },
  conversoes: { nome: "Conversões", rotas: ["/app/settings/conversoes"] },
  extensoes: { nome: "Extensões", rotas: ["/app/extensions"] },
  "contas-e-recebimentos": {
    nome: "Contas e recebimentos",
    rotas: ["/app/settings/tenant/financeiro"],
  },
  "provedores-ia": { nome: "Provedores de IA", rotas: ["/app/ai/providers"] },
  jev: { nome: "Jev — decisões rápidas (cartão em Decisões rápidas)", rotas: [] },
  // Sem tela própria: são blocos dentro de telas que seguem visíveis.
  "voz-whatsapp": { nome: "Chamada de voz pelo WhatsApp (Segurança e Conexões)", rotas: [] },
  "conexao-provedor-parceiro": { nome: "Conexão: Provedor parceiro", rotas: [] },
  "conexao-telefone": { nome: "Conexão: Telefone", rotas: [] },
  "conexao-redes-sociais": { nome: "Conexão: Redes sociais", rotas: [] },
} as const satisfies Record<string, { nome: string; rotas: readonly string[] }>;

export type FuncaoId = keyof typeof FUNCOES;

/**
 * OCULTAS em 16/10/2026 — "decisão do Filipe: validar antes de lançar".
 * Para religar uma, apague a linha dela.
 */
export const FUNCOES_OCULTAS: readonly FuncaoId[] = [
  "prospeccao", // 16/10/2026 · CRM › Prospecção
  "chamadas", // 16/10/2026 · CRM › Chamadas (histórico de ligações)
  "comandas", // 16/10/2026 · CRM › Comandas e Configurações › Comandas
  "meta-ads", // 16/10/2026 · Análise › Meta Ads e Configurações › Meta Ads
  "trunk-sip", // 16/10/2026 · Configurações › Trunk SIP
  "conversoes", // 16/10/2026 · Configurações › Conversões
  "extensoes", // 16/10/2026 · Configurações › Extensões e "Orientações instaladas" no hub do CRM
  "contas-e-recebimentos", // 16/10/2026 · Configurações › Contas e recebimentos
  "provedores-ia", // 16/10/2026 · IA › Provedores
  "voz-whatsapp", // 16/10/2026 · Configurações › Segurança › bloco "Chamada de voz pelo WhatsApp"
  "conexao-provedor-parceiro", // 16/10/2026 · Conexões › Provedor parceiro
  "conexao-telefone", // 16/10/2026 · Conexões › Telefone
  "conexao-redes-sociais", // 16/10/2026 · Conexões › Redes sociais
];

export function funcaoOculta(id: FuncaoId): boolean {
  return FUNCOES_OCULTAS.includes(id);
}

/** Caminhos de tela das funções ocultas. */
export function rotasOcultas(): string[] {
  return FUNCOES_OCULTAS.flatMap((id) => [...FUNCOES[id].rotas]);
}

/**
 * O endereço (ou destino do menu) pertence a uma função oculta? Ignora `?consulta` e `#âncora`,
 * e vale para o caminho exato e para tudo abaixo dele (`/app/extensions/abc`), nunca para um
 * irmão de nome parecido (`/app/ai/providers-x`).
 */
export function hrefOculto(href: string): boolean {
  const caminho = (href.split(/[?#]/, 1)[0] ?? "").replace(/\/+$/, "") || "/";
  return rotasOcultas().some((r) => caminho === r || caminho.startsWith(`${r}/`));
}

/** Para onde vai quem abre uma tela oculta pelo endereço. */
export const DESTINO_DAS_FUNCOES_OCULTAS = "/app/inicio";

/** Entradas de `redirects()` do `next.config.ts`; `:path*` casa o caminho e tudo abaixo dele. */
export function redirecionamentosDasFuncoesOcultas(): Array<{
  source: string;
  destination: string;
  permanent: false;
}> {
  return rotasOcultas().map((r) => ({
    source: `${r}/:path*`,
    destination: DESTINO_DAS_FUNCOES_OCULTAS,
    permanent: false as const,
  }));
}
