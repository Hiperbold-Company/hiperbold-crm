/**
 * ADMINISTRAR os funis pela API — listar, criar, editar (nome, descrição, ordem, padrão, funil de clientes,
 * tirar do arquivo) e arquivar/excluir.
 *
 * Quem chama: as rotas `/api/v1/pipelines` e `/api/v1/pipelines/[id]` (sessão OU token `dsk_…`) e as tools MCP
 * de administração (`lib/mcp/tools/administracao-funis.ts`). As regras puras (nome, posição, padrão,
 * arquivamento) vivem em `lib/pipelines/pipeline-editing.ts`; aqui estão a ORDEM das escritas, que é o que os
 * índices únicos de padrão e de slug cobram, e a tradução das recusas.
 *
 * ⚠️ A AUTORIZAÇÃO NÃO MORA AQUI. Cada porta confere `manager` + `mcp:write` (o piso da tela) e entrega a
 * organização já resolvida. O cliente de uma chave é service role e BYPASSA a RLS: toda leitura e escrita leva
 * `organization_id` explícito, e funil de outra organização responde 404 (dizer "existe, mas não é seu" vaza a
 * existência).
 *
 * ⚠️ APAGAR ARQUIVA POR PADRÃO (`definitivo` é o caso honesto do "criei sem querer": sem negócio, sem formulário,
 * sem automação apontando) — `webhook_sources.default_pipeline_id` é `ON DELETE CASCADE` e apagar o funil
 * apagaria a fonte de captação do cliente em silêncio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor } from "@/lib/api/handlers/types";
import { MENSAGEM_DE_FALHA_INTERNA } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { recusaDoPlano, STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import { logger } from "@/lib/logger";
import {
  ETAPAS_INICIAIS,
  podeExcluirDeVez,
  posicaoEntre,
  slugDeFunil,
  updatesDeMarcaExclusiva,
  updatesDePadrao,
  validarArquivamento,
  validarNomeDeFunil,
  type DependenciasDoFunil,
  type FunilEditavel,
  type RegraDeAutomacao,
  regrasQueApontamPara,
} from "@/lib/pipelines/pipeline-editing";

export interface DepsDeFunis {
  supabase: SupabaseClient;
  organizationId: string;
  actor: Actor;
  requestId: string;
  t?: (texto: string) => string;
}

const tr = (deps: DepsDeFunis) => deps.t ?? ((texto: string) => texto);

function recusa(
  deps: DepsDeFunis,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError(status, code, details, deps.requestId, message);
}

function falhaInterna(deps: DepsDeFunis, erro: unknown): ApiError {
  const causa =
    erro instanceof Error
      ? erro.message
      : erro && typeof erro === "object" && typeof (erro as { message?: unknown }).message === "string"
        ? (erro as { message: string }).message
        : "desconhecido";
  logger.error("api.falha_interna", { code: "internal_error", request_id: deps.requestId, causa });
  return recusa(deps, 500, "internal_error", MENSAGEM_DE_FALHA_INTERNA);
}

/**
 * Recusa do banco traduzida — ou `null` se o erro não é de conflito. Cobre `23505`, o conflito que dois funis
 * editados em duas abas produzem (slug repetido, ou dois padrões ao mesmo tempo).
 */
function conflitoDoFunil(deps: DepsDeFunis, erro: { code?: string } | null | undefined, nomeDoFunil: string): ApiError | null {
  if (erro?.code !== "23505") return null;
  return recusa(
    deps,
    409,
    "state_conflict",
    `«${nomeDoFunil}» mudou enquanto você editava — outro funil já ocupa esse nome ou o lugar de padrão. ` +
      `Recarregue a página e tente de novo.`,
  );
}

/** O PT402 do gatilho de plano, reconhecido pelo `code`, nunca pelo texto do Postgres. */
function limiteDoPlano(deps: DepsDeFunis, erro: unknown): ApiError | null {
  const r = recusaDoPlano(erro as { code?: string; message?: string });
  return r ? recusa(deps, STATUS_RECUSA_DO_PLANO, "plano_limite_atingido", r.mensagem) : null;
}

