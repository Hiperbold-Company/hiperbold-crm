/**
 * GET /api/v1/channels/meta-social — Instagram Direct e Messenger pela conexão
 * oficial da Meta: se a instalação está configurada para cada rede e as contas
 * conectadas DESTA organização (a do cookie; nunca do pedido). Nenhum token sai.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { configMetaSocial } from "@/lib/channels/meta-social/config";
import { listarContas } from "@/lib/channels/meta-social/store";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "social_connections" });
  if (!auth.ok) return auth.response;
  try {
    const cfg = await configMetaSocial();
    const contas = await listarContas(createAdminClient(), auth.org.orgId);
    return ok(
      {
        configurado: { instagram: cfg.instagram !== null, messenger: cfg.messenger !== null },
        contas,
      },
      { requestId, headers },
    );
  } catch {
    return fail("internal_error", "Não foi possível ler as contas conectadas.", 500, {
      requestId,
      headers,
    });
  }
}
