/**
 * DUPLICAR UM FUNIL — o funil inteiro com a configuração, para o cliente que abre um funil por edição
 * ("PMA 2027" → "PMA 2028") não refazer etapas, motivos e campos à mão.
 *
 * Quem chama: `POST /api/v1/pipelines/[id]/duplicate`. A autorização (manager+, suporte) e a organização
 * resolvida chegam prontas; aqui toda leitura e escrita leva `organization_id` explícito, e funil de outra
 * organização responde 404 (o mesmo contrato de `lib/pipelines/administracao.ts`).
 *
 * O QUE VAI: o funil (`description`, `vocabulary`, `settings` INTEIRO) e as etapas NÃO arquivadas, na mesma
 * ordem. O que NÃO vai: negócios, automações, follow-ups, formulários, campanhas, regras do Google Ads e o
 * escopo de agentes — tudo isso aponta para o funil de origem e continua apontando.
 *
 * ⚠️ OS IDS DE ETAPA DENTRO DE `settings` SÃO TROCADOS PERCORRENDO O JSON INTEIRO, não por chave conhecida.
 * `fields[].obrigatorio_em.etapas` e o que vier depois guardam id de etapa da origem; uma lista de chaves
 * envelheceria na primeira chave nova. Toda string igual a um id de etapa da origem vira o id da etapa nova.
 * A que apontava para etapa ARQUIVADA (que não é copiada) sai: do array, ou a chave do objeto — e, se o schema
 * do settings EXIGE aquela chave, ela fica `null` em vez de sumir (`ajustarAoSchema`). O id do próprio funil de
 * origem também vira o do novo: autorreferência continua autorreferência.
 *
 * ⚠️ SEM TRANSAÇÃO, COM COMPENSAÇÃO (como `criarFunil`): insere o funil, insere as etapas em lote, grava o
 * `settings` remapeado. Se qualquer passo falhar, o funil criado é apagado — `crm_stages.pipeline_id` cascateia
 * e o funil recém-nascido ainda não tem negócio para o `ON DELETE RESTRICT` de `crm_leads` recusar.
 */
import type { ZodType } from "zod";

import { ApiError } from "@/lib/api/types";
import { MENSAGEM_DE_FALHA_INTERNA } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { recusaDoPlano, STATUS_RECUSA_DO_PLANO } from "@/lib/billing/planos/recusa-do-plano";
import { logger } from "@/lib/logger";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";
import { lerFunisDaOrganizacao, type DepsDeFunis } from "@/lib/pipelines/administracao";
import { posicaoEntre, slugDeFunil, validarNomeDeFunil } from "@/lib/pipelines/pipeline-editing";
import { pipelineConfigPatchSchema } from "@/lib/schemas/settings";

/**
 * Cada coluna de `crm_stages`, classificada. A cópia escreve SÓ `COPIA`; o resto é decidido aqui.
 *
 * ⚠️ `tests/unit/duplicar-funil-colunas.test.ts` lê o DDL de `crm_stages` no `baseline.sql` (CREATE + os
 * `add column` do apêndice) e reprova coluna que não esteja em nenhuma das duas listas. Coluna nova é uma
 * decisão: configuração da etapa vai para `COPIA` (senão a cópia nasce com o default do banco), estado ou
 * identidade vai para `NAO_COPIA`.
 */
export const COLUNAS_DA_ETAPA = {
  COPIA: [
    "name",
    "slug",
    "description",
    "position",
    "color",
    "is_won",
    "is_lost",
    "expected_duration_hours",
    "requires_human",
    "agent_stage_hint",
    "win_probability",
    "avisar_na_central",
  ],
  NAO_COPIA: [
    "id",
    "organization_id", // a da sessão, nunca a da linha
    "pipeline_id", // o funil novo
    "is_archived", // só as vivas são copiadas, e nascem vivas
    "last_change_actor_kind", // recebe a autoria de quem duplicou
    "last_change_at",
    "created_at",
    "updated_at",
  ],
} as const;

