import { chaveDaResposta, NAMESPACE_DA_RESPOSTA } from "@/lib/automacoes/conversa";

import type { RespostaDisponivel } from "./comum";

/** O nome da variável que a resposta do bloco `nodeId` vira: `{{resposta.<chave>}}`. */
export function variavelDaResposta(nodeId: string): string {
  return `{{${NAMESPACE_DA_RESPOSTA}.${chaveDaResposta(nodeId)}}}`;
}

interface NoMinimo {
  id: string;
  type?: string;
  data: { label: string; config: unknown };
}

/** O bloco deixa resposta nas variáveis? Pergunta (menos CPF, que só vai ao campo); mensagem só com opções. */
function deixaResposta(no: NoMinimo): boolean {
  if (no.type === "question")
    return (no.data.config as { validation?: string } | null)?.validation !== "cpf";
  if (no.type === "message")
    return Boolean((no.data.config as { options?: unknown } | null)?.options);
  return false;
}

/**
 * As respostas que chegam ao bloco `nodeId`: as dos blocos de pergunta e de
 * mensagem com opções que vêm ANTES dele por alguma aresta (o próprio bloco
 * fica fora — a resposta dele só existe depois que ele sai). Ordem: do mais
 * próximo para o mais distante.
 */
export function respostasAntesDe(
  nodeId: string,
  nodes: readonly NoMinimo[],
  edges: ReadonlyArray<{ source: string; target: string }>,
): RespostaDisponivel[] {
  const porId = new Map(nodes.map((n) => [n.id, n]));
  const vistos = new Set<string>([nodeId]);
  const fila = [nodeId];
  const saida: RespostaDisponivel[] = [];
  while (fila.length > 0) {
    const atual = fila.shift()!;
    for (const e of edges) {
      if (e.target !== atual || vistos.has(e.source)) continue;
      vistos.add(e.source);
      fila.push(e.source);
      const no = porId.get(e.source);
      if (no && deixaResposta(no))
        saida.push({ variavel: variavelDaResposta(no.id), origem: no.data.label });
    }
  }
  return saida;
}
