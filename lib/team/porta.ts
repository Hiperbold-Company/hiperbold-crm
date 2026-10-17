/**
 * A porta REST da equipe: monta as dependências do núcleo (`administracao.ts`) a partir da autorização já
 * resolvida (sessão OU token `dsk_…`; `admin` + `mcp:write`, como a tela). Fora do núcleo para a tool MCP não
 * arrastar o transporte HTTP.
 */
import type { NextRequest } from "next/server";

import { autorizarAdministracao, pessoaResponsavel, traducaoDe, type AuthAdminOk } from "@/lib/api/auth-dual-admin";
import { createAdminClient } from "@/lib/supabase/admin";

import type { DepsDeEquipe } from "./administracao";

export type EntradaDeEquipe =
  | { resposta: Response }
  | { resposta?: undefined; authz: AuthAdminOk; deps: DepsDeEquipe; requestId: string };

export async function entradaDeEquipe(req: NextRequest): Promise<EntradaDeEquipe> {
  const requestId = crypto.randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "team",
    role: "admin",
    escrita: true,
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
