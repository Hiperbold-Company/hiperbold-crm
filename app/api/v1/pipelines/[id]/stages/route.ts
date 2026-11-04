import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/pipelines/[id]/stages — cria uma etapa no fim do funil.
 *
 * Até a tela de etapas existir, NENHUMA superfície criava etapa: o gatilho
 * `trg_seed_default_pipeline_for_org` semeia um funil de e-commerce em toda
 * organização nova, então uma clínica abre o sistema e vê "Carrinho abandonado"
 * sem ter como corrigir.
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. A operação inteira vive em
 * `lib/leads/stage-operations.ts` porque o agente de IA também organiza o funil
 * (BRIEFING §3, Decisão 4): duas superfícies escrevendo na mesma tabela por
 * caminhos diferentes fariam o sistema mentir para uma das duas.
 *
 * Auth: sessão por cookie, papel manager+ (é configuração do funil, não trabalho
 * de card). `organization_id` sai do JWT — nunca do body. O client é o do
 * usuário, então a RLS vale; o filtro explícito é a convenção do repo e a rede
 * que sobra se a policy mudar.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { autorizarAdministracao, traducaoDe } from "@/lib/api/auth-dual-admin";
import { corDaEtapaSchema } from "@/lib/leads/stage-cor";
import { criarEtapa } from "@/lib/leads/stage-operations";
import { anexaFluxos, carregaFluxosPorEtapa } from "@/lib/followup/fluxos-da-etapa";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// `.max(80)`: o nome é o topo de uma coluna do quadro, não um parágrafo. O banco
// não limita, mas a tela quebra muito antes disso.
//
// `expected_duration_hours` é opcional e aceita `null`: uma etapa nasce sem
// janela configurada e o radar cai no padrão de 24 h/72 h. 1 a 8760 inteiro
// (uma hora a um ano) — a coluna é `numeric` sem CHECK, então este Zod é a
// primeira rede (a migration com CHECK ficou fora deste escopo, #1532).
const bodySchema = z
  .object({
    name: z.string().min(1).max(80),
    /** Cor da coluna, `#RRGGBB`. Ausente = cor padrão da tela. */
    color: corDaEtapaSchema.nullable().optional(),
    expected_duration_hours: z.number().int().min(1).max(8760).nullable().optional(),
  })
  .strict();

/**
 * GET — as etapas vivas do funil, na ordem do quadro.
 *
 * Existia criação de etapa e nenhuma LEITURA: quem precisava oferecer "escolha
 * a etapa" numa tela (a campanha, agora) não tinha de onde tirar a lista, e a
 * saída seria cada tela consultar o banco por conta própria — duas réguas para
 * "quais etapas existem", que divergem no primeiro arquivamento.
 *
 * Ganho e perda entram: quem escolhe etapa para FILTRAR público quer poder
 * dizer "quem está em Perdido". Quem escolhe etapa de NASCIMENTO é recusado
 * antes, pela regra de que card não nasce fechado.
 */
export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  // Sessão OU token (`role:manager`+, `mcp:read`) — a org do token vem da linha dele.
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "pipeline_stages",
    role: "manager",
    escrita: false,
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);
  const { id } = await ctx.params;

  const supabase = authz.supabase;
  // Funil de OUTRA organização (ou inexistente) é 404, e não uma lista vazia 200: a lista vazia
  // confirmaria que o id existe e escondia o erro de quem passou o id errado.
  const { data: funil } = await supabase
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", authz.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (!funil) return fail("not_found", t("Funil não encontrado."), 404, { requestId });

  const { data, error } = await supabase
    .from("crm_stages")
    // A janela de esfriando, a chance de fechamento e o aviso de equipe entram
    // na leitura como as demais colunas de configuração (issue #2999); a cor é da Hiperbold.
    .select(
      "id, name, position, is_won, is_lost, color, expected_duration_hours, win_probability, avisar_na_central",
    )
    .eq("organization_id", authz.organizationId)
    .eq("pipeline_id", id)
    .eq("is_archived", false)
    .order("position", { ascending: true });
  if (error) return fail("internal_error", t("Falha ao listar etapas."), 500, { requestId });

  // #3603 — a lista read-only de «quais fluxos disparam ao entrar nesta etapa».
  // Nenhuma consulta por etapa, e as MESMAS portas do motor
  // (`lib/followup/fluxos-da-etapa.ts`). Se esta leitura falhar, a resposta sai
  // SEM o campo — a tela então não afirma nem "tem" nem "não tem" —, em vez de
  // derrubar uma listagem de etapas que já foi lida com sucesso.
  let fluxos: Awaited<ReturnType<typeof carregaFluxosPorEtapa>> | null = null;
  try {
    fluxos = await carregaFluxosPorEtapa(supabase, authz.organizationId);
  } catch {
    fluxos = null;
  }

  return ok(anexaFluxos((data ?? []) as Array<{ id: string }>, fluxos), { requestId });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await autorizarAdministracao(req, {
    requestId,
    resource: "crm_stages",
    role: "manager",
    escrita: true,
    permissao: "funis.editar",
  });
  if (!authz.ok) return authz.response;
  const t = traducaoDe(authz);

  const { id: pipelineId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Dê um nome à etapa — é o que aparece no topo da coluna."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = authz.supabase;
  try {
    const { funil } = await criarEtapa(
      {
        supabase,
        organizationId: authz.organizationId,
        actor: authz.actor,
        requestId,
      },
      {
        pipelineId,
        nome: parsed.data.name,
        cor: parsed.data.color,
        // Só quando veio pedido: a chave ausente é o comportamento de hoje.
        ...(parsed.data.expected_duration_hours !== undefined
          ? { expected_duration_hours: parsed.data.expected_duration_hours }
          : {}),
      },
    );
    return ok(funil, { status: 201, requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
