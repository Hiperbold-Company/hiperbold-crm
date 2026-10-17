/**
 * Os CAMPOS PERSONALIZADOS de um funil, um a um — listar, criar, alterar, remover.
 *
 * ⚠️ POR QUE EXISTE SE `PATCH /pipelines/[id]/config` JÁ GRAVA `fields`. Lá a lista INTEIRA é
 * substituída: quem quer acrescentar um campo tem de ler tudo, remendar e devolver tudo, e um
 * agente de IA (ou uma integração) que erra um item apaga os outros — sem aviso, porque o valor já
 * gravado nos negócios fica órfão. Aqui a operação é POR ITEM e roda dentro da trava otimista de
 * `aplicarConfiguracaoDoFunil` (`editarCampos`), então "acrescente o campo X" nunca desfaz o que
 * outra aba ou outra chave gravou um instante antes.
 *
 * ⚠️ A REGRA É DE UM LUGAR SÓ. A rota REST e as tools MCP chamam estas funções; o merge de
 * `settings`, a trava otimista e o audit (`pipeline.config_updated`) continuam em
 * `lib/pipelines/configuracao-do-funil.ts`. A AUTORIZAÇÃO NÃO MORA AQUI: cada porta confere o
 * papel (`admin`, como a tela de configuração do funil) e entrega a organização já resolvida de
 * fonte confiável; o funil TEM de ser dela (404 igual a inexistente).
 *
 * Decisões que a tela não precisava tomar e a API precisa:
 *  - o `type` de um campo NÃO muda depois de criado — os valores já gravados nos negócios seguem o
 *    tipo antigo; para outro tipo, cria-se outro campo;
 *  - `select`/`multiselect` exigem opções (sem elas o campo nasce inutilizável) e só eles as aceitam;
 *  - `obrigatorio_em.etapas` só aceita etapas DESTE funil, desta organização;
 *  - remover um campo tira a definição; o valor que os negócios já guardam permanece no
 *    `custom_fields` deles (a tela faz o mesmo ao excluir o campo).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import type { Actor } from "@/lib/api/handlers/types";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { customFieldSchema, type CustomFieldDef } from "@/lib/schemas/settings";

import {
  aplicarConfiguracaoDoFunil,
  lerConfiguracaoDoFunil,
  LIMITE_DE_CAMPOS,
  type EdicaoDeCampos,
} from "./configuracao-do-funil";

export interface DepsDosCampos {
  supabase: SupabaseClient;
  organizationId: string;
  actor: Actor;
  requestId: string;
}

const TIPOS_COM_OPCOES = new Set(["select", "multiselect"]);

/**
 * O que se pode alterar num campo existente. `key` e `type` ficam de fora de propósito, e
 * `strict()` recusa quem os mande em vez de ignorá-los em silêncio. `obrigatorio_em: null` limpa a
 * regra de obrigatoriedade.
 */
export const alteracaoDeCampoSchema = z
  .object({
    label: customFieldSchema.shape.label.optional(),
    required: z.boolean().optional(),
    options: customFieldSchema.shape.options.optional(),
    obrigatorio_em: customFieldSchema.shape.obrigatorio_em.nullable().optional(),
  })
  .strict();
export type AlteracaoDeCampo = z.infer<typeof alteracaoDeCampoSchema>;

export const novoCampoSchema = customFieldSchema.strict();

function recusa(deps: DepsDosCampos, status: number, code: string, message: string, details?: unknown): ApiError {
  return new ApiError(status, code, details as never, deps.requestId, message);
}

function erroDoNucleo(deps: DepsDosCampos, error: string, details?: unknown): ApiError {
  if (error === "not_found") return recusa(deps, 404, "not_found", "Funil não encontrado.");
  if (error === "campo_nao_encontrado") return recusa(deps, 404, "not_found", "Esse campo não existe neste funil.");
  if (error === "campo_ja_existe") {
    return recusa(deps, 409, "conflict", "Já existe um campo com essa chave neste funil.");
  }
  if (error === "conflict") {
    return recusa(deps, 409, "conflict", "Outra alteração mexeu neste funil ao mesmo tempo. Tente de novo.");
  }
  if (error === "incoerente") {
    return recusa(deps, 422, "unprocessable_entity", typeof details === "string" ? details : "Campo incoerente.");
  }
  if (error === "validation_failed" || error === "invalid_request") {
    return recusa(
      deps,
      422,
      "unprocessable_entity",
      `Um funil aceita até ${LIMITE_DE_CAMPOS} campos personalizados.`,
      details,
    );
  }
  return recusa(deps, 500, "internal_error", error);
}

/** Regras de coerência de UM campo (tipo × opções). Devolve a razão da recusa, ou `null` se coerente. */
function incoerenciaDoCampo(campo: Pick<CustomFieldDef, "type" | "options">): string | null {
  const temOpcoes = (campo.options?.length ?? 0) > 0;
  if (TIPOS_COM_OPCOES.has(campo.type) && !temOpcoes) {
    return "Campo de seleção precisa de pelo menos uma opção (options).";
  }
  if (!TIPOS_COM_OPCOES.has(campo.type) && campo.options !== undefined) {
    return "Só campos de seleção (select/multiselect) têm opções.";
  }
  if (campo.options) {
    const valores = campo.options.map((o) => o.value);
    if (new Set(valores).size !== valores.length) return "As opções do campo têm valores repetidos.";
  }
  return null;
}

