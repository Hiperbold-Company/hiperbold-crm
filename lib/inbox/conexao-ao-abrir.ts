/**
 * Por qual conexão "abrir conversa" sai, e por qual conexão o atendente pode
 * enviar — a regra pura, sem banco nem tela.
 *
 * ─── O defeito (cliente real, 16/11/2026) ───────────────────────────────────
 *
 * O card do funil levava direto à conversa mais recente do contato. Quando ela
 * estava na conexão de OUTRA atendente, quem clicou respondia pelo número da
 * colega, e o lead via a mensagem chegar do número errado.
 *
 * ─── A regra (decisão do dono do produto) ───────────────────────────────────
 *
 * "Minha conexão" é a conexão de mensagem em que a pessoa é responsável
 * (`channel_routing_responsibles`, gravado em Configurações › Atendimento,
 * bloco por número). Conexão sem responsável é o "número geral".
 *
 * Modo `choose` (o padrão), ou quem decide é gerente/administrador:
 *   1. sem conexão vinculada → como antes (`como_hoje`);
 *   2. o contato já tem conversa numa conexão minha → abre essa;
 *   3. não tem conversa que eu enxergue → inicia pela minha;
 *   4. só tem em outra(s) → janela: "Iniciar pela <minha>" (padrão) ou
 *      "Continuar na <existente>".
 *
 * Modo `own_only`, papel atendente ("o atendente só usa a conexão própria
 * dele. Ponto."):
 *   - a conexão usável é a minha; sem ela, só o número geral;
 *   - conversa já na minha (ou, sem a minha, no número geral) → abre essa;
 *   - contato na conexão de OUTRO atendente, sem transferência para mim → recusa;
 *   - senão inicia pela usável; sem nenhuma, abre a conversa aberta atribuída a
 *     mim, se houver; senão recusa.
 *   - ENVIO: só por conexão minha, por número geral, ou em conversa aberta
 *     atribuída a mim (`envioPermitidoPelaConexao`).
 *
 * O servidor aplica as MESMAS funções (`lib/inbox/guarda-da-conexao-ao-abrir.ts`):
 * a tela decide o gesto, o servidor não confia na tela.
 */
import type { ModoDeConexaoAoAbrir } from "@/lib/schemas/routing";

export interface ConexaoResumo {
  id: string;
  /** `channel_sessions.display_name` — o nome que o cliente dá em Conexões. */
  nome: string;
  /** `WORKING`, não pausada. Falso = a mensagem não sai agora. */
  conectada: boolean;
}

export interface ConversaDoContatoNaConexao {
  conversation_id: string;
  channel_session_id: string;
  conexao_nome: string;
  /** A conexão tem responsáveis e eu não sou um deles. */
  conexao_de_outro: boolean;
  /** Conversa aberta (não encerrada) atribuída a mim. */
  aberta_e_minha: boolean;
}

export interface OpcoesDeAbertura {
  modo: ModoDeConexaoAoAbrir;
  /** `own_only` E papel abaixo de gerente. */
  restrito: boolean;
  /** A conexão pela qual eu inicio. `null` = não tenho conexão vinculada. */
  minha_conexao: ConexaoResumo | null;
  /** Todas as conexões (não arquivadas) em que sou responsável. */
  minhas_conexoes_ids: string[];
  /** O número geral (conexão sem responsável), preferindo a conectada. */
  conexao_geral: ConexaoResumo | null;
  /** Conexões da organização que têm responsável (para a regra do envio). */
  conexoes_com_responsavel_ids: string[];
  /**
   * As conversas 1:1 do contato que EU enxergo, uma por conexão. Para quem
   * está abaixo de gerente, o mesmo recorte do modo de visibilidade.
   */
  conversas: ConversaDoContatoNaConexao[];
  /**
   * O contato tem conversa (enxergada por mim ou não) na conexão de outro
   * atendente. Sem id nem nome: quem não enxerga a conversa não fica sabendo
   * de qual conexão ela é.
   */
  contato_em_conexao_de_outro: boolean;
  /** Conversa aberta do contato atribuída a mim, ou negócio passado a mim por outra pessoa. */
  transferido_para_mim: boolean;
  /**
   * O seletor de conexão do painel do negócio: as conexões 1:1 da organização pelas quais eu
   * POSSO iniciar (no modo restrito, só as que `conexaoPermitidaNoModoRestrito` aceita), na
   * ordem estável de criação. Ausente (resposta antiga) = sem seletor.
   */
  conexoes_do_seletor?: ConexaoResumo[];
  /**
   * As conexões do seletor em que estou entre os responsáveis do canal
   * (`channel_routing_responsibles`, Configurações › Atendimento), na mesma ordem. Canal sem
   * responsáveis próprios não entra. Marcam o padrão do seletor.
   */
  vinculadas_a_mim_ids?: string[];
}

export type MotivoDaRecusa = "conexao_alheia" | "contato_de_outro" | "sem_conexao";

export type DecisaoDeAbertura =
  | { tipo: "como_hoje" }
  | { tipo: "abrir"; conversationId: string }
  | { tipo: "iniciar"; conexao: ConexaoResumo }
  | { tipo: "escolher"; padrao: ConexaoResumo; existentes: ConversaDoContatoNaConexao[] }
  | { tipo: "recusar"; motivo: MotivoDaRecusa };

