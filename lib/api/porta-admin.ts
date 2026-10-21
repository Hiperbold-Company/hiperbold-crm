/**
 * Entrada comum das rotas de administração (fase 3 da API): valida o `id` do caminho, autoriza por sessão OU
 * token `dsk_…` (`autorizarAdministracao`) e entrega a autorização resolvida.
 *
 * Ordem preservada das rotas que já existiam: `id` malformado responde 400 ANTES da autenticação, como antes.
 */
import type { NextRequest } from "next/server";

import { autorizarAdministracao, type AuthAdminOk } from "@/lib/api/auth-dual-admin";
import { fail } from "@/lib/api/wrappers";
import type { Role } from "@/lib/auth/types";
import type { ChaveDePermissao } from "@/lib/permissoes/catalogo";

export const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EntradaDeAdministracao =
  | { resposta: Response }
  | { resposta?: undefined; authz: AuthAdminOk; requestId: string };

export async function entradaDeAdministracao(
  req: NextRequest,
  opts: { resource: string; role: Role; escrita: boolean; tokenRole?: Role; id?: string; permissao?: ChaveDePermissao },
): Promise<EntradaDeAdministracao> {
  const requestId = crypto.randomUUID();
  if (opts.id !== undefined && !UUID_RX.test(opts.id)) {
    return { resposta: fail("invalid_request", "id inválido.", 400, { requestId }) };
  }
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: opts.resource,
    role: opts.role,
    escrita: opts.escrita,
    tokenRole: opts.tokenRole,
    permissao: opts.permissao,
  });
  if (!authz.ok) return { resposta: authz.response };
  return { authz, requestId };
}
