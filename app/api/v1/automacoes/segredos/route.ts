import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * As CHAVES SECRETAS das automações (bloco "Requisição HTTP"), gerente+.
 *
 *   GET  — lista: nome e os 4 últimos caracteres. NUNCA o valor.
 *   POST — cria `{ nome, valor }`. `Idempotency-Key` opcional (recibo em `idempotency_keys`).
 *
 * O valor é cifrado (`fn_encrypt_oauth`) antes de gravar e nunca volta: nem na
 * resposta, nem no audit (só o nome; nem os finais), nem em log. Regra em `lib/automacoes/segredos.ts`.
 */
import { createHash } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  criarSegredo,
  listarSegredos,
  nomeDoSegredoSchema,
  valorDoSegredoSchema,
  type SegredoVisivel,
} from "@/lib/automacoes/segredos";
import { createAdminClient } from "@/lib/supabase/admin";

import { portaDoCofre } from "./_porta";

export const dynamic = "force-dynamic";

const corpoSchema = z.strictObject({ nome: nomeDoSegredoSchema, valor: valorDoSegredoSchema });

export async function GET(req: NextRequest): Promise<Response> {
  const p = await portaDoCofre(req, false);
  if (p.resposta) return p.resposta;
  try {
    const lista = await listarSegredos(createAdminClient(), p.org);
    return ok(lista, { requestId: p.requestId });
  } catch {
    return fail("internal_error", p.t("Não consegui ler as chaves."), 500, { requestId: p.requestId });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const p = await portaDoCofre(req, true);
  if (p.resposta) return p.resposta;
  const { org, requestId, t } = p;

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    // Sem `details`: o Zod repetiria o valor recusado — e o valor é a chave.
    return fail(
      "validation_failed",
      t("Dê um nome (letras minúsculas, números e _) e cole a chave inteira, sem espaços (mínimo de 8 caracteres)."),
      400,
      { requestId },
    );
  }
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", t("Idempotency-Key deve ser um UUID."), 400, { requestId });
  }

  const admin = createAdminClient();
  type Saida = { ok: true; segredo: SegredoVisivel } | { ok: false; status: number; code: string; mensagem: string };
  const executar = async (): Promise<{ resposta: Saida; status: number }> => {
    const r = await criarSegredo(admin, { org, nome: corpo.data.nome, valor: corpo.data.valor, atorId: p.atorId });
    if (!r.ok) {
      const mapa = {
        nome_em_uso: { status: 409, code: "segredo_nome_em_uso", mensagem: t("Já existe uma chave com este nome.") },
        cifra_indisponivel: {
          status: 500,
          code: "internal_error",
          mensagem: t("A cifra do servidor não está disponível; a chave não foi gravada."),
        },
        nao_encontrado: { status: 404, code: "not_found", mensagem: t("Chave não encontrada.") },
        falha: { status: 500, code: "internal_error", mensagem: t("Não consegui gravar a chave.") },
      } as const;
      return { resposta: { ok: false, ...mapa[r.erro] }, status: mapa[r.erro].status };
    }
    await audit({
      action: "automacao.chave_criada",
      actorUserId: p.atorId,
      organizationId: org,
      resourceType: "automacao_segredos",
      resourceId: r.segredo.id,
      requestId,
      // O QUE mudou, jamais o valor.
      metadata: { nome: r.segredo.nome },
    });
    return { resposta: { ok: true, segredo: r.segredo }, status: 201 };
  };

  const responder = (s: Saida) =>
    s.ok ? ok(s.segredo, { status: 201, requestId }) : fail(s.code, s.mensagem, s.status, { requestId });

  if (chave === null) return responder((await executar()).resposta);
  const desfecho = await comIdempotencia<Saida>({
    // Servidor, não a sessão: `idempotency_keys` não é legível nem gravável por `authenticated`.
    db: createAdminClient(),
    organizationId: org,
    endpoint: "/api/v1/automacoes/segredos",
    chave,
    ator: p.atorId ?? "desconhecido",
    // O recibo guarda só o hash do corpo; ainda assim entra o SHA-256 do valor, nunca o valor.
    corpo: { nome: corpo.data.nome, valor_sha256: createHash("sha256").update(corpo.data.valor).digest("hex") },
    executar,
  });
  if (desfecho.tipo === "conflito") {
    return fail("idempotency_conflict", t("Esta chave de idempotência já foi usada com outro conteúdo."), 409, { requestId });
  }
  if (desfecho.tipo === "em_curso") {
    return fail("idempotency_in_progress", t("A mesma requisição ainda está em curso. Tente de novo em instantes."), 409, {
      requestId,
    });
  }
  return responder(desfecho.resposta);
}
