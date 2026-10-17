import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/settings/routing — lê a config de ATENDIMENTO (manager+):
 *      `organizations.settings.routing` + `settings.visibility_mode`.
 * PATCH /api/v1/settings/routing — grava as duas (manager+).
 *
 * Rota v1 dedicada (não o Server Action updateTenant): a matriz spec 13 §4 nota
 * 5 separa autz — routing/atendimento é manager+, enquanto o perfil da org
 * (updateTenant) é admin-only. Forçar routing no updateTenant misturaria os dois
 * gates. Merge não-destrutivo do jsonb settings (preserva as demais chaves).
 *
 * knobs (max_retries, backoff_seconds) são CONFIG — o worker de G5-02 LÊ daqui;
 * nunca constantes hardcoded no worker (doutrina). org de fonte confiável.
 *
 * `visibility_mode` entra aqui (issue #144) porque a spec 13 §4 trata as duas como a MESMA linha
 * ("config de atendimento/roteamento: manager+"), e fica em `settings.visibility_mode`, irmão de
 * `settings.routing` e não dentro dele: é esse caminho exato que `fn_can_view_lead`/
 * `fn_can_view_conversation` leem na RLS.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra (inclusive POR QUE a escrita vai pelo cliente de servidor — a policy de
 * escrita de `organizations` é de platform admin) vive em `lib/organizacao/atendimento.ts`, a mesma das
 * tools MCP. Auth: sessão OU token `dsk_…` (`manager` + `mcp:read` / `mcp:write`); a organização sai da
 * sessão/da linha do token.
 */
import type { NextRequest } from "next/server";

import { entradaDeAdministracao } from "@/lib/api/porta-admin";
import { ApiError } from "@/lib/api/types";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { gravarAtendimento, lerAtendimento, type DepsDeAtendimento } from "@/lib/organizacao/atendimento";
import { atendimentoConfigPatchSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function entrada(req: NextRequest, escrita: boolean) {
  const e = await entradaDeAdministracao(req, { resource: "settings_routing", role: "manager", escrita });
  if (e.resposta) return { resposta: e.resposta } as const;
  const deps: DepsDeAtendimento = {
    supabase: e.authz.supabase,
    admin: createAdminClient(),
    organizationId: e.authz.organizationId,
    actor: e.authz.actor,
    requestId: e.requestId,
  };
  return { deps, requestId: e.requestId, resposta: undefined } as const;
}

export async function GET(req: NextRequest): Promise<Response> {
  const e = await entrada(req, false);
  if (e.resposta) return e.resposta;
  try {
    return ok(await lerAtendimento(e.deps), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entrada(req, true);
  if (e.resposta) return e.resposta;

  let input;
  try {
    input = await validateRequest(atendimentoConfigPatchSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId: e.requestId,
      });
    }
    throw err;
  }
  try {
    return ok(await gravarAtendimento(e.deps, input), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
