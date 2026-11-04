import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/message-templates — lista as respostas prontas visíveis a quem chama: as
 *      compartilhadas da organização e, na sessão, as pessoais do próprio usuário. Uma chave de
 *      API (`Bearer dsk_…`) só enxerga as compartilhadas (não tem resposta pessoal).
 * POST /api/v1/message-templates — cria uma resposta pronta. `shared=true` grava owner_user_id
 *      null (compartilhada) e exige manager+; `shared=false` (default, só sessão) grava
 *      owner_user_id = user.id. Aceita `Idempotency-Key: <uuid>`.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A regra vive em `lib/operacao/respostas-prontas.ts`, a mesma das tools MCP.
 *
 * Auth: sessão (agent+; compartilhada exige manager+, como a tela) OU token `dsk_…`: leitura
 * `agent` + `mcp:read`; escrita `manager` + `mcp:write`, sempre compartilhada. `organization_id`
 * sai da sessão/da linha do token.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { autorizarAdministracao, pessoaResponsavel, traducaoDe } from "@/lib/api/auth-dual-admin";
import { criarComChaveOpcional } from "@/lib/api/criacao-idempotente";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { criarRespostaPronta, listarRespostasProntas } from "@/lib/operacao/respostas-prontas";
import { createTemplateSchema } from "@/lib/schemas/templates";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { grupoDaOrganizacao } from "@/lib/templates/grupo-da-resposta";
import { posicaoEntre } from "@/lib/templates/ordem";

export const dynamic = "force-dynamic";
const COLS =
  "id, organization_id, owner_user_id, title, body, shortcut, midias, mostrar_na_barra, grupo_id, created_by_user_id, created_at, updated_at, ordem";