type EtapaDaOrigem = Record<(typeof COLUNAS_DA_ETAPA.COPIA)[number], unknown> & {
  id: string;
  slug: string;
  is_archived: boolean;
};

export interface EtapaDuplicada {
  id: string;
  name: string;
  slug: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
}

export interface FunilDuplicado {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  position: number;
  is_default: boolean;
  is_client_pipeline: boolean;
  vocabulary: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  stages: EtapaDuplicada[];
}

const REMOVER = Symbol("remover");

/** Caminho no JSON (chaves de objeto e índices de array). */
export type CaminhoNoJson = Array<string | number>;

/**
 * Troca, em qualquer profundidade, toda string que é chave de `troca` pelo valor; a que está em `remover` sai
 * (do array, ou a chave do objeto). Pura: não muta a entrada. Devolve também os caminhos das CHAVES de objeto
 * removidas, para `ajustarAoSchema` decidir se alguma era obrigatória.
 */
export function remapearIds(
  valor: unknown,
  troca: ReadonlyMap<string, string>,
  remover: ReadonlySet<string> = new Set(),
): { valor: unknown; chavesRemovidas: CaminhoNoJson[] } {
  const chavesRemovidas: CaminhoNoJson[] = [];
  const visita = (v: unknown, caminho: CaminhoNoJson): unknown => {
    if (typeof v === "string") {
      if (remover.has(v)) return REMOVER;
      return troca.get(v) ?? v;
    }
    if (Array.isArray(v)) {
      const saida: unknown[] = [];
      for (const filho of v) {
        const novo = visita(filho, [...caminho, saida.length]);
        if (novo !== REMOVER) saida.push(novo);
      }
      return saida;
    }
    if (v && typeof v === "object") {
      const saida: Record<string, unknown> = {};
      for (const [k, filho] of Object.entries(v as Record<string, unknown>)) {
        const novo = visita(filho, [...caminho, k]);
        if (novo === REMOVER) chavesRemovidas.push([...caminho, k]);
        else saida[k] = novo;
      }
      return saida;
    }
    return v;
  };
  const r = visita(valor, []);
  return { valor: r === REMOVER ? null : r, chavesRemovidas };
}

const mesmoCaminho = (a: ReadonlyArray<PropertyKey>, b: CaminhoNoJson) =>
  a.length === b.length && a.every((x, i) => String(x) === String(b[i]));

/**
 * A chave removida que o schema EXIGE volta como `null`. Só reage a erro de schema NO CAMINHO de uma chave
 * removida: um settings legado que já falhava por outro motivo não é "consertado" aqui, nem quebra a cópia.
 */
export function ajustarAoSchema(
  settings: Record<string, unknown>,
  chavesRemovidas: CaminhoNoJson[],
  schema: ZodType = pipelineConfigPatchSchema,
): Record<string, unknown> {
  if (chavesRemovidas.length === 0) return settings;
  const r = schema.safeParse(settings);
  if (r.success) return settings;
  const exigidas = chavesRemovidas.filter((c) => r.error.issues.some((i) => mesmoCaminho(i.path, c)));
  if (exigidas.length === 0) return settings;
  const copia = structuredClone(settings);
  for (const caminho of exigidas) {
    let alvo: unknown = copia;
    for (const passo of caminho.slice(0, -1)) alvo = (alvo as Record<string | number, unknown>)[passo];
    if (alvo && typeof alvo === "object") (alvo as Record<string | number, unknown>)[caminho[caminho.length - 1]!] = null;
  }
  return copia;
}

function recusa(deps: DepsDeFunis, status: number, code: string, message: string): ApiError {
  return new ApiError(status, code, undefined, deps.requestId, message);
}

function falhaInterna(deps: DepsDeFunis, onde: string, erro: unknown): ApiError {
  const causa =
    erro && typeof erro === "object" && typeof (erro as { message?: unknown }).message === "string"
      ? (erro as { message: string }).message
      : "desconhecido";
  logger.error("api.falha_interna", { code: "internal_error", request_id: deps.requestId, onde, causa });
  return recusa(deps, 500, "internal_error", MENSAGEM_DE_FALHA_INTERNA);
}

