/**
 * Os EFEITOS dos blocos do Instagram: "Responder em privado" (Direct),
 * "Responder no comentário" (público) e "Confere se segue".
 *
 * Tudo passa pelo PONTO DE TROCA `../canal-de-comentarios` — nada aqui fala com
 * o canal direto. O comentário é o do GATILHO (`vars.gatilho`, gravado quando a
 * execução nasceu de `instagram.comentario_recebido`); a organização é a da
 * EXECUÇÃO (veio do banco), nunca de payload.
 *
 * Uma resposta privada por comentário: o canal garante (`ja_pedida`), e a
 * automação não repete num replay — o motor roda o efeito no máximo uma vez
 * por nó+passo e relê o desfecho do evento (`resolverEfeito`, engine.ts).
 *
 * O desfecho escolhe a SAÍDA do bloco (`DesfechoDoEfeito.saida`); o detalhe do
 * evento guarda só o status (nunca o texto do comentário nem o da resposta).
 */
import type { ResultadoDoEfeito } from "@/lib/followup/engine";
import {
  JA_RESPONDIDO_BRANCH_ID,
  MAX_TEXTO_DA_RESPOSTA_AO_COMENTARIO,
  NAO_SEGUE_BRANCH_ID,
  PRAZO_VENCIDO_BRANCH_ID,
  SEGUE_BRANCH_ID,
  type FlowNode,
} from "@/lib/followup/graph-schema";

import * as canal from "../canal-de-comentarios";
import { renderizar } from "../template-vars";
import type { Contexto } from "./index";

export type NoDoInstagram = Extract<
  FlowNode,
  { type: "instagram_private_reply" | "instagram_public_reply" | "instagram_check_follow" }
>;

export function ehNoDoInstagram(node: FlowNode): node is NoDoInstagram {
  return (
    node.type === "instagram_private_reply" ||
    node.type === "instagram_public_reply" ||
    node.type === "instagram_check_follow"
  );
}

interface ComentarioDoGatilho {
  comment_id: string;
  channel_session_id: string | null;
  autor_id: string | null;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** O comentário que iniciou a execução, ou `null` quando ela não nasceu de um comentário. */
export function comentarioDoGatilho(
  vars: Record<string, unknown> | undefined,
): ComentarioDoGatilho | null {
  const g = vars?.gatilho as Record<string, unknown> | undefined;
  if (!g || g.tipo !== "instagram_comment") return null;
  const commentId = texto(g.comment_id);
  if (!commentId) return null;
  return {
    comment_id: commentId,
    channel_session_id: texto(g.channel_session_id),
    autor_id: texto(g.autor_id),
  };
}

/** O texto da resposta já com as variáveis; `null` quando ficou vazio ou passou do teto (em bytes, como o canal mede). */
function textoDaResposta(c: Contexto, modelo: string): string | null {
  const t = renderizar(modelo, c.fatos, c.agora).trim();
  if (!t) return null;
  if (new TextEncoder().encode(t).length > MAX_TEXTO_DA_RESPOSTA_AO_COMENTARIO) return null;
  return t;
}

function falha(tipo: NoDoInstagram["type"], erro: string): ResultadoDoEfeito {
  return { desfecho: { ok: false, erro }, detalhes: [{ tipo, ok: false, erro }] };
}

function feito(tipo: NoDoInstagram["type"], resultado: string, saida?: string): ResultadoDoEfeito {
  return {
    desfecho: { ok: true, ...(saida ? { saida } : {}) },
    detalhes: [{ tipo, ok: true, resultado }],
  };
}

/** O texto foi recusado pelo canal (vazio ou acima do teto em bytes): o canal LANÇA com este código. */
function textoRecusado(err: unknown): boolean {
  return err instanceof Error && err.message === canal.ERRO_TEXTO_INVALIDO;
}

export async function executarInstagram(
  c: Contexto,
  node: NoDoInstagram,
): Promise<ResultadoDoEfeito> {
  const comentario = comentarioDoGatilho(c.fatos?.vars);
  if (!comentario) return falha(node.type, "sem_comentario");
  const pedidoPor = c.handler.requestId.slice(0, 200);

  switch (node.type) {
    case "instagram_private_reply": {
      const t = textoDaResposta(c, node.config.text);
      if (!t) return falha(node.type, "texto_invalido");
      let status: canal.StatusDoPedido;
      try {
        ({ status } = await canal.pedirRespostaPrivada(c.admin, {
          organizationId: c.org,
          commentId: comentario.comment_id,
          texto: t,
          pedidoPor,
        }));
      } catch (err) {
        if (textoRecusado(err)) return falha(node.type, "texto_invalido");
        throw err;
      }
      if (status === "na_fila") return feito(node.type, status);
      if (status === "ja_pedida") return feito(node.type, status, JA_RESPONDIDO_BRANCH_ID);
      if (status === "expirada") return feito(node.type, status, PRAZO_VENCIDO_BRANCH_ID);
      return falha(node.type, "comentario_nao_encontrado");
    }
    case "instagram_public_reply": {
      const t = textoDaResposta(c, node.config.text);
      if (!t) return falha(node.type, "texto_invalido");
      let status: Exclude<canal.StatusDoPedido, "expirada">;
      try {
        ({ status } = await canal.responderNoComentario(c.admin, {
          organizationId: c.org,
          commentId: comentario.comment_id,
          texto: t,
          pedidoPor,
        }));
      } catch (err) {
        if (textoRecusado(err)) return falha(node.type, "texto_invalido");
        throw err;
      }
      if (status === "na_fila") return feito(node.type, status);
      if (status === "ja_pedida") return feito(node.type, status, JA_RESPONDIDO_BRANCH_ID);
      return falha(node.type, "comentario_nao_encontrado");
    }
    case "instagram_check_follow": {
      if (!comentario.channel_session_id || !comentario.autor_id)
        return falha(node.type, "sem_comentario");
      const { segue } = await canal.conferirSeSegue(c.admin, {
        organizationId: c.org,
        channelSessionId: comentario.channel_session_id,
        autorId: comentario.autor_id,
      });
      if (segue === true) return feito(node.type, "segue", SEGUE_BRANCH_ID);
      if (segue === false) return feito(node.type, "nao_segue", NAO_SEGUE_BRANCH_ID);
      // "Não deu para saber" é a saída comum.
      return feito(node.type, "indefinido");
    }
  }
}
