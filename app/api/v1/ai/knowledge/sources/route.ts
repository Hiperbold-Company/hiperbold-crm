import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/knowledge/sources — os materiais da organização (qualquer membro; chave com `mcp:read`)
 * POST /api/v1/ai/knowledge/sources — cadastra um material (manager+; chave com `mcp:write`)
 *
 * Desde a 0181 o acervo é da ORGANIZAÇÃO, não de um agente. `agent_id` continua
 * aceito e vira registro histórico de onde o material nasceu; quem lê o quê é
 * escolha da versão publicada de cada assistente
 * (`ai_agent_versions.knowledge_source_ids`).
 *
 * Auth: sessão por cookie OU token `dsk_…`. `organization_id` SEMPRE sai da sessão/da linha do token — nunca do corpo.
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/ai/rag/administracao-fontes.ts`, a mesma das tools MCP.
 * O envio de ARQUIVO (`/upload`) e a reindexação continuam só na sessão.
 */
import { type NextRequest } from "next/server";

import { cadastrarFonte, criarFonteSchema, listarFontes } from "@/lib/ai/rag/administracao-fontes";
import { entradaDeConhecimento } from "@/lib/ai/rag/administracao-fontes-porta";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const e = await entradaDeConhecimento(req, { escrita: false, role: "viewer" });
  if (e.resposta) return e.resposta;
  try {
    // `ok()` já embrulha em `{ data }`: devolver `{ data: rows }` aqui duplicaria o envelope.
    return ok(await listarFontes(e.deps), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entradaDeConhecimento(req, { escrita: true, role: "manager" });
  if (e.resposta) return e.resposta;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", e.t("Body JSON inválido."), 400, { requestId: e.requestId });
  }
  const parsed = criarFonteSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", e.t("Campos inválidos."), 422, {
      requestId: e.requestId,
      details: parsed.error.flatten(),
    });
  }
  try {
    return ok(await cadastrarFonte(e.deps, parsed.data), { status: 201, requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
