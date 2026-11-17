/**
 * Os CAMPOS PERSONALIZADOS vistos POR UM FUNIL — listar, criar, alterar, remover — pela rota antiga
 * `/api/v1/pipelines/[id]/fields` e pelas tools MCP `crm_*_pipeline_field`.
 *
 * ⚠️ DESDE A MIGRATION 1015 ISTO É FACHADA. A definição do campo é da ORGANIZAÇÃO
 * (`custom_field_definitions`, regra em `lib/campos/administracao.ts`) e vale para todos os funis; o
 * que continua do funil é só a obrigatoriedade (`settings.campos_obrigatorios`). O contrato desta
 * porta não mudou — mesmo corpo, mesma resposta (o item de `settings.fields`, que o banco projeta) —,
 * mas o efeito mudou e quem integra precisa saber:
 *  - CRIAR por um funil cria o campo na organização (aparece em todos os funis). O `escopo` do corpo
 *    escolhe a entidade (`contato` ou, ausente, `negocio`); `obrigatorio_em` vira regra DESTE funil;
 *  - ALTERAR `label`/`required`/`options` muda o campo da organização; `obrigatorio_em` muda só a
 *    regra deste funil (`null` a tira);
 *  - REMOVER tira o campo da ORGANIZAÇÃO (de todos os funis). Os valores ficam nos registros.
 *
 * A AUTORIZAÇÃO NÃO MORA AQUI: cada porta confere o papel (`admin`, como sempre foi nesta porta) e
 * entrega a organização resolvida de fonte confiável; o funil TEM de ser dela (404 igual a inexistente).
 *
 * Decisões que continuam valendo:
 *  - o `type` de um campo NÃO muda depois de criado;
 *  - `select`/`multiselect` exigem opções, e só os tipos de lista as aceitam;
 *  - `obrigatorio_em.etapas` só aceita etapas DESTE funil, desta organização.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import type { Actor } from "@/lib/api/handlers/types";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { customFieldSchema, type CustomFieldDef } from "@/lib/schemas/settings";

import {
  alterarDefinicao,
  criarDefinicao,
  definicaoPelaChave,
  removerDefinicao,
} from "@/lib/campos/administracao";
import type { ConfigDoCampo } from "@/lib/campos/definicoes";

import { aplicarConfiguracaoDoFunil, lerConfiguracaoDoFunil, type EdicaoDeObrigatorios } from "./configuracao-do-funil";

export interface DepsDosCampos {
  supabase: SupabaseClient;
  organizationId: string;
  actor: Actor;
  requestId: string;
}

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

function erroDoNucleo(deps: DepsDosCampos, error: string): ApiError {
  if (error === "not_found") return recusa(deps, 404, "not_found", "Funil não encontrado.");
  if (error === "conflict") {
    return recusa(deps, 409, "conflict", "Outra alteração mexeu neste funil ao mesmo tempo. Tente de novo.");
  }
  if (error === "validation_failed" || error === "invalid_request") {
    return recusa(deps, 422, "unprocessable_entity", "Regra de obrigatoriedade inválida.");
  }
  return recusa(deps, 500, "internal_error", error);
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

/** A obrigatoriedade DESTE funil, alterada numa chave, dentro da trava otimista do núcleo. */
async function gravarObrigatoriedade(
  deps: DepsDosCampos,
  pipelineId: string,
  chave: string,
  regra: CustomFieldDef["obrigatorio_em"] | null,
): Promise<void> {
  const editar: EdicaoDeObrigatorios = (atuais) => {
    const proximo = { ...atuais };
    if (regra) proximo[chave] = regra;
    else delete proximo[chave];
    return proximo;
  };
  const r = await aplicarConfiguracaoDoFunil(deps.supabase, {
    organizationId: deps.organizationId,
    pipelineId,
    patch: {},
    editarObrigatorios: editar,
    detalheDoAudit: { campo_chave: chave, campo_acao: regra ? "obrigatoriedade_definida" : "obrigatoriedade_removida" },
    autor: colunasDeAtorNoAudit(deps.actor),
    requestId: deps.requestId,
  });
  if (!r.ok) throw erroDoNucleo(deps, r.error);
}

/** O item de `settings.fields` deste funil para a chave, como o banco o projetou. */
async function campoProjetado(deps: DepsDosCampos, pipelineId: string, chave: string): Promise<{
  campo: CustomFieldDef;
  total: number;
}> {
  const lida = await lerConfiguracaoDoFunil(deps.supabase, deps.organizationId, pipelineId);
  if (!lida.ok) throw erroDoNucleo(deps, lida.error);
  const campos = lida.dados.settings.fields;
  const achado = campos.find(
    (c) => typeof (c as { key?: unknown })?.key === "string" && (c as { key: string }).key.toLowerCase() === chave.toLowerCase(),
  );
  return { campo: (achado ?? null) as unknown as CustomFieldDef, total: campos.length };
}