// ---------------------------------------------------------------------------
// leitura (o recorte que as regras pedem: TODOS os funis, arquivados inclusive)
// ---------------------------------------------------------------------------

const COLUNAS = "id, name, slug, description, position, is_default, is_client_pipeline, is_archived";

export async function lerFunisDaOrganizacao(deps: DepsDeFunis): Promise<FunilEditavel[]> {
  const { data, error } = await deps.supabase
    .from("crm_pipelines")
    .select(COLUNAS)
    .eq("organization_id", deps.organizationId)
    .order("position", { ascending: true });
  if (error) throw recusa(deps, 500, "internal_error", error.message);
  return (data ?? []) as unknown as FunilEditavel[];
}

async function lerDependenciasDoFunil(deps: DepsDeFunis, pipelineId: string): Promise<DependenciasDoFunil> {
  const { count, error: leadsErr } = await deps.supabase
    .from("crm_leads")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", deps.organizationId)
    .eq("pipeline_id", pipelineId);
  if (leadsErr) throw recusa(deps, 500, "internal_error", leadsErr.message);

  const { data: fontes, error: fontesErr } = await deps.supabase
    .from("webhook_sources")
    .select("name")
    .eq("organization_id", deps.organizationId)
    .eq("default_pipeline_id", pipelineId);
  if (fontesErr) throw recusa(deps, 500, "internal_error", fontesErr.message);

  const { data: regras, error: regrasErr } = await deps.supabase
    .from("automation_rules")
    .select("name, is_active, actions")
    .eq("organization_id", deps.organizationId);
  if (regrasErr) throw recusa(deps, 500, "internal_error", regrasErr.message);

  return {
    negocios: count ?? 0,
    fontesDeWebhook: ((fontes ?? []) as Array<{ name: string }>).map((f) => f.name),
    regrasAtivas: regrasQueApontamPara((regras ?? []) as RegraDeAutomacao[], pipelineId),
  };
}

/** Um funil como a tela o desenha — a MESMA forma para o vivo e para o arquivado. */
export interface FunilDoCorpo {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  position: number;
  is_default: boolean;
  is_client_pipeline: boolean;
}

function paraATela(f: FunilEditavel): FunilDoCorpo {
  return {
    id: f.id,
    name: f.name,
    slug: f.slug,
    description: f.description ?? null,
    position: f.position,
    is_default: f.is_default,
    // `?? false` e não `!`: um clone que ainda não aplicou a 0262 devolve `undefined`.
    is_client_pipeline: f.is_client_pipeline ?? false,
  };
}

/** Os vivos na ordem da lista, e os arquivados À PARTE (misturá-los poria destino que não existe nos seletores). */
export function corpoDosFunis(funis: FunilEditavel[]): { pipelines: FunilDoCorpo[]; arquivados: FunilDoCorpo[] } {
  return {
    pipelines: funis.filter((f) => !f.is_archived).map(paraATela),
    arquivados: funis.filter((f) => f.is_archived).map(paraATela),
  };
}

// ---------------------------------------------------------------------------
// criar
// ---------------------------------------------------------------------------

export interface NovoFunil {
  name: string;
  description?: string | null;
}

/** As etapas com que o funil nasce, já com a régua de posição do board. */
function etapasIniciais(orgId: string, pipelineId: string) {
  return ETAPAS_INICIAIS.map((etapa, i) => ({
    organization_id: orgId,
    pipeline_id: pipelineId,
    name: etapa.name,
    slug: etapa.slug,
    position: (i + 1) * 1000,
    is_won: etapa.is_won,
    is_lost: etapa.is_lost,
  }));
}

