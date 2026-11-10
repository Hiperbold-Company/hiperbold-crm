/**
 * A porta das rotas do cofre de chaves das automações: sessão (cookie) de
 * gerente ou acima — a mesma régua de editar e publicar automações. Token
 * `dsk_…` é recusado: a chave secreta é administrada por gente, na tela.
 *
 * A organização sai da sessão, nunca do corpo nem da URL.
 */
import type { NextRequest } from "next/server";

import { autorizarAdministracao, pessoaResponsavel, traducaoDe } from "@/lib/api/auth-dual-admin";
import { fail } from "@/lib/api/wrappers";

export type PortaDoCofre =
  | { resposta: Response }
  | { resposta?: undefined; org: string; atorId: string | null; requestId: string; t: (s: string) => string };

export async function portaDoCofre(req: NextRequest, escrita: boolean): Promise<PortaDoCofre> {
  const requestId = crypto.randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "automacao_segredos",
    role: "manager",
    escrita,
  });
  if (!authz.ok) return { resposta: authz.response };
  const t = traducaoDe(authz);
  if (authz.via === "token") {
    return {
      resposta: fail("forbidden", t("As chaves secretas só são administradas pela tela, com sessão."), 403, { requestId }),
    };
  }
  return { org: authz.organizationId, atorId: pessoaResponsavel(authz), requestId, t };
}

export const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
