/**
 * GET /api/v1/channels/conexoes — todas as conexões vivas da organização, uma por cartão (fase B da tela
 * de Conexões, 17/11/2026: várias contas oficiais do WhatsApp na mesma organização).
 *
 * Sessão (cookie) ou token `dsk_…` (`role:manager` + `mcp:read`) — o token só chega ao handler quando
 * o caminho entrar em `lib/auth/public-paths.ts`; hoje o proxy só reconhece cookie. Só leitura. Piso `manager`, o mesmo da tela
 * `/app/connections` (`lib/navigation/catalogo.ts`) e das rotas `/channels/official/*`.
 *
 * Nada de credencial na resposta: a regra (colunas fixas, sem token, segredo nem caminho de webhook) mora
 * em `lib/channels/conexoes-em-cartoes.ts`. organization_id vem da sessão ou da linha do token, nunca da
 * query nem do corpo.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { autorizarAdministracao } from "@/lib/api/auth-dual-admin";
import { falhaInterna, ok } from "@/lib/api/wrappers";
import { listarConexoesEmCartoes } from "@/lib/channels/conexoes-em-cartoes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "channel_sessions",
    role: "manager",
    escrita: false,
  });
  if (!authz.ok) return authz.response;

  const { data, error, schemaOutdated } = await listarConexoesEmCartoes(
    authz.supabase,
    authz.organizationId,
  );
  if (error) return falhaInterna("internal_error", error, { requestId });

  return ok(data ?? [], {
    requestId,
    headers: { "cache-control": "no-store, max-age=0" },
    ...(schemaOutdated ? { meta: { schema_outdated: true } } : {}),
  });
}