/** Cria o funil COM as etapas com que ele nasce. O primeiro funil ativo da organização nasce padrão. */
export async function criarFunil(deps: DepsDeFunis, entrada: NovoFunil) {
  const orgId = deps.organizationId;
  const name = entrada.name.trim();
  const description = entrada.description?.trim() || null;

  const funis = await lerFunisDaOrganizacao(deps);

  // ⚠️ VALIDAR ANTES DE TOCAR O BANCO: um 23505 cru não diz QUAL funil já tem esse nome.
  const veredito = validarNomeDeFunil(name, funis, null);
  if (!veredito.ok) throw recusa(deps, 422, "unprocessable_entity", veredito.erro);

  const row = {
    organization_id: orgId,
    name,
    description,
    // Arquivados entram na conta do slug: `uniq_crm_pipelines_org_slug` não é parcial.
    slug: slugDeFunil(name, funis.map((f) => f.slug)),
    // No fim da lista: funil novo no meio seria a tela decidindo por quem criou.
    position: posicaoEntre(funis[funis.length - 1]?.position ?? null, null),
    // ⚠️ O PRIMEIRO FUNIL DA ORGANIZAÇÃO NASCE PADRÃO (sem padrão, lead criado sem funil não tem para onde ir).
    is_default: funis.filter((f) => !f.is_archived).length === 0,
  };

  const { data: criado, error } = await deps.supabase.from("crm_pipelines").insert(row).select("id").single();
  if (error) {
    // O gatilho de plano recusa ANTES do conflito de nome (mesma ordem do banco).
    const plano = limiteDoPlano(deps, error);
    if (plano) throw plano;
    const conflito = conflitoDoFunil(deps, error as { code?: string }, name);
    if (conflito) throw conflito;
    throw falhaInterna(deps, error);
  }
  const pipelineId = (criado as { id: string }).id;

  const { error: etapasErr } = await deps.supabase.from("crm_stages").insert(etapasIniciais(orgId, pipelineId));

  // ⚠️ COMPENSAÇÃO, PORQUE SÃO DUAS ESCRITAS SEM TRANSAÇÃO: um funil sem etapa é quadro morto. O funil recém-criado
  // ainda não tem negócio, então `crm_leads_pipeline_id_fkey ON DELETE RESTRICT` não atrapalha o desfazimento.
  if (etapasErr) {
    await deps.supabase.from("crm_pipelines").delete().eq("id", pipelineId).eq("organization_id", orgId);
    const plano = limiteDoPlano(deps, etapasErr);
    if (plano) throw plano;
    throw recusa(
      deps,
      500,
      "internal_error",
      `Não consegui criar as etapas de «${name}». Nada foi salvo — tente de novo.`,
      { erro: etapasErr.message },
    );
  }

  void audit({
    action: "pipeline.created",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: orgId,
    resourceType: "crm_pipeline",
    resourceId: pipelineId,
    requestId: deps.requestId,
    metadata: { name, slug: row.slug, is_default: row.is_default },
  });

  // Relê em vez de espelhar o que foi pedido: a tela mostra o que o banco tem.
  return corpoDosFunis(await lerFunisDaOrganizacao(deps));
}

// ---------------------------------------------------------------------------
// editar
// ---------------------------------------------------------------------------

export interface PedidoDeEdicaoDeFunil {
  name?: string;
  description?: string | null;
  is_default?: boolean;
  is_client_pipeline?: boolean;
  is_archived?: boolean;
  /** O vizinho DE CIMA (`null` = primeiro da lista), não um número de posição. */
  depois_de?: string | null;
}

type PatchDoFunil = {
  name?: string;
  description?: string | null;
  position?: number;
  is_default?: boolean;
  is_client_pipeline?: boolean;
  is_archived?: boolean;
};

