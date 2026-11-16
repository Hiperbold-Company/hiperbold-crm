/**
 * GET /api/v1/conversations/open-with-contact/opcoes?contact_id=&phone=&lead_id=
 *
 * O que a tela precisa para decidir por qual conexão "abrir conversa" sai
 * (card e ficha do negócio, e o aviso do Chat): a conexão de quem pergunta, as
 * conexões em que ele é responsável, as conversas do contato por conexão e o
 * modo da organização. A decisão é `decidirAbertura`
 * (`lib/inbox/conexao-ao-abrir.ts`) — a mesma que o POST aplica.
 *
 * Só sessão de navegador (viewer ou acima; a caixa chama para todos, o suporte só leitura inclusive): "minha conexão" é de uma pessoa,
 * e token de servidor não tem uma. A organização sai da sessão; os ids da query
 * só são lidos dentro dela. Leitura sem efeito: não audita.
 *
 * Visibilidade: abaixo de gerente, a lista de conversas é a que a pessoa
 * enxerga (o cliente da SESSÃO, sob a RLS de `conversations_select`); das
 * outras só se diz que existem em conexão de outro atendente.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, falhaInterna, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { carregarOpcoesDeAbertura } from "@/lib/inbox/opcoes-de-abertura";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  contact_id: z.string().uuid().optional(),
  phone: z.string().trim().min(8).max(32).optional(),
  lead_id: z.string().uuid().optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const sp = req.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    contact_id: sp.get("contact_id") ?? undefined,
    phone: sp.get("phone") ?? undefined,
    lead_id: sp.get("lead_id") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_error", t("Parâmetros inválidos."), 422, { requestId });
  }

  try {
    const opcoes = await carregarOpcoesDeAbertura(createAdminClient(), {
      organizationId: authz.org.orgId,
      userId: authz.user.id,
      role: authz.org.role,
      contactId: parsed.data.contact_id ?? null,
      phone: parsed.data.contact_id ? null : (parsed.data.phone ?? null),
      leadId: parsed.data.lead_id ?? null,
      sessao: await createClient(),
    });
    return ok(opcoes, { requestId });
  } catch (err) {
    return falhaInterna("internal_error", err, { requestId });
  }
}
