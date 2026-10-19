/**
 * GET /api/v1/contacts/count — quantos contatos o filtro alcança.
 *
 * É a conta do "Selecionar todos os N contatos do filtro" da tela de Contatos: o N
 * vem do SERVIDOR, pelo mesmo filtro da lista (`lib/contacts/consulta.ts`), e é ele
 * que a exclusão em lote devolve como `esperado` para provar que o conjunto não mudou.
 * Os filtros têm os mesmos nomes da lista (`filtrosDeContatosSchema`).
 *
 * Sessão de navegador, papel `viewer` (o mesmo da lista). Não conta contato anonimizado (LGPD): o lote e a
 * exportação também não o operam, e os três números têm de bater.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { contarContatos } from "@/lib/contacts/consulta";
import { filtrosDeContatosSchema } from "@/lib/schemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = filtrosDeContatosSchema.safeParse(
    Object.fromEntries([...new URL(req.url).searchParams.entries()].filter(([, v]) => v !== "")),
  );
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  try {
    const total = await contarContatos(await createClient(), parsed.data, {
      organizationId: authz.org.orgId,
      requestId,
      timezone: authz.org.timezone ?? null,
      // Contagem, exclusão e exportação em lote concordam: operam só o contato vivo (sem anonimizado).
      somenteOperaveis: true,
    });
    return ok({ total }, { requestId });
  } catch (err) {
    if (err instanceof ApiError) return fail(err.code, err.message, err.status, { requestId });
    throw err;
  }
}
