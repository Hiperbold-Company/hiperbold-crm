/**
 * A porta REST do material de conhecimento: monta as dependências do núcleo (`administracao-fontes.ts`) a
 * partir da autorização já resolvida (sessão OU token `dsk_…`).
 */
import type { NextRequest } from "next/server";

import { traducaoDe } from "@/lib/api/auth-dual-admin";
import { entradaDeAdministracao } from "@/lib/api/porta-admin";
import type { Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

import type { DepsDeConhecimento } from "./administracao-fontes";

export type EntradaDeConhecimento =
  | { resposta: Response }
  | { resposta?: undefined; deps: DepsDeConhecimento; requestId: string; t: (texto: string) => string };

export async function entradaDeConhecimento(
  req: NextRequest,
  opts: { escrita: boolean; role: Role; id?: string },
): Promise<EntradaDeConhecimento> {
  const e = await entradaDeAdministracao(req, { resource: "ai_knowledge", ...opts });
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
      requestId: e.requestId,
      t,
    },
  };
}