export async function editarFunil(deps: DepsDeFunis, pipelineId: string, pedido: PedidoDeEdicaoDeFunil) {
  const t = tr(deps);
  const orgId = deps.organizationId;
  const funis = await lerFunisDaOrganizacao(deps);

  // Funil de outra org morre AQUI, antes de qualquer escrita: não está nesta lista.
  const alvo = funis.find((f) => f.id === pipelineId);
  if (!alvo) throw recusa(deps, 404, "not_found", t("Funil não encontrado."));

  // ⚠️ ARQUIVAR É DO `excluirOuArquivarFunil`, NÃO DAQUI — ele conta as dependências antes.
  if (pedido.is_archived === true) {
    throw recusa(
      deps,
      422,
      "unprocessable_entity",
      `Para arquivar «${alvo.name}», use a opção Arquivar da lista de funis — ela confere antes se algum ` +
        `formulário ou automação ainda manda negócio para ele. Por aqui só dá para tirar do arquivo.`,
    );
  }

  // ⚠️ ARQUIVADO NÃO SE EDITA — a única exceção é tirá-lo do arquivo, e só se for isso sozinho (#979).
  const soTiraDoArquivo = pedido.is_archived === false && Object.keys(pedido).length === 1;
  if (alvo.is_archived && !soTiraDoArquivo) {
    throw recusa(
      deps,
      409,
      "state_conflict",
      `O funil «${alvo.name}» está arquivado e não está mais na sua lista. Tire-o do arquivo antes de editar.`,
    );
  }

  if (pedido.name !== undefined) {
    const veredito = validarNomeDeFunil(pedido.name, funis, pipelineId);
    if (!veredito.ok) throw recusa(deps, 422, "unprocessable_entity", veredito.erro);
  }

  // ⚠️ O PADRÃO SE MUDA, NÃO SE APAGA: sem funil padrão, todo lead criado sem funil escolhido fica sem destino.
  if (pedido.is_default === false) {
    throw recusa(
      deps,
      422,
      "unprocessable_entity",
      `«${alvo.name}» é o funil padrão e a organização precisa de um. Marque OUTRO funil como padrão — ` +
        `o padrão se muda, não se apaga.`,
    );
  }

  const patchDoAlvo: PatchDoFunil = {};
  if (pedido.name !== undefined) patchDoAlvo.name = pedido.name.trim();
  if (pedido.description !== undefined) patchDoAlvo.description = pedido.description?.trim() || null;

  // Tirar do arquivo é update SIMPLES. Pedir de novo em quem já está fora é pedido já atendido (sem linha de audit vazia).
  const tiraDoArquivo = pedido.is_archived === false && alvo.is_archived;
  if (tiraDoArquivo) patchDoAlvo.is_archived = false;

  if (pedido.depois_de !== undefined) {
    // Só os ativos compõem a régua: arquivado não ocupa lugar na lista.
    const ativos = funis.filter((f) => !f.is_archived && f.id !== pipelineId);
    const i = pedido.depois_de === null ? -1 : ativos.findIndex((f) => f.id === pedido.depois_de);
    if (pedido.depois_de !== null && i < 0) {
      throw recusa(
        deps,
        422,
        "unprocessable_entity",
        t("O funil que você escolheu como vizinho não está mais na lista. Recarregue a página."),
      );
    }
    const posicao = posicaoEntre(ativos[i]?.position ?? null, ativos[i + 1]?.position ?? null);
    // `posicaoEntre` devolve NaN com vizinhos de MESMA posição; NaN vira null no JSON e a coluna é NOT NULL.
    if (!Number.isFinite(posicao)) {
      throw recusa(
        deps,
        409,
        "state_conflict",
        t("Os funis desta lista estão empatados na ordenação. Recarregue a página e mova o funil para outro lugar."),
      );
    }
    patchDoAlvo.position = posicao;
  }

  // Eleger padrão pode exigir DOIS updates (liberar o antigo, ocupar o lugar).
  const updates: Array<{ pipelineId: string; patch: PatchDoFunil }> =
    pedido.is_default === true
      ? updatesDePadrao(funis, pipelineId)
      : pedido.is_client_pipeline === true
        ? updatesDeMarcaExclusiva(funis, pipelineId, "is_client_pipeline")
        : [];

  // Desligar a marca de funil de clientes é update SIMPLES (diferente de `is_default: false`, que é recusado).
  if (pedido.is_client_pipeline === false) patchDoAlvo.is_client_pipeline = false;
  if (Object.keys(patchDoAlvo).length > 0) {
    const i = updates.findIndex((u) => u.pipelineId === pipelineId);
    if (i >= 0) updates[i] = { pipelineId, patch: { ...updates[i]!.patch, ...patchDoAlvo } };
    else updates.push({ pipelineId, patch: patchDoAlvo });
  }

  // ⚠️ EM SEQUÊNCIA, NA ORDEM QUE `updatesDePadrao` DEVOLVE: `uniq_crm_pipelines_org_default` é imediato.
  for (const u of updates) {
    const { error } = await deps.supabase
      .from("crm_pipelines")
      .update(u.patch)
      .eq("id", u.pipelineId)
      .eq("organization_id", orgId);
    if (!error) continue;

    // Este update é o único ponto que pode desarquivar, e desarquivar conta contra o teto de funis.
    const plano = limiteDoPlano(deps, error);
    if (plano) throw plano;
    const nome = funis.find((f) => f.id === u.pipelineId)?.name ?? alvo.name;
    const conflito = conflitoDoFunil(deps, error as { code?: string }, nome);
    if (conflito) throw conflito;
    throw falhaInterna(deps, error);
  }

  if (updates.length > 0) {
    void audit({
      // Tirar do arquivo tem código PRÓPRIO, espelhando o `pipeline.archived` do arquivamento.
      action: tiraDoArquivo ? "pipeline.unarchived" : "pipeline.updated",
      ...colunasDeAtorNoAudit(deps.actor),
      organizationId: orgId,
      resourceType: "crm_pipeline",
      resourceId: pipelineId,
      requestId: deps.requestId,
      metadata: { pedido, updates },
    });
  }
  return corpoDosFunis(await lerFunisDaOrganizacao(deps));
}

