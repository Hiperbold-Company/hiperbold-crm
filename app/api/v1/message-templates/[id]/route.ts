import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/message-templates/[id] — atualiza título/corpo/atalho, a mídia
 *        do recurso e a LISTA de imagens (`midias`, #2526).
 * DELETE /api/v1/message-templates/[id] — remove o template e as imagens dele.
 *
 * ─── A rota GET (URL assinada do áudio) saiu em #2833 ───────────────────────
 *
 * Ela existia para o caminho próprio da barra de recursos: o clique assinava a
 * URL do áudio e armava um anexo pendente só dele. Com a barra passando pelo
 * MESMO `applyTemplate` do `/` (que baixa os bytes por
 * `GET /message-templates/:id/midias/:indice`, a rota que já existia), ninguém
 * mais a chamava: o grep de chamadores — `useMessageTemplates`, hooks e telas —
 * ficou vazio, e o compositor era o último consumidor.
 *
 * O `.eq("organization_id", org.orgId)` é defesa extra, não substitui a RLS
 * `message_templates_write` — quem já não é dono (agent) nem manager (compartilhado)
 * é barrado pela policy antes de chegar aqui.
 *
 * ─── Por que `midias` só entra por aqui, e não pelo upload ──────────────────
 *
 * O upload ADICIONA (ele gera o caminho e confere os bytes); o PATCH é quem
 * REMOVE, mandando a lista completa das que permanecem — o mesmo desenho do
 * `PUT /products/:id/fotos`. Daí as duas conferências, e as duas importam:
 *
 *   1. `conferirMidias` — toda imagem da lista nova já existe na linha. Sem
 *      ela, um corpo forjado cadastraria um caminho que ninguém subiu.
 *   2. `midiaPertenceAoTemplate` — e que é DESTE template e desta organização.
 *      `storage.remove` roda por service role, sem RLS: sem a conferência, o
 *      PATCH apagaria arquivo de outra org pelo preço de um JSON.
 *
 * O apagado sai do bucket SÓ DEPOIS do update dar certo — arquivo órfão se
 * recupera, linha apontando para arquivo sumido é tela quebrada.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. As conferências acima moram em `lib/operacao/respostas-prontas.ts`,
 * a mesma regra das tools MCP. Token `dsk_…` (Hiperbold): `manager` + `mcp:write`, e só as
 * COMPARTILHADAS — a resposta pessoal de um atendente responde 404 à chave. A sessão segue a RLS
 * `message_templates_write`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { respostaDeRecusa } from "@/lib/api/recusa";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";
import { alterarRespostaPronta, apagarRespostaPronta } from "@/lib/operacao/respostas-prontas";
import { fail, ok, noContent } from "@/lib/api/wrappers";
import { updateTemplateSchema } from "@/lib/schemas/templates";

export const dynamic = "force-dynamic";
interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function entrada(req: NextRequest) {
  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "message_templates",
    role: "agent",
    tokenRole: "manager",
    escrita: true,
  });
  if (!authz.ok) return { requestId, resposta: authz.response } as const;
  const deps: DepsDaOperacao = {
    supabase: authz.supabase,
    organizationId: authz.organizationId,
    actor: authz.actor,
    requestId,
  };
  return { requestId, authz, deps, resposta: undefined } as const;
}

/**
 * PATCH — atualiza título/corpo/atalho, a mídia do recurso e a LISTA de imagens.
 */
export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entrada(req);
  if (e.resposta) return e.resposta;
  const t = traducaoDe(e.authz);
  const { id } = await params;
  if (!UUID_RX.test(id)) return fail("invalid_request", t("id inválido."), 400, { requestId: e.requestId });

  const raw = await req.json().catch(() => null);
  const parsed = updateTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId: e.requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  // Sessão e token pela MESMA regra (`lib/operacao/respostas-prontas.ts`): grupo, mídias com
  // precondição e limpeza do bucket depois da gravação.
  try {
    return ok(await alterarRespostaPronta({ ...e.deps, t }, id, parsed.data), { requestId: e.requestId });
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const e = await entrada(req);
  if (e.resposta) return e.resposta;
  const { id } = await params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", traducaoDe(e.authz)("id inválido."), 400, { requestId: e.requestId });
  }
  try {
    await apagarRespostaPronta({ ...e.deps, t: traducaoDe(e.authz) }, id);
    return noContent(e.requestId);
  } catch (err) {
    return respostaDeRecusa(err, e.requestId);
  }
}
