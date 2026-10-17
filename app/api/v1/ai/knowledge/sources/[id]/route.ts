import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET    /api/v1/ai/knowledge/sources/[id]  — o material e o conteúdo que dá para editar
 * PATCH  /api/v1/ai/knowledge/sources/[id]  — update knowledge source
 * DELETE /api/v1/ai/knowledge/sources/[id]  — soft-delete (status='archived')
 *
 * Auth: sessão por cookie OU token `dsk_…` (`manager` + `mcp:read` / `mcp:write`, como a tela).
 * organization_id is ALWAYS resolved from the session/token row — never from body/path.
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/ai/rag/administracao-fontes.ts`, a mesma das tools MCP.
 */
import { type NextRequest } from "next/server";

import {
  alterarFonteSchema,
  arquivarFonte,
  editarFonte,
  lerFonte,
} from "@/lib/ai/rag/administracao-fontes";
import { entradaDeConhecimento } from "@/lib/ai/rag/administracao-fontes-porta";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

// O diálogo de edição não pode adivinhar o que já está lá: sem este GET, "Editar conteúdo" abriria um campo vazio
// e salvar apagaria a FAQ inteira.
export async function GET(req: NextRequest, { params }: RouteCtx): Promise<Response> {
  const { id } = await params;
  const e = await entradaDeConhecimento(req, { escrita: false, role: "manager", id });
  if (e.resposta) return e.resposta;
  try {
    return ok(await lerFonte(e.deps, id), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function PATCH(req: NextRequest, { params }: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await params;
  const e = await entradaDeConhecimento(req, { escrita: true, role: "manager", id });
  if (e.resposta) return e.resposta;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId: e.requestId });
  }
  const parsed = alterarFonteSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId: e.requestId,
      details: parsed.error.flatten(),
    });
  }
  try {
    return ok(await editarFonte(e.deps, id, parsed.data), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await params;
  const e = await entradaDeConhecimento(req, { escrita: true, role: "manager", id });
  if (e.resposta) return e.resposta;
  try {
    return ok(await arquivarFonte(e.deps, id), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