/** As etapas de `obrigatorio_em.etapas` têm de ser deste funil e desta organização. */
async function validarEtapas(
  deps: DepsDosCampos,
  pipelineId: string,
  etapas: string[] | undefined,
): Promise<void> {
  const ids = [...new Set(etapas ?? [])];
  if (ids.length === 0) return;
  const { data, error } = await deps.supabase
    .from("crm_stages")
    .select("id")
    .eq("organization_id", deps.organizationId)
    .eq("pipeline_id", pipelineId)
    .in("id", ids);
  if (error) throw recusa(deps, 500, "internal_error", error.message);
  if ((data ?? []).length !== ids.length) {
    throw recusa(
      deps,
      422,
      "unprocessable_entity",
      "obrigatorio_em.etapas tem etapa que não pertence a este funil.",
    );
  }
}

/** Os campos do funil na ordem em que a tela os mostra. */
export async function listarCamposDoFunil(deps: DepsDosCampos, pipelineId: string): Promise<unknown[]> {
  const lida = await lerConfiguracaoDoFunil(deps.supabase, deps.organizationId, pipelineId);
  if (!lida.ok) throw erroDoNucleo(deps, lida.error);
  return lida.dados.settings.fields;
}

async function aplicar(
  deps: DepsDosCampos,
  pipelineId: string,
  editarCampos: EdicaoDeCampos,
  detalheDoAudit: Record<string, unknown>,
): Promise<unknown[]> {
  const r = await aplicarConfiguracaoDoFunil(deps.supabase, {
    organizationId: deps.organizationId,
    pipelineId,
    patch: {},
    editarCampos,
    detalheDoAudit,
    autor: colunasDeAtorNoAudit(deps.actor),
    requestId: deps.requestId,
  });
  if (!r.ok) throw erroDoNucleo(deps, r.error, r.details);
  return r.dados.settings.fields;
}

const mesmaChave = (a: unknown, b: string) =>
  typeof (a as { key?: unknown })?.key === "string" && (a as { key: string }).key.toLowerCase() === b.toLowerCase();

/** Acrescenta um campo ao fim da lista. Chave repetida (sem diferenciar maiúsculas) é 409. */
export async function criarCampoDoFunil(
  deps: DepsDosCampos,
  pipelineId: string,
  campo: CustomFieldDef,
): Promise<{ campo: CustomFieldDef; total: number }> {
  const incoerente = incoerenciaDoCampo(campo);
  if (incoerente) throw recusa(deps, 422, "unprocessable_entity", incoerente);
  await validarEtapas(deps, pipelineId, campo.obrigatorio_em?.etapas);
  const campos = await aplicar(
    deps,
    pipelineId,
    (atuais) =>
      atuais.some((c) => mesmaChave(c, campo.key))
        ? { erro: "campo_ja_existe" }
        : { campos: [...atuais, campo] },
    { campo_chave: campo.key, campo_acao: "criado" },
  );
  return { campo, total: campos.length };
}

/** Altera label, obrigatoriedade, opções e regra de obrigatoriedade de um campo existente. */
export async function alterarCampoDoFunil(
  deps: DepsDosCampos,
  pipelineId: string,
  chave: string,
  alteracao: AlteracaoDeCampo,
): Promise<CustomFieldDef> {
  if (Object.keys(alteracao).length === 0) {
    throw recusa(deps, 422, "unprocessable_entity", "Diga o que mudar no campo.");
  }
  await validarEtapas(deps, pipelineId, alteracao.obrigatorio_em?.etapas);

  let resultado: CustomFieldDef | null = null;
  await aplicar(
    deps,
    pipelineId,
    (atuais) => {
      const i = atuais.findIndex((c) => (c as { key?: unknown })?.key === chave);
      if (i < 0) return { erro: "campo_nao_encontrado" };
      const { obrigatorio_em, ...resto } = alteracao;
      const novo = { ...(atuais[i] as CustomFieldDef), ...resto } as CustomFieldDef;
      if (obrigatorio_em === null) delete novo.obrigatorio_em;
      else if (obrigatorio_em !== undefined) novo.obrigatorio_em = obrigatorio_em;
      const incoerente = incoerenciaDoCampo(novo);
      if (incoerente) return { erro: "incoerente", details: incoerente };
      resultado = novo;
      const copia = [...atuais];
      copia[i] = novo;
      return { campos: copia };
    },
    { campo_chave: chave, campo_acao: "alterado", campos_alterados: Object.keys(alteracao) },
  );
  return resultado as unknown as CustomFieldDef;
}

/** Tira a definição do campo. Os valores já guardados nos negócios permanecem (ver o cabeçalho). */
export async function removerCampoDoFunil(
  deps: DepsDosCampos,
  pipelineId: string,
  chave: string,
): Promise<{ key: string; total: number }> {
  const campos = await aplicar(
    deps,
    pipelineId,
    (atuais) =>
      atuais.some((c) => (c as { key?: unknown })?.key === chave)
        ? { campos: atuais.filter((c) => (c as { key?: unknown })?.key !== chave) }
        : { erro: "campo_nao_encontrado" },
    { campo_chave: chave, campo_acao: "removido" },
  );
  return { key: chave, total: campos.length };
}
