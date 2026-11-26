import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/ai/budget — o estado do orçamento da org ativa (manager+).
 * PATCH /api/v1/ai/budget — RECUSADO com 403 para qualquer papel da empresa.
 *
 * ═══ POR QUE A EMPRESA NÃO ESCREVE MAIS AQUI ═══
 *
 * Decisão do dono do produto (25/11/2026): o teto de gasto de IA em dólar
 * virou TRAVA DE SEGURANÇA escondida. O cliente acompanha o consumo em tokens
 * em Meu plano e não vê dólar; só o administrador da plataforma ajusta o teto,
 * no painel (`PATCH /api/v1/admin/tenants/[id]/ai-budget`, com a organização
 * tirada do path). Deixar este PATCH aceitando o admin da empresa seria uma
 * porta escondida para afrouxar a trava sem tela nenhuma.
 *
 * A escada, o piso, a carência e a auditoria continuam valendo — moram agora
 * em `lib/ai/budget/ajustar-orcamento.ts`, que só a rota do admin chama.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getBudgetStatus } from "@/lib/ai/budget/check";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_budget" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const status = await getBudgetStatus(activeOrg.orgId);
  return ok(status, { requestId });
}

export async function PATCH(_req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Autentica primeiro, para quem não tem sessão continuar recebendo 401.
  const authz = await requireRole("viewer", { requestId, resource: "ai_budget" });
  if (!authz.ok) return authz.response;

  return fail(
    "forbidden",
    traduzir(
      "O limite de segurança de IA é ajustado pelo suporte da plataforma. Fale com o suporte se precisar mudá-lo.",
      authz.user.idioma,
    ),
    403,
    { requestId },
  );
}
