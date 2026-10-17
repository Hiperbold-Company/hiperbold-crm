/**
 * A porta REST das regras automáticas: monta as dependências do núcleo (`regras-automaticas-admin.ts`) a
 * partir da autorização já resolvida (sessão OU token `dsk_…`).
 */
import type { NextRequest } from "next/server";

import { pessoaResponsavel, traducaoDe } from "@/lib/api/auth-dual-admin";
import { entradaDeAdministracao } from "@/lib/api/porta-admin";
import type { Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

import type { DepsDeRegras } from "./regras-automaticas-admin";

export type EntradaDeRegra =
  | { resposta: Response }
  | { resposta?: undefined; deps: DepsDeRegras; requestId: string; t: (texto: string) => string };

export async function entradaDeRegra(
  req: NextRequest,
  opts: { escrita: boolean; role: Role; id?: string },
): Promise<EntradaDeRegra> {
  const e = await entradaDeAdministracao(req, { resource: "automation_rules", ...opts });
  if (e.resposta) return { resposta: e.resposta };
  const t = traducaoDe(e.authz);
  return {
    requestId: e.requestId,
    t,
    deps: {
      supabase: e.authz.supabase,
      admin: createAdminClient(),
      organizationId: e.authz.organizationId,
      actor: e.authz.actor,
      responsavel: pessoaResponsavel(e.authz),
      requestId: e.requestId,
      t,
    },
  };
}