/** O que é do tipo, tirado do corpo antigo (o item de `fields`) para o `config` da definição. */
function configDoCorpo(campo: Partial<CustomFieldDef>): ConfigDoCampo | undefined {
  const config: ConfigDoCampo = {};
  if (campo.options !== undefined) config.options = campo.options;
  if (campo.mostrar_quando !== undefined) config.mostrar_quando = campo.mostrar_quando;
  if (campo.padrao !== undefined) config.padrao = campo.padrao;
  if (campo.mensagem_padrao !== undefined) config.mensagem_padrao = campo.mensagem_padrao;
  if (campo.allow_new !== undefined) config.allow_new = campo.allow_new;
  if (campo.multiple !== undefined) config.multiple = campo.multiple;
  return Object.keys(config).length > 0 ? config : undefined;
}

async function exigirFunil(deps: DepsDosCampos, pipelineId: string): Promise<void> {
  const lida = await lerConfiguracaoDoFunil(deps.supabase, deps.organizationId, pipelineId);
  if (!lida.ok) throw erroDoNucleo(deps, lida.error);
}

/**
 * Cria o campo NA ORGANIZAÇÃO (ver o cabeçalho) e, se veio `obrigatorio_em`, a regra deste funil.
 * Chave repetida na organização (sem diferenciar maiúsculas) é 409.
 */
export async function criarCampoDoFunil(
  deps: DepsDosCampos,
  pipelineId: string,
  campo: CustomFieldDef,
): Promise<{ campo: CustomFieldDef; total: number }> {
  await exigirFunil(deps, pipelineId);
  await validarEtapas(deps, pipelineId, campo.obrigatorio_em?.etapas);
  await criarDefinicao(deps, {
    entidade: campo.escopo === "contato" ? "contato" : "negocio",
    key: campo.key,
    label: campo.label,
    type: campo.type,
    obrigatorio: campo.required,
    grupo: campo.grupo,
    descricao: campo.descricao,
    publico: campo.publico,
    sempre_visivel: campo.sempre_visivel,
    exibir_no_perfil: campo.exibir_no_perfil,
    dica_de_ajuda: campo.dica_de_ajuda,
    config: configDoCorpo(campo),
  });
  if (campo.obrigatorio_em) await gravarObrigatoriedade(deps, pipelineId, campo.key, campo.obrigatorio_em);
  return campoProjetado(deps, pipelineId, campo.key);
}

/** Altera label, obrigatoriedade e opções do campo da organização; `obrigatorio_em`, a regra deste funil. */
export async function alterarCampoDoFunil(
  deps: DepsDosCampos,
  pipelineId: string,
  chave: string,
  alteracao: AlteracaoDeCampo,
): Promise<CustomFieldDef> {
  if (Object.keys(alteracao).length === 0) {
    throw recusa(deps, 422, "unprocessable_entity", "Diga o que mudar no campo.");
  }
  await exigirFunil(deps, pipelineId);
  await validarEtapas(deps, pipelineId, alteracao.obrigatorio_em?.etapas);
  const definicao = await definicaoPelaChave(deps, chave);
  if (!definicao) throw recusa(deps, 404, "not_found", "Esse campo não existe neste funil.");

  const { obrigatorio_em, label, required, options } = alteracao;
  if (label !== undefined || required !== undefined || options !== undefined) {
    await alterarDefinicao(deps, definicao.id, {
      ...(label !== undefined ? { label } : {}),
      ...(required !== undefined ? { obrigatorio: required } : {}),
      ...(options !== undefined ? { config: { options } } : {}),
    });
  }
  if (obrigatorio_em !== undefined) {
    await gravarObrigatoriedade(deps, pipelineId, definicao.key, obrigatorio_em);
  }
  return (await campoProjetado(deps, pipelineId, definicao.key)).campo;
}

/** Tira o campo da ORGANIZAÇÃO. Os valores já guardados nos registros permanecem (ver o cabeçalho). */
export async function removerCampoDoFunil(
  deps: DepsDosCampos,
  pipelineId: string,
  chave: string,
): Promise<{ key: string; total: number }> {
  await exigirFunil(deps, pipelineId);
  const definicao = await definicaoPelaChave(deps, chave);
  if (!definicao) throw recusa(deps, 404, "not_found", "Esse campo não existe neste funil.");
  await removerDefinicao(deps, definicao.id);
  const { total } = await campoProjetado(deps, pipelineId, chave);
  return { key: definicao.key, total };
}
