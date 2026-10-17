/**
 * A porta REST dos roteadores: monta as dependências do núcleo (`roteadores.ts`) a partir da autorização já
 * resolvida (sessão OU token `dsk_…`). Fora do núcleo para a tool MCP não arrastar o transporte HTTP.
 */
import type { NextRequest } from "next/server";

import { pessoaResponsavel, traducaoDe } from "@/lib/api/auth-dual-admin";
import { entradaDeAdministracao } from "@/lib/api/porta-admin";
import type { Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

import type { DepsDeRoteadores } from "./roteadores";

export type EntradaDeRoteador =
  | { resposta: Response }
  | { resposta?: undefined; deps: DepsDeRoteadores; requestId: string; t: (texto: string) => string };

export async function entradaDeRoteador(
  req: NextRequest,
  opts: { escrita: boolean; role: Role; id?: string },
): Promise<EntradaDeRoteador> {
  const e = await entradaDeAdministracao(req, { resource: "ai_routers", ...opts });
  if (e.resposta) return { resposta: e.resposta };
  const t = traducaoDe(e.authz);
  return {
    requestId: e.requestId,
    t,
    deps: {
      admin: () => createAdminClient(),
      organizationId: e.authz.organizationId,
      actor: e.authz.actor,
      responsavel: pessoaResponsavel(e.authz),
      requestId: e.requestId,
      t,
    },
  };
}