// ---------------------------------------------------------------------------
// arquivar / excluir
// ---------------------------------------------------------------------------

/** Arquiva (padrão) ou, com `definitivo`, exclui só o caso limpo. A recusa leva a contagem em `details`. */
export async function excluirOuArquivarFunil(deps: DepsDeFunis, pipelineId: string, opts: { definitivo: boolean }) {
  const orgId = deps.organizationId;
  const funis = await lerFunisDaOrganizacao(deps);
  const alvo = funis.find((f) => f.id === pipelineId);
  if (!alvo) throw recusa(deps, 404, "not_found", tr(deps)("Funil não encontrado."));

  const dependencias = await lerDependenciasDoFunil(deps, pipelineId);
  const veredito = opts.definitivo
    ? podeExcluirDeVez(funis, pipelineId, dependencias)
    : validarArquivamento(funis, pipelineId, dependencias);
  if (!veredito.ok) {
    // A CONTAGEM VAI EM `details`, não só dentro da frase: a tela mostra "este funil tem N negócios" sem regex.
    throw recusa(deps, 422, "unprocessable_entity", veredito.erro, {
      negocios: dependencias.negocios,
      fontes_de_webhook: dependencias.fontesDeWebhook,
      automacoes: dependencias.regrasAtivas,
    });
  }

  const { error } = opts.definitivo
    ? await deps.supabase.from("crm_pipelines").delete().eq("id", pipelineId).eq("organization_id", orgId)
    : await deps.supabase.from("crm_pipelines").update({ is_archived: true }).eq("id", pipelineId).eq("organization_id", orgId);
  if (error) {
    const conflito = conflitoDoFunil(deps, error as { code?: string }, alvo.name);
    if (conflito) throw conflito;
    throw falhaInterna(deps, error);
  }

  void audit({
    action: opts.definitivo ? "pipeline.deleted" : "pipeline.archived",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: orgId,
    resourceType: "crm_pipeline",
    resourceId: pipelineId,
    requestId: deps.requestId,
    metadata: { name: alvo.name, slug: alvo.slug, negocios: dependencias.negocios },
  });
  return corpoDosFunis(await lerFunisDaOrganizacao(deps));
}