/** O PT402 dos gatilhos de plano (teto de funis, teto de etapas por funil), pelo `code`, nunca pelo texto. */
function limiteDoPlano(deps: DepsDeFunis, erro: unknown): ApiError | null {
  const r = recusaDoPlano(erro as { code?: string; message?: string });
  return r ? recusa(deps, STATUS_RECUSA_DO_PLANO, "plano_limite_atingido", r.mensagem) : null;
}

const COLUNAS_DA_ORIGEM = "id, description, position, vocabulary, settings";
const COLUNAS_DA_RESPOSTA_DA_ETAPA = "id, name, slug, position, is_won, is_lost";

export async function duplicarFunil(
  deps: DepsDeFunis,
  origemId: string,
  entrada: { name: string },
): Promise<FunilDuplicado> {
  const t = deps.t ?? ((texto: string) => texto);
  const orgId = deps.organizationId;
  const name = entrada.name.trim();

  const funis = await lerFunisDaOrganizacao(deps);
  // Funil de outra organização morre aqui, antes de qualquer escrita: não está nesta lista.
  const origemNaLista = funis.find((f) => f.id === origemId);
  if (!origemNaLista) throw recusa(deps, 404, "not_found", t("Funil não encontrado."));
  if (origemNaLista.is_archived) {
    throw recusa(
      deps,
      409,
      "state_conflict",
      t("Este funil está arquivado. Tire-o do arquivo antes de duplicar, ou escolha outro funil de origem."),
    );
  }

  const veredito = validarNomeDeFunil(name, funis, null);
  if (!veredito.ok) throw recusa(deps, 422, "unprocessable_entity", veredito.erro);

  const { data: origem, error: origemErr } = await deps.supabase
    .from("crm_pipelines")
    .select(COLUNAS_DA_ORIGEM)
    .eq("organization_id", orgId)
    .eq("id", origemId)
    .maybeSingle();
  if (origemErr) throw falhaInterna(deps, "ler_origem", origemErr);
  if (!origem) throw recusa(deps, 404, "not_found", t("Funil não encontrado."));
  const o = origem as unknown as {
    description: string | null;
    vocabulary: Record<string, unknown> | null;
    settings: Record<string, unknown> | null;
  };

  const { data: etapasLidas, error: etapasLidasErr } = await deps.supabase
    .from("crm_stages")
    .select(["id", "is_archived", ...COLUNAS_DA_ETAPA.COPIA].join(", "))
    .eq("organization_id", orgId)
    .eq("pipeline_id", origemId)
    .order("position", { ascending: true });
  if (etapasLidasErr) throw falhaInterna(deps, "ler_etapas", etapasLidasErr);
  const todas = (etapasLidas ?? []) as unknown as EtapaDaOrigem[];
  const vivas = todas.filter((e) => !e.is_archived);
  const arquivadas = new Set(todas.filter((e) => e.is_archived).map((e) => e.id));

  // Logo depois da origem, entre ela e o próximo funil vivo. Empate de posição (NaN) cai no fim da lista.
  const ativos = funis.filter((f) => !f.is_archived);
  const i = ativos.findIndex((f) => f.id === origemId);
  const entre = posicaoEntre(ativos[i]?.position ?? null, ativos[i + 1]?.position ?? null);
  const position = Number.isFinite(entre)
    ? entre
    : posicaoEntre(funis[funis.length - 1]?.position ?? null, null);

  const slug = slugDeFunil(name, funis.map((f) => f.slug));
  const description = o.description ?? null;
  const row: Record<string, unknown> = {
    organization_id: orgId,
    name,
    // Arquivados entram na conta do slug: `uniq_crm_pipelines_org_slug` não é parcial.
    slug,
    description,
    position,
    is_default: false,
    is_client_pipeline: false,
    is_archived: false,
  };
  // `vocabulary`/`settings` são NOT NULL com default: uma origem estranha não manda `null` para o banco.
  // O settings definitivo (com os ids remapeados) só existe depois das etapas; até lá vai o da origem.
  if (o.vocabulary != null) row.vocabulary = o.vocabulary;
  if (o.settings != null) row.settings = o.settings;

  const { data: criado, error: criadoErr } = await deps.supabase
    .from("crm_pipelines")
    .insert(row)
    .select("id")
    .single();
  if (criadoErr) {
    // O gatilho de plano recusa ANTES do conflito de nome (mesma ordem do banco).
    const plano = limiteDoPlano(deps, criadoErr);
    if (plano) throw plano;
    if ((criadoErr as { code?: string }).code === "23505") {
      throw recusa(
        deps,
        409,
        "state_conflict",
        t("Outro funil acabou de ocupar esse nome. Recarregue a página e tente de novo."),
      );
    }
    throw falhaInterna(deps, "inserir_funil", criadoErr);
  }
  const novoId = (criado as { id: string }).id;

  const desfazer = async () => {
    const { error } = await deps.supabase
      .from("crm_pipelines")
      .delete()
      .eq("id", novoId)
      .eq("organization_id", orgId);
    if (error) {
      logger.error("pipeline.duplicar.compensacao_falhou", { request_id: deps.requestId, novo_id: novoId });
    }
  };

  // `troca` começa com o próprio funil: autorreferência no settings continua autorreferência.
  const troca = new Map<string, string>([[origemId, novoId]]);
  let stages: EtapaDuplicada[] = [];

  if (vivas.length > 0) {
    const autoria = autoriaDaMudanca(deps.actor);
    const linhas = vivas.map((e) => {
      const copia: Record<string, unknown> = {};
      for (const c of COLUNAS_DA_ETAPA.COPIA) copia[c] = e[c];
      return { ...copia, organization_id: orgId, pipeline_id: novoId, ...autoria };
    });
    const { data: inseridas, error: etapasErr } = await deps.supabase
      .from("crm_stages")
      .insert(linhas)
      .select(COLUNAS_DA_RESPOSTA_DA_ETAPA);
    if (etapasErr || !inseridas) {
      await desfazer();
      const plano = limiteDoPlano(deps, etapasErr);
      if (plano) throw plano;
      throw recusa(
        deps,
        500,
        "internal_error",
        t("Não consegui copiar as etapas do funil. Nada foi salvo — tente de novo."),
      );
    }
    stages = (inseridas as unknown as EtapaDuplicada[])
      .slice()
      .sort((a, b) => Number(a.position) - Number(b.position));
    // Pelo slug: `uniq_crm_stages_pipeline_slug` garante um por funil, e a ordem de retorno não é contrato.
    const novaPorSlug = new Map(stages.map((s) => [s.slug, s.id]));
    for (const e of vivas) {
      const nova = novaPorSlug.get(e.slug);
      if (nova) troca.set(e.id, nova);
    }
  }

  let settings: Record<string, unknown> | null = null;
  if (o.settings) {
    const r = remapearIds(o.settings, troca, arquivadas);
    settings = ajustarAoSchema(r.valor as Record<string, unknown>, r.chavesRemovidas);
  }
  if (settings && JSON.stringify(settings) !== JSON.stringify(o.settings)) {
    const { error: settingsErr } = await deps.supabase
      .from("crm_pipelines")
      .update({ settings })
      .eq("id", novoId)
      .eq("organization_id", orgId);
    if (settingsErr) {
      await desfazer();
      throw falhaInterna(deps, "gravar_settings", settingsErr);
    }
  }

  void audit({
    action: "pipeline.duplicated",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: orgId,
    resourceType: "crm_pipeline",
    resourceId: novoId,
    requestId: deps.requestId,
    metadata: { origem_id: origemId, novo_id: novoId, etapas: stages.length },
  });

  return {
    id: novoId,
    name,
    slug,
    description,
    position,
    is_default: false,
    is_client_pipeline: false,
    vocabulary: o.vocabulary ?? null,
    settings,
    stages,
  };
}