export function decidirAbertura(op: OpcoesDeAbertura): DecisaoDeAbertura {
  const minha = op.minha_conexao;
  const minhas = new Set([...(minha ? [minha.id] : []), ...op.minhas_conexoes_ids]);
  const naMinha =
    (minha && op.conversas.find((c) => c.channel_session_id === minha.id)) ??
    op.conversas.find((c) => minhas.has(c.channel_session_id));

  if (!op.restrito) {
    if (!minha) return { tipo: "como_hoje" };
    if (naMinha) return { tipo: "abrir", conversationId: naMinha.conversation_id };
    if (op.conversas.length === 0) return { tipo: "iniciar", conexao: minha };
    return { tipo: "escolher", padrao: minha, existentes: op.conversas };
  }

  if (minha) {
    if (naMinha) return { tipo: "abrir", conversationId: naMinha.conversation_id };
  } else {
    const noGeral = op.conversas.find((c) => !c.conexao_de_outro);
    if (noGeral) return { tipo: "abrir", conversationId: noGeral.conversation_id };
  }
  if (op.contato_em_conexao_de_outro && !op.transferido_para_mim) {
    return { tipo: "recusar", motivo: "contato_de_outro" };
  }
  const usavel = minha ?? op.conexao_geral;
  if (usavel) return { tipo: "iniciar", conexao: usavel };
  const abertaMinha = op.conversas.find((c) => c.aberta_e_minha);
  if (abertaMinha) return { tipo: "abrir", conversationId: abertaMinha.conversation_id };
  return { tipo: "recusar", motivo: "sem_conexao" };
}

/**
 * A conexão que o seletor do painel do negócio já traz marcada: entre as conexões do seletor em
 * que estou entre os responsáveis do canal (Configurações › Atendimento), a primeira CONECTADA (na ordem de criação); se nenhuma estiver
 * conectada, a primeira delas. Sem nenhuma vinculada a mim, `null` — o seletor fica em
 * "Automático" e a abertura segue a regra de sempre (`decidirAbertura`).
 */
export function conexaoPadraoDoSeletor(op: Pick<OpcoesDeAbertura, "conexoes_do_seletor" | "vinculadas_a_mim_ids">): ConexaoResumo | null {
  const minhas = new Set(op.vinculadas_a_mim_ids ?? []);
  const candidatas = (op.conexoes_do_seletor ?? []).filter((c) => minhas.has(c.id));
  return candidatas.find((c) => c.conectada) ?? candidatas[0] ?? null;
}

/** A sessão pedida pode ser usada para INICIAR no modo restrito? */
export function conexaoPermitidaNoModoRestrito(op: OpcoesDeAbertura, channelSessionId: string): boolean {
  if (!op.restrito) return true;
  if (op.minhas_conexoes_ids.includes(channelSessionId)) return true;
  // Sem conexão própria, só o número geral. Com ela, só a própria.
  return !op.minha_conexao && !op.conexoes_com_responsavel_ids.includes(channelSessionId);
}

/** Código do 403 do envio recusado pela regra "só a conexão própria". */
export const CODIGO_CONEXAO_PROPRIA_OBRIGATORIA = "conexao_propria_obrigatoria" as const;
export const MENSAGEM_CONEXAO_PROPRIA_OBRIGATORIA =
  "Nesta empresa, você só responde pela sua conexão. Esta conversa está na conexão de outro atendente: peça para transferi-la a você.";

const ENCERRADAS = new Set(["closed", "archived", "resolved"]);

export function conversaAberta(status: string | null | undefined): boolean {
  return !!status && !ENCERRADAS.has(status);
}

/**
 * O ENVIO no modo restrito: pela conexão minha, pelo número geral, ou numa
 * conversa aberta atribuída a mim (a transferência). Fora do modo, sempre.
 */
export function envioPermitidoPelaConexao(p: {
  restrito: boolean;
  sessaoEhMinha: boolean;
  sessaoTemResponsaveis: boolean;
  conversaAbertaEMinha: boolean;
}): boolean {
  if (!p.restrito) return true;
  return p.sessaoEhMinha || !p.sessaoTemResponsaveis || p.conversaAbertaEMinha;
}

/**
 * O aviso acima da caixa de texto do Chat: só quando tenho conexão vinculada e
 * a conversa aberta não está numa delas. Quem não tem número vinculado responde
 * pela conexão da conversa como sempre, e o aviso em todas as conversas seria
 * ruído.
 */
export function avisoDeConexaoAlheia(
  minhasConexoesIds: readonly string[] | undefined,
  conversaChannelSessionId: string | null | undefined,
): boolean {
  if (!minhasConexoesIds || minhasConexoesIds.length === 0) return false;
  if (!conversaChannelSessionId) return false;
  return !minhasConexoesIds.includes(conversaChannelSessionId);
}

/** O nome mostrado: o da conexão; sem nome, o número; sem nenhum, um rótulo neutro. */
export function nomeDaConexao(s: { display_name?: string | null; phone_number?: string | null }): string {
  return s.display_name?.trim() || s.phone_number?.trim() || "Conexão sem nome";
}
