/**
 * A porta REST dos fluxos de follow-up: monta as dependências do núcleo (`administracao.ts`) a partir da
 * autorização já resolvida (sessão OU token `dsk_…`). Fica fora do núcleo para a tool MCP — que tem o próprio
 * contexto — não arrastar o transporte HTTP.
 */
import type { NextRequest } from "next/server";

import {
  autorizarAdministracao,
  pessoaResponsavel,
  traducaoDe,
  type AuthAdminOk,
} from "@/lib/api/auth-dual-admin";
import { fail } from "@/lib/api/wrappers";
import type { Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

import { idValido, type DepsDeFollowup } from "./administracao";

export type EntradaDeFluxo =
  | { resposta: Response }
  | { resposta?: undefined; authz: AuthAdminOk; deps: DepsDeFollowup; requestId: string };

/**
 * Autoriza (papel da tela: `viewer` para ler, `manager` para escrever; no token, `mcp:read`/`mcp:write`),
 * valida o id do caminho e devolve as dependências do núcleo. `id` ausente = rota de coleção.
 */
export async function entradaDeFluxo(
  req: NextRequest,
  opts: { escrita: boolean; role: Role; id?: string },
): Promise<EntradaDeFluxo> {
  const requestId = crypto.randomUUID();
  if (opts.id !== undefined && !idValido(opts.id)) {
    return { resposta: fail("invalid_request", "id inválido.", 400, { requestId }) };
  }
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "followup_flows",
    role: opts.role,
    escrita: opts.escrita,
  });
  if (!authz.ok) return { resposta: authz.response };
  return {
    authz,
    requestId,
    deps: {
      supabase: authz.supabase,
      admin: createAdminClient(),
      organizationId: authz.organizationId,
      actor: authz.actor,
      responsavel: pessoaResponsavel(authz),
      requestId,
      t: traducaoDe(authz),
    },
  };
}