/** Tag do endpoint no recibo de idempotência. Muda de rota muda de recibo. */
const ENDPOINT = "/api/v1/message-templates";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "message_templates",
    role: "agent",
    escrita: false,
  });
  if (!authz.ok) return authz.response;
  if (authz.via === "token") {
    try {
      return ok(
        await listarRespostasProntas({
          supabase: authz.supabase,
          organizationId: authz.organizationId,
          actor: authz.actor,
          requestId,
        }),
        { requestId },
      );
    } catch (err) {
      return respostaDeRecusa(err, requestId);
    }
  }

  // Sessão: o caminho da tela (grupos, ordem e mídias da resposta, #3244/#3245/#2526).
  const sessao = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!sessao.ok) return sessao.response;
  const { org } = sessao;

  const supabase = await createClient();
  // RLS já limita a compartilhados + próprios da org ativa.
  //
  // A ordem é a que o OPERADOR escolheu (`ordem`, #3244), não a de edição: era
  // `updated_at desc`, então editar o corpo de uma resposta a empurrava para o
  // topo desta lista e do slash-menu do Inbox. Virou `ordem asc` + dois
  // desempates (a resposta nova nasce ACIMA da primeira, ver o POST; duas que
  // empatem — criadas ao mesmo tempo — saem mais recente primeiro).
  const { data, error } = await supabase
    .from("message_templates")
    .select(COLS)
    .eq("organization_id", org.orgId)
    .order("ordem", { ascending: true })
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true });
  if (error) return fail("internal_error", "Erro ao listar templates.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "message_templates",
    role: "agent",
    // Chave de API só escreve resposta COMPARTILHADA, e isso é papel de gerente na tela.
    tokenRole: "manager",
    escrita: true,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  const raw = await req.json().catch(() => null);
  const parsed = createTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  // Token `dsk_…`: só resposta COMPARTILHADA, pela regra de `lib/operacao/respostas-prontas.ts`.
  if (authz.via === "token") {
    try {
      return await criarComChaveOpcional(req, authz, {
        requestId,
        endpoint: ENDPOINT,
        corpo: parsed.data,
        t,
        executar: () =>
          criarRespostaPronta(
            {
              supabase: authz.supabase,
              organizationId: authz.organizationId,
              actor: authz.actor,
              requestId,
            },
            parsed.data,
            pessoaResponsavel(authz),
          ),
      });
    } catch (err) {
      return respostaDeRecusa(err, requestId);
    }
  }

  // Sessão: o caminho da tela (grupo, ordem; `midias` nasce vazia).
  const sessao = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!sessao.ok) return sessao.response;
  const { user, org } = sessao;
  const { title, body, shortcut, shared, mostrar_na_barra, grupo_id } = parsed.data;
  // Compartilhado exige manager+. requireRole já resolveu o role efetivo do
  // banco em org.role — reusar em vez de uma 2ª chamada/RPC. A RLS with_check
  // barra de qualquer forma; isto só dá um erro claro antes do insert.
  if (shared && !roleAtLeast(org.role, "manager")) {
    return fail("forbidden", t("Só manager+ cria template compartilhado."), 403, { requestId });
  }
  const supabase = await createClient();

  // O GRUPO (#3245) tem de ser da organização ativa. `null` é sempre válido —
  // é "sem grupo". A FK composta do banco é a segunda barreira; esta é a que
  // devolve 422 dizendo QUAL campo está errado.
  try {
    if (!(await grupoDaOrganizacao(supabase, org.orgId, grupo_id))) {
      return fail("validation_failed", t("Dados inválidos."), 422, {
        requestId,
        details: { grupo_id: [t("Grupo que não pertence a esta organização.")] },
      });
    }
  } catch {
    return fail("internal_error", "Erro ao criar template.", 500, { requestId });
  }

  /**
   * O efeito. Lança em falha de propósito: assim o helper propaga sem gravar
   * recibo. Recibo de operação que falhou seria pior que não ter idempotência
   * — o cliente retentaria e receberia o replay de uma criação inexistente.
   */
  async function criar() {
    // A resposta nova nasce no TOPO e sem empate: um passo acima da primeira da
    // lista visível. Com todas nascendo na mesma posição, o desempate passava a
    // ser `updated_at` — e editar uma resposta nova voltava a reordenar a lista
    // (o defeito da #3244 pela porta da criação).
    const { data: primeira, error: erroPrimeira } = await supabase
      .from("message_templates")
      .select("ordem")
      .eq("organization_id", org.orgId)
      .order("ordem", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (erroPrimeira) throw new Error("Erro ao criar template.");
    const menor = (primeira as { ordem: number } | null)?.ordem ?? null;
    // `posicaoEntre(null, x)` nunca é `null`: só o empate entre DUAS vizinhas é.
    const ordem = posicaoEntre(null, menor)!;

    const { data, error } = await supabase
      .from("message_templates")
      .insert({
        organization_id: org.orgId,
        owner_user_id: shared ? null : user.id,
        title,
        body,
        shortcut: shortcut ?? null,
        // O grupo (#3245): ausente na tela = `null` = lista plana, que é o
        // estado de toda resposta anterior à 0808.
        grupo_id: grupo_id ?? null,
        // "Mostrar na barra do Inbox" (#3282): só vai quando a tela escolheu.
        // Ausente, a coluna assume o default dela (`true`) — a resposta nasce
        // aparecendo na barra, que é o comportamento de sempre.
        ...(mostrar_na_barra === undefined ? {} : { mostrar_na_barra }),
        // `midias` nasce vazia: a mídia nova (a imagem da #2526 ou o áudio do
        // recurso, #2833) é gravada pela rota de upload, que gera o caminho
        // sabendo o id do template. Aceitar caminho aqui seria aceitar um
        // arquivo que ninguém conferiu.
        midias: [],
        created_by_user_id: user.id,
        ordem,
      })
      .select(COLS)
      .single();
    if (error || !data) throw new Error("Erro ao criar template.");

    void audit({
      action: "template.created",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "message_template",
      resourceId: data.id,
      requestId,
      metadata: { shared, title },
    });
    return data;
  }

  // `Idempotency-Key` opcional: o mesmo recibo do servidor das outras rotas
  // (`lib/api/criacao-idempotente.ts`). Sem a chave, cria direto.
  try {
    return await criarComChaveOpcional(req, authz, {
      requestId,
      endpoint: ENDPOINT,
      corpo: parsed.data,
      t,
      executar: criar,
    });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
