/**
 * "Substituir em todos os blocos" (campo "Conexão" de Mensagem e Pergunta,
 * régua DataCrazy): troca a conexão de todos os blocos que usam a ATUAL pela
 * NOVA, no rascunho do editor. Pura: recebe os nós do canvas, devolve outros.
 *
 * - Mensagem e Pergunta com `channel_session_id` igual à atual (a atual vazia
 *   = "conexão dos blocos anteriores" troca os blocos em branco) passam à nova.
 * - A atual escolhida que aparece em `channel_session_ids` de um gatilho
 *   "Mensagem recebida" do mesmo grafo também é trocada lá (sem repetir id).
 *   A atual vazia não mexe em gatilho: lá vazio quer dizer "qualquer número".
 *
 * `null` = vazio. Nó que não muda volta o MESMO objeto (o canvas não redesenha).
 */

/** O mínimo de um nó do canvas que a troca lê. */
export interface NoDoCanvas {
  type?: string;
  data: { config?: unknown };
}

type Config = Record<string, unknown>;

function ehBlocoDeConversa(n: NoDoCanvas): boolean {
  return n.type === "message" || n.type === "question";
}

function conexaoDoBloco(config: unknown): string | null {
  const v = (config as Config | undefined)?.channel_session_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function configComConexao(config: Config, nova: string | null): Config {
  const { channel_session_id: _antes, ...resto } = config;
  return nova ? { ...resto, channel_session_id: nova } : resto;
}

/** Os gatilhos do Início com a conexão trocada; `null` = nenhum mudou. */
function gatilhosTrocados(config: unknown, atual: string, nova: string | null): Config | null {
  const c = config as Config | undefined;
  const gatilhos = c?.triggers;
  if (!Array.isArray(gatilhos)) return null;
  let mudou = false;
  const novos = gatilhos.map((g: unknown) => {
    const gatilho = g as Config;
    const ids = gatilho?.channel_session_ids;
    if (gatilho?.kind !== "message_received" || !Array.isArray(ids) || !ids.includes(atual))
      return g;
    mudou = true;
    const trocados = [
      ...new Set(ids.flatMap((id) => (id === atual ? (nova ? [nova] : []) : [id]))),
    ];
    const { channel_session_ids: _antes, ...resto } = gatilho;
    return trocados.length > 0 ? { ...resto, channel_session_ids: trocados } : resto;
  });
  return mudou ? { ...c, triggers: novos } : null;
}

/** Quantos blocos (Mensagem, Pergunta e o Início com o gatilho) a troca da `atual` alcança. */
export function blocosDaConexao(nodes: readonly NoDoCanvas[], atual: string | null): number {
  return nodes.filter((n) => {
    if (ehBlocoDeConversa(n)) return conexaoDoBloco(n.data.config) === atual;
    return (
      n.type === "trigger" &&
      atual !== null &&
      gatilhosTrocados(n.data.config, atual, null) !== null
    );
  }).length;
}

export function substituirConexao<T extends NoDoCanvas>(
  nodes: readonly T[],
  atual: string | null,
  nova: string | null,
): T[] {
  if (atual === nova) return [...nodes];
  return nodes.map((n) => {
    if (ehBlocoDeConversa(n)) {
      if (conexaoDoBloco(n.data.config) !== atual) return n;
      return {
        ...n,
        data: { ...n.data, config: configComConexao((n.data.config ?? {}) as Config, nova) },
      };
    }
    if (n.type === "trigger" && atual !== null) {
      const config = gatilhosTrocados(n.data.config, atual, nova);
      return config ? { ...n, data: { ...n.data, config } } : n;
    }
    return n;
  });
}
