/**
 * POST de CRIAÇÃO das rotas de administração com `Idempotency-Key` opcional.
 *
 * Contrato (CLAUDE.md, "Idempotência"): mesma chave + mesmo corpo devolve a resposta gravada sem
 * reexecutar; mesma chave + corpo diferente é 409 `idempotency_conflict`; duas requisições
 * simultâneas executam o efeito UMA vez (a segunda recebe 409 `idempotency_in_progress`). Sem o
 * header, o caminho é o de sempre — a chave só existe quando quem chama quer retentativa segura.
 *
 * O recibo vive em `public.idempotency_keys` (`lib/api/idempotency.ts`), sempre escopado pela
 * organização que a rota JÁ resolveu da sessão/da linha do token, nunca do cliente.
 *
 * ⚠️ O QUE FICA NO RECIBO É O QUE `executar` DEVOLVE. Segredo que só aparece uma vez (HMAC de
 * entrada automática) NÃO pode passar por ali: o recibo é uma linha de banco que vive 24h. Quem
 * precisa dar um segredo na PRIMEIRA resposta devolve de `executar` o recurso sem o segredo e o
 * acrescenta em `aoExecutar`, que só roda na execução real, nunca no replay.
 */
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import type { AuthAdminOk } from "@/lib/api/auth-dual-admin";

export async function criarComChaveOpcional<T>(
  req: Request,
  authz: AuthAdminOk,
  opts: {
    requestId: string;
    /** Identifica a operação no recibo. Rota aninhada leva o id do pai: `/api/v1/pipelines/<id>/fields`. */
    endpoint: string;
    /** O corpo JÁ validado — define "mesma operação". */
    corpo: unknown;
    t: (texto: string) => string;
    /** O efeito. Lançar propaga (a rota traduz) e NÃO deixa recibo. */
    executar: () => Promise<T>;
    /** Só na execução real: o que enriquece a resposta sem entrar no recibo. */
    aoExecutar?: (recurso: T) => unknown;
  },
): Promise<Response> {
  const { requestId, endpoint, corpo, t, executar, aoExecutar } = opts;
  const chave = chaveDaRequisicao(req);

  if (chave === null) {
    const recurso = await executar();
    return ok(aoExecutar ? aoExecutar(recurso) : recurso, { requestId, status: 201 });
  }

  // Chave malformada não vira recibo: recusar cedo é mais honesto que gravar lixo.
  if (!z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", t("Idempotency-Key deve ser um UUID."), 400, { requestId });
  }

  const desfecho = await comIdempotencia<T>({
    db: authz.supabase,
    organizationId: authz.organizationId,
    endpoint,
    chave,
    corpo,
    executar: async () => ({ resposta: await executar(), status: 201 }),
  });

  if (desfecho.tipo === "conflito") {
    return fail(
      "idempotency_conflict",
      t("Esta chave de idempotência já foi usada com outro conteúdo."),
      409,
      { requestId },
    );
  }
  if (desfecho.tipo === "em_curso") {
    return fail(
      "idempotency_in_progress",
      t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
      409,
      { requestId },
    );
  }
  if (desfecho.tipo === "executou" && aoExecutar) {
    return ok(aoExecutar(desfecho.resposta), { requestId, status: 201 });
  }
  return ok(desfecho.resposta, { requestId, status: 201 });
}
