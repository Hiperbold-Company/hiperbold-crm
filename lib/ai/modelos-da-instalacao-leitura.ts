/**
 * Lê `MODELOS_DA_INSTALACAO` pelo resolvedor da instalação (tela primeiro, depois
 * `.env`) e aplica o freio de custo a um modelo. É o caminho do app e dos workers
 * antigos (que já falam com o Supabase por HTTP). O motor do agente NÃO usa este
 * arquivo: ele lê pelo `pg.Pool` (`@/lib/agent-engine/edge/llm/modelos-da-instalacao`),
 * porque o caminho do turno não pode fazer `fetch`.
 *
 * Nunca lança: `valorDaInstalacao` degrada para o `.env`, e sem nada a lista é o padrão.
 */
import { logger } from "@/lib/logger";
import { valorDaInstalacao } from "@/lib/instalacao/config";

import {
  CHAVE_MODELOS_DA_INSTALACAO,
  decidirModeloDaChave,
  lerModelosDaInstalacao,
  primeiraVezDoModelo,
  type DecisaoDeModelo,
} from "./modelos-da-instalacao";

/** A lista em vigor agora (sem memo: a tela vale na próxima chamada, como o resto da configuração). */
export async function modelosDaInstalacao(): Promise<string[]> {
  try {
    const { valor } = await valorDaInstalacao("MODELOS_DA_INSTALACAO");
    return lerModelosDaInstalacao(valor);
  } catch {
    return lerModelosDaInstalacao(null);
  }
}

/**
 * O freio para quem resolve o modelo FORA do motor (workers de resposta, clima,
 * mídia). Só consulta a configuração quando a chave é da instalação — BYOK passa
 * direto, sem ir ao banco.
 */
export async function modeloPermitidoNaChave(d: {
  organizationId: string;
  origemDaChave: "chave_da_instalacao" | "credencial_da_organizacao";
  provedor: string;
  modelId: string;
  /** Rótulo do ponto, só para o log. */
  ponto?: string;
}): Promise<DecisaoDeModelo> {
  if (d.origemDaChave !== "chave_da_instalacao") {
    return { modelId: d.modelId, trocado: false, pedido: d.modelId };
  }
  const lista = await modelosDaInstalacao();
  const decisao = decidirModeloDaChave({
    lista,
    origemDaChave: d.origemDaChave,
    provedor: d.provedor,
    modelId: d.modelId,
  });
  if ((decisao.trocado || "semTraducao" in decisao) && primeiraVezDoModelo(d.organizationId, d.modelId)) {
    logger.warn(
      decisao.trocado
        ? `[${CHAVE_MODELOS_DA_INSTALACAO}] modelo fora da lista da chave da instalação — usando o padrão`
        : `[${CHAVE_MODELOS_DA_INSTALACAO}] modelo fora da lista e o provedor não executa o padrão — mantido`,
      {
        organization_id: d.organizationId,
        ponto: d.ponto,
        pedido: d.modelId,
        usado: decisao.modelId,
      },
    );
  }
  return decisao;
}
