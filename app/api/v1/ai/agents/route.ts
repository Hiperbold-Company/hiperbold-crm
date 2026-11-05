import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/agents  — list agents da org ativa (manager+).
 *                            Inclui kind, priority, published_version_id, paused_at, operation_mode, operation_revision, archived_at,
 *                            e o provider/model da VERSÃO PUBLICADA (ver abaixo).
 *                            Filtro `?include_archived=true` opcional.
 * POST /api/v1/ai/agents  — create agent (admin). UM caminho de escrita.
 *                            Mode A (corpo legado, Spec 05 / EPIC-06): body sem
 *                              `version` → o corpo é CONVERTIDO num `version`
 *                              (ver `corpoLegadoComoCorpoDeCriacao`) e segue o
 *                              mesmo bloco
 *                              do Mode B. Nascia `kind='rag_bot'` SEM nenhuma
 *                              linha em `ai_agent_versions` — invisível para os
 *                              dois runtimes, que resolvem o agente pelo join de
 *                              `published_version_id` (#1357). Continua aceito,
 *                              continua devolvendo a linha do agente.
 *                            Mode B (mcp_agent S-13.06): body com `version` → cria
 *                              agent kind='mcp_agent' + ai_agent_versions v1 draft
 *                              numa sequência ordenada (rollback se versão falhar).
 *
 * Auth: sessão OU token `dsk_…` (`role:manager`+ para ler, `role:admin` para criar; `mcp:read` /
 * `mcp:write`). organization_id vem da sessão/da linha do token — nunca do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { criarComChaveOpcional } from "@/lib/api/criacao-idempotente";
import { respostaDeRecusa } from "@/lib/api/recusa";
import { ok, fail } from "@/lib/api/wrappers";
import { autorizarAdministracao, pessoaResponsavel, traducaoDe } from "@/lib/api/auth-dual-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { criarAgenteMcp, listarAgentes } from "@/lib/ai/agents/administracao";
import { agentCreateSchema } from "@/lib/ai/guardrails-schema";
import { corpoLegadoComoCorpoDeCriacao } from "@/lib/ai/agents/legado-para-versao";
import { escolherModeloNoCatalogo } from "@/lib/ai/agents/escolher-modelo";
import {
  logarResolucaoDeModelo,
  resolverParEfetivo,
  type LlmDaOrganizacao,
} from "@/lib/ai/par-provedor-modelo";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * O `settings.llm` da organização — o provedor e o modelo que o produto usa
 * quando ninguém escolheu outro.
 *
 * Nunca lança: leitura que falha devolve `null` com o motivo no log, e a
 * resolução segue para a compatibilidade explícita do produto. Mesma doutrina
 * de `llmDaOrganizacao` em `lib/ai/gateway-binding.ts` — um clone sem o baseline
 * aplicado não pode deixar de criar agente por causa de uma consulta a mais.
 *
 * O client é o ADMIN (service role) com filtro programático por organização:
 * `organizations` só aceita escrita de platform admin, e a leitura por client de
 * sessão casaria zero linhas devolvendo SUCESSO (a armadilha medida em
 * `lib/ai/pontos/padrao-da-organizacao.ts`).
 */
async function lerLlmDaOrganizacao(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<LlmDaOrganizacao | null> {
  try {
    const { data, error } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) {
      logger.warn("[ai/agents] não consegui ler o provedor da organização", {
        organization_id: organizationId,
        motivo: error.message,
      });
      return null;
    }
    return ((data?.settings as { llm?: LlmDaOrganizacao } | null)?.llm ?? null) as
      | LlmDaOrganizacao
      | null;
  } catch (erro) {
    logger.warn("[ai/agents] falha ao ler o provedor da organização", {
      organization_id: organizationId,
      motivo: erro instanceof Error ? erro.name : typeof erro,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "ai_agents",
    role: "manager",
    escrita: false,
  });
  if (!authz.ok) return authz.response;

  const includeArchived = req.nextUrl.searchParams.get("include_archived") === "true";

  try {
    return ok(
      await listarAgentes(
        {
          supabase: authz.supabase,
          admin: createAdminClient(),
          organizationId: authz.organizationId,
          actor: authz.actor,
          responsavel: pessoaResponsavel(authz),
          requestId,
        },
        { incluirArquivados: includeArchived },
      ),
      { requestId },
    );
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

// ---------------------------------------------------------------------------
// POST — create
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "ai_agents",
    role: "admin",
    escrita: true,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);
  // `created_by` tem FK em auth.users: pessoa da sessão ou dono da chave (nunca o id do token).
  const responsavel = pessoaResponsavel(authz);
  if (!responsavel) return fail("forbidden", t("Não foi possível identificar quem responde por esta chave."), 403, { requestId });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const wantsMcp =
    typeof rawBody === "object" &&
    rawBody !== null &&
    ("version" in rawBody || (rawBody as { kind?: unknown }).kind === "mcp_agent");

  const admin = createAdminClient();
  const deps = {
    supabase: authz.supabase,
    admin,
    organizationId: authz.organizationId,
    actor: authz.actor,
    responsavel,
    requestId,
  };

  if (wantsMcp) {
    // Agente `mcp_agent` + versão 1 em rascunho: o efeito vive em `lib/ai/agents/administracao.ts`
    // (o MESMO das tools MCP) e roda UMA vez por `Idempotency-Key`.
    try {
      return await criarComChaveOpcional(req, authz, {
        requestId,
        endpoint: "/api/v1/ai/agents",
        corpo: rawBody,
        t,
        executar: () => criarAgenteMcp(deps, rawBody),
      });
    } catch (err) {
      return respostaDeRecusa(err, requestId);
    }
  }

  // Dois formatos de corpo, UM caminho de escrita (issue #1357).
  //
  // O corpo legado — sem `version` — gravava `kind='rag_bot'` direto em
  // `ai_agents`, sem NENHUMA linha em `ai_agent_versions`. Era o formato que só
  // o editor antigo abria, e que os dois runtimes atuais nem enxergam: o
  // dispatcher do CRM e o agent-engine resolvem o agente por
  // `join ai_agent_versions v on v.id = a.published_version_id`
  // (`lib/agent-engine/agent/agent-config.ts:252`) — o agente nascia mudo, e a
  // única saída era a recuperação legada da tela. Ele agora deriva o payload de
  // versão a partir do próprio corpo e cai no MESMO caminho de quem já manda
  // `version` (`criarAgenteMcp`): criar passa a rascunhar v1, como fazem a tela e o onboarding.
  const parseLegado = agentCreateSchema.safeParse(rawBody);
  if (!parseLegado.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parseLegado.error.flatten(),
    });
  }

  // ═══ O PAR (PROVEDOR, MODELO) DESTE AGENTE — issue #2377 ═══
  //
  // O corpo legado pode OMITIR `model`, e até aqui omitir injetava
  // `anthropic/claude-sonnet-5` fixo. Agora o par sai do MESMO ponto único que
  // confere a execução (`lib/ai/par-provedor-modelo.ts`): o padrão da
  // organização quando ele se sustenta, a compatibilidade EXPLÍCITA do provedor
  // depois, o catálogo do provedor efetivo em seguida — e, sem par sustentável,
  // a criação é RECUSADA aqui, antes de qualquer insert.
  const par = await resolverParEfetivo({
    modeloInformado: parseLegado.data.model,
    llmDaOrganizacao: await lerLlmDaOrganizacao(admin, authz.organizationId),
    lerModeloDoCatalogo: async (provider) => {
      const escolha = await escolherModeloNoCatalogo(admin, provider);
      return escolha !== null && escolha.escolhido ? escolha.modelId : null;
    },
  });
  // O log estruturado da resolução: provedor, modelo, propósito e origem da
  // configuração — nunca chave, prompt, telefone ou conteúdo de conversa.
  logarResolucaoDeModelo(logger, {
    organization_id: authz.organizationId,
    purpose: "agent_turn",
    provider: par.provider,
    model: par.model,
    origem: par.ok ? par.origem : "sem_par_sustentavel",
    ...(par.ok ? {} : { motivo: par.motivo }),
  });
  if (!par.ok) {
    // A frase da recusa é LITERAL — chave montada em runtime não entra em
    // dicionário nenhum e o `t()` com template é reprovado por
    // `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`.
    return fail(
      "validation_failed",
      `${t("Não foi possível definir o provedor e o modelo deste agente.")} ${par.motivo}. Nada foi criado.`,
      422,
      { requestId },
    );
  }
  const corpo = corpoLegadoComoCorpoDeCriacao({
    ...parseLegado.data,
    // O par vai INTEIRO (`provedor/modelo`): a ponte do legado reparte na
    // primeira barra.
    model: `${par.provider}/${par.model}`,
  });

  // O contrato de resposta do corpo legado se mantém: ele pedia a LINHA do
  // agente e continua recebendo-a (agora com `kind = "mcp_agent"`; a v1 nasce
  // RASCUNHO, então `published_version_id` fica null até publicar).
  try {
    const criado = await criarAgenteMcp(deps, corpo, { formato: "legado" });
    return ok(criado.agent, { status: 201, requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
