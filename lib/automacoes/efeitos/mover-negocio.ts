/**
 * Qual negócio o bloco "Mover negócio" (`move_deal`) leva para a etapa escolhida,
 * e se é troca de etapa no mesmo funil ou troca de FUNIL (migration 1013).
 *
 * A ordem, decidida em 14/11/2026:
 *  1. A execução carrega um negócio (`vars._lead_id`, que o gatilho trouxe ou um
 *     bloco criou/moveu): é ELE que se move, no mesmo funil ou para outro. Mesmo
 *     que o contato já tenha um negócio aberto no funil de destino: a automação
 *     fala do negócio dela, e mover o outro no lugar seria agir sobre um negócio
 *     que ninguém escolheu.
 *  2. Sem negócio na execução: o aberto do contato que JÁ está no funil de destino
 *     só troca de etapa (o comportamento de antes, que não cria duplicata no destino).
 *  3. Sem ele: o aberto mais recente do contato (o `fatos.negocio`) troca de funil.
 *  4. Nenhum: `null` (o bloco cai no ramo de erro com `sem_negocio`).
 */
import { negocioDaExecucao, type FatosDaAutomacao } from "../fatos";

export interface NegocioParaMover {
  id: string;
  entreFunis: boolean;
}

export function escolherNegocioParaMover(
  c: { fatos: FatosDaAutomacao | null; vars?: Record<string, unknown> },
  funilDeDestino: string,
): NegocioParaMover | null {
  const fatos = c.fatos;
  if (!fatos) return null;
  const idDaExecucao = negocioDaExecucao(fatos.vars ?? c.vars ?? {});
  const daExecucao =
    idDaExecucao && fatos.negocio?.id === idDaExecucao
      ? fatos.negocio
      : idDaExecucao
        ? fatos.negocios.find((n) => n.id === idDaExecucao) ?? null
        : null;
  if (daExecucao) return { id: daExecucao.id, entreFunis: daExecucao.pipeline_id !== funilDeDestino };

  const noDestino = fatos.negocios.find((n) => n.pipeline_id === funilDeDestino && n.status === "open");
  if (noDestino) return { id: noDestino.id, entreFunis: false };

  const recente = fatos.negocio;
  if (recente) return { id: recente.id, entreFunis: recente.pipeline_id !== funilDeDestino };
  return null;
}
