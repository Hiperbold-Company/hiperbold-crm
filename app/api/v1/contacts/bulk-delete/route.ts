import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/contacts/bulk-delete — exclui vários contatos de uma vez.
 *
 * É a exclusão da lixeira de uma linha (`DELETE /api/v1/contacts/[id]`) em lote: MESMO apagamento
 * definitivo e MESMAS recusas (contato com compromisso na agenda não é apagado), com duas
 * diferenças deliberadas: cada bloco é tudo-ou-nada (função `fn_excluir_contatos_em_lote`, migration
 * 0971) e o lote só opera contato vivo (anonimizado e lápide de fusão ficam de fora). A regra mora em
 * `lib/contacts/excluir-em-lote.ts`.
 *
 * Corpo, um dos dois:
 *   { ids: [uuid, …] }                       a seleção da tela (até 5.000)
 *   { filtro: {…}, esperado: N }             "todos do filtro": o servidor resolve o filtro; `esperado`
 *                                            é o N que a pessoa viu ao confirmar (divergiu → 409,
 *                                            nada apagado)
 *
 * Papel: `manager` ou acima, SÓ por sessão de navegador. Apagar um contato isolado continua valendo
 * para `agent` (é a lixeira de uma linha); apagar centenas de uma vez é decisão de gerência. Não há
 * caminho por token: a rota não está em `public-paths`, então o proxy barra Bearer. A organização vem
 * da sessão, nunca do corpo. Teto de chamadas por usuário (rate limit). Audit: UMA linha
 * `contacts.bulk_deleted` com contagens, ids e o resumo do filtro — nunca o texto buscado nem valor de
 * campo (podem ser dado pessoal).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { resolverAlvoDeLote } from "@/lib/contacts/alvo-de-lote";
import { excluirContatosEmLote } from "@/lib/contacts/excluir-em-lote";
import { resumoDoFiltroParaAuditoria } from "@/lib/contacts/filtros";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  contactsBulkDeleteSchema,
  TETO_DA_EXCLUSAO_EM_LOTE,
  validateRequest,
} from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Quantos ids o audit guarda. Acima disso grava só a contagem (a linha de audit não cresce sem limite). */
const TETO_DE_IDS_NO_AUDIT = 1_000;
/** Chamadas por usuário por janela: cada uma pode apagar até 5.000 contatos. */
const CHAMADAS_POR_JANELA = 6;
const JANELA_EM_SEGUNDOS = 60;

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const organizationId = authz.org.orgId;

  const limite = await checkRateLimit(
    `contacts:bulk-delete:${authz.user.id}`,
    CHAMADAS_POR_JANELA,
    JANELA_EM_SEGUNDOS,
  );
  if (!limite.allowed) {
    return fail("rate_limited", t("Muitas exclusões em pouco tempo. Tente de novo em instantes."), 429, {
      requestId,
      headers: { "Retry-After": String(JANELA_EM_SEGUNDOS) },
    });
  }

  let corpo;
  try {
    corpo = await validateRequest(contactsBulkDeleteSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();
  try {
    const alvo = await resolverAlvoDeLote(
      supabase,
      corpo,
      { organizationId, requestId, timezone: authz.org.timezone ?? null },
      TETO_DA_EXCLUSAO_EM_LOTE,
      t,
    );
    if (!alvo.ok) {
      return fail(alvo.code, alvo.message, alvo.status, { requestId });
    }

    const resultado = await excluirContatosEmLote(supabase, alvo.ids, {
      organizationId,
      requestId,
      metadataDoAtor: { actor_type: "user" },
    });

    await audit({
      action: "contacts.bulk_deleted",
      actorUserId: authz.user.id,
      organizationId,
      resourceType: "contact",
      requestId,
      metadata: {
        modo: alvo.modo,
        pedidos: alvo.ids.length,
        excluidos: resultado.excluidos.length,
        bloqueados_por_vinculo: resultado.bloqueados.length,
        ignorados: resultado.ignorados,
        inexistentes: resultado.inexistentes,
        interrompido: resultado.interrompido,
        ...(resultado.falhou.length ? { falhou: resultado.falhou.slice(0, 100) } : {}),
        ids_excluidos: resultado.excluidos.slice(0, TETO_DE_IDS_NO_AUDIT),
        ids_truncado: resultado.excluidos.length > TETO_DE_IDS_NO_AUDIT,
        ...("filtro" in corpo ? { filtro: resumoDoFiltroParaAuditoria(corpo.filtro) } : {}),
      },
    });

    if (resultado.interrompido) {
      return fail(
        "internal_error",
        t("A exclusão parou no meio: o banco recusou um bloco. Atualize a lista e confira o que sobrou."),
        500,
        {
          requestId,
          details: {
            excluidos: resultado.excluidos.length,
            bloqueados: resultado.bloqueados.length,
            ignorados: resultado.ignorados,
            inexistentes: resultado.inexistentes,
          },
        },
      );
    }

    return ok(
      {
        excluidos: resultado.excluidos.length,
        bloqueados: resultado.bloqueados.length,
        ignorados: resultado.ignorados,
        inexistentes: resultado.inexistentes,
      },
      { requestId },
    );
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
