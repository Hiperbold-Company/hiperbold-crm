/**
 * GET /api/v1/admin/tenants/[id]/exclusao — Hiperbold: a exclusão manual está liberada pela régua de cobrança?
 *
 * Só leitura, para a tela desabilitar "Excluir organização" com o motivo. A autoridade continua no servidor:
 * a rota `/delete` e a ação "Excluir agora" conferem de novo (`lib/tenants/regua-de-cobranca.ts`).
 * Admin da plataforma (qualquer escopo: é leitura). `organization_id` vem do caminho, nunca do corpo.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { falhaDaEscritaDePlatformAdmin, requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { reguaDaCobrancaPermiteExcluir } from "@/lib/tenants/regua-de-cobranca";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }

  try {
    await requirePlatformAdmin();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const regua = await reguaDaCobrancaPermiteExcluir(createAdminClient(), id);
  return ok(regua, { requestId });
}
