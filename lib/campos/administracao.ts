/**
 * ADMINISTRAR OS CAMPOS PERSONALIZADOS DA ORGANIZAÇÃO (migration 1015) — listar, criar, alterar,
 * excluir e medir. A regra mora AQUI, uma vez: a rota `app/api/v1/custom-fields` e a fachada dos
 * campos do funil (`lib/pipelines/campos-do-funil.ts`, que serve a rota antiga e as tools MCP)
 * chamam estas funções.
 *
 * ⚠️ A AUTORIZAÇÃO NÃO MORA AQUI. Cada porta confere o papel antes (gerente ou acima) e entrega a
 * organização já resolvida de fonte confiável (sessão ou linha do token). Toda consulta daqui filtra
 * `organization_id` explicitamente — o cliente pode ser o de service role, que ignora a RLS —, e a
 * definição de outra organização responde igual à inexistente (404).
 *
 * Decisões:
 *  - `key`, `entidade` e `type` não mudam depois de criados (o banco também recusa, no gatilho
 *    `trg_custom_field_definitions_guarda`): os valores já gravados seguem a forma antiga;
 *  - a chave é única na organização SEM diferenciar maiúsculas e sem separar contato de negócio;
 *  - excluir tira só a DEFINIÇÃO: os valores ficam nos registros (`custom_fields`), e a resposta diz
 *    quantos registros tinham valor;
 *  - a cota é `COTA_DE_CAMPOS_POR_ENTIDADE` por entidade.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { colunasDeAtorNoAudit } from "@/lib/audit/ator";
import { MENSAGEM_DE_FALHA_INTERNA } from "@/lib/api/wrappers";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  COLUNAS_DA_DEFINICAO,
  COTA_DE_CAMPOS_POR_ENTIDADE,
  estatisticasDe,
  incoerenciaDaDefinicao,
  type AlteracaoDeDefinicao,
  type ConfigDoCampo,
  type DefinicaoDeCampo,
  type EntidadeDoCampo,
  type EstatisticasDoCampo,
  type NovaDefinicao,
} from "./definicoes";

export interface DepsDasDefinicoes {
  supabase: SupabaseClient;
  organizationId: string;
  actor: Actor;
  requestId: string;
  /**
   * O papel EFETIVO de quem age, resolvido pela porta. Só administrador muda `publico` (o campo que só
   * administrador vê): a porta já exige admin para gravar, e esta é a segunda trava, no núcleo.
   */
  papel: Role;
}

function recusa(deps: DepsDasDefinicoes, status: number, code: string, message: string, details?: unknown): ApiError {
  // A frase sai em português, como as do núcleo do funil; quem traduz é a tela, pelo dicionário.
  return new ApiError(status, code, details as never, deps.requestId, message);
}

function erroDoBanco(deps: DepsDasDefinicoes, error: { code?: string; message: string }): ApiError {
  if (error.code === "23505") return recusa(deps, 409, "conflict", "Já existe um campo com essa chave na organização.");
  if (error.code === "22023") {
    return recusa(deps, 422, "unprocessable_entity", "A chave, a entidade e o tipo de um campo não mudam depois de criados.");
  }
  if (error.code === "23514") {
    // O teto do banco (gatilho `trg_custom_field_definitions_antes_de_inserir`), o mesmo da cota daqui.
    if (error.message?.includes("teto de campos personalizados")) {
      return recusa(deps, 422, "unprocessable_entity", "A organização chegou ao limite de campos personalizados.", {
        cota: COTA_DE_CAMPOS_POR_ENTIDADE,
      });
    }
    return recusa(deps, 422, "unprocessable_entity", "Campo inválido.");
  }
  // A mensagem do Postgres traz nome de tabela, coluna e valor: vai só para o log, com o requestId.
  logger.error("[campos] falha do banco", {
    request_id: deps.requestId,
    organizationId: deps.organizationId,
    code: error.code,
    causa: error.message,
  });
  return new ApiError(500, "internal_error", undefined, deps.requestId, MENSAGEM_DE_FALHA_INTERNA);
}

/** Mudar `publico` (inclusive criar já não público) é só de administrador. */
function exigirAdminParaPublico(deps: DepsDasDefinicoes, publico: boolean | undefined, criando: boolean): void {
  if (publico === undefined || (criando && publico === true)) return;
  if (roleAtLeast(deps.papel, "admin")) return;
  throw recusa(deps, 403, "forbidden", "Só administrador muda quem vê o campo.");
}

/**
 * A ADOÇÃO DO LEGADO (1015, `fn_adotar_campos_legados_da_organizacao`) ANTES da primeira definição:
 * organização que ganhou campos pelo caminho antigo depois da atualização tem os campos dos funis
 * copiados para definições primeiro — e a chave repetida aparece como 409 normal, não como um campo
 * que some. Idempotente (organização com definição devolve 0). O gatilho do banco faz o mesmo, como
 * segunda trava.
 */
async function adotarLegado(deps: DepsDasDefinicoes): Promise<void> {
  const { error } = await deps.supabase.rpc("fn_adotar_campos_legados_da_organizacao", {
    p_org: deps.organizationId,
  });
  if (error) throw erroDoBanco(deps, error);
}

/** Quem assina `created_by`/`updated_by`: só pessoa (a FK é `auth.users`). Token e IA: `null`. */
function pessoa(actor: Actor): string | null {
  return actor.type === "user" ? actor.id : null;
}

/** As definições da organização, na ordem da tela. `entidade` filtra um dos dois níveis. */
export async function listarDefinicoes(
  deps: DepsDasDefinicoes,
  entidade?: EntidadeDoCampo,
): Promise<DefinicaoDeCampo[]> {
  let q = deps.supabase
    .from("custom_field_definitions")
    .select(COLUNAS_DA_DEFINICAO)
    .eq("organization_id", deps.organizationId);
  if (entidade) q = q.eq("entidade", entidade);
  const { data, error } = await q
    .order("entidade", { ascending: true })
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw erroDoBanco(deps, error);
  return (data ?? []) as unknown as DefinicaoDeCampo[];
}

/** Uma definição DESTA organização, por id. Outra organização = 404, igual a inexistente. */
export async function lerDefinicao(deps: DepsDasDefinicoes, id: string): Promise<DefinicaoDeCampo> {
  const { data, error } = await deps.supabase
    .from("custom_field_definitions")
    .select(COLUNAS_DA_DEFINICAO)
    .eq("organization_id", deps.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw erroDoBanco(deps, error);
  if (!data) throw recusa(deps, 404, "not_found", "Campo não encontrado.");
  return data as unknown as DefinicaoDeCampo;
}

/** Uma definição DESTA organização pela chave (sem diferenciar maiúsculas), ou `null`. */
export async function definicaoPelaChave(deps: DepsDasDefinicoes, chave: string): Promise<DefinicaoDeCampo | null> {
  // A lista inteira (no máximo duas cotas) e a comparação aqui: `ilike` trataria o `_` da chave como
  // curinga, e `cidade_1` casaria `cidadeX1`.
  const todas = await listarDefinicoes(deps);
  return todas.find((d) => d.key.toLowerCase() === chave.toLowerCase()) ?? null;
}

/** O `config` só com o que tem valor: `undefined` não vira chave gravada. */
function configLimpo(config: ConfigDoCampo | undefined): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(config ?? {})) {
    if (valor === undefined || valor === null) continue;
    if (typeof valor === "string" && valor.trim() === "") continue;
    saida[chave] = valor;
  }
  return saida;
}

export async function criarDefinicao(deps: DepsDasDefinicoes, entrada: NovaDefinicao): Promise<DefinicaoDeCampo> {
  const incoerente = incoerenciaDaDefinicao(entrada.type, entrada.config);
  if (incoerente) throw recusa(deps, 422, "unprocessable_entity", incoerente);
  exigirAdminParaPublico(deps, entrada.publico, true);
  await adotarLegado(deps);

  const doNivel = await listarDefinicoes(deps, entrada.entidade);
  if (doNivel.length >= COTA_DE_CAMPOS_POR_ENTIDADE) {
    throw recusa(
      deps,
      422,
      "unprocessable_entity",
      `A organização aceita no máximo ${COTA_DE_CAMPOS_POR_ENTIDADE} campos de ${entrada.entidade === "contato" ? "contato" : "negócio"}.`,
      { cota: COTA_DE_CAMPOS_POR_ENTIDADE },
    );
  }
  if (await definicaoPelaChave(deps, entrada.key)) {
    throw recusa(deps, 409, "conflict", "Já existe um campo com essa chave na organização.");
  }
  const ultima = doNivel.reduce((maior, d) => Math.max(maior, Number(d.position) || 0), 0);

  const { data, error } = await deps.supabase
    .from("custom_field_definitions")
    .insert({
      organization_id: deps.organizationId,
      entidade: entrada.entidade,
      key: entrada.key,
      label: entrada.label,
      type: entrada.type,
      descricao: entrada.descricao || null,
      grupo: entrada.grupo ?? null,
      obrigatorio: entrada.obrigatorio ?? false,
      publico: entrada.publico ?? true,
      sempre_visivel: entrada.sempre_visivel ?? false,
      exibir_no_perfil: entrada.exibir_no_perfil ?? false,
      dica_de_ajuda: entrada.dica_de_ajuda || null,
      config: configLimpo(entrada.config),
      position: ultima + 1000,
      created_by: pessoa(deps.actor),
      updated_by: pessoa(deps.actor),
    })
    .select(COLUNAS_DA_DEFINICAO)
    .single();
  if (error) throw erroDoBanco(deps, error);
  const criada = data as unknown as DefinicaoDeCampo;

  await audit({
    action: "custom_field.created",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "custom_field_definition",
    resourceId: criada.id,
    requestId: deps.requestId,
    metadata: { entidade: criada.entidade, key: criada.key, type: criada.type },
  });
  return criada;
}

export async function alterarDefinicao(
  deps: DepsDasDefinicoes,
  id: string,
  alteracao: AlteracaoDeDefinicao,
): Promise<DefinicaoDeCampo> {
  const campos = Object.keys(alteracao);
  if (campos.length === 0) throw recusa(deps, 422, "unprocessable_entity", "Diga o que mudar no campo.");
  exigirAdminParaPublico(deps, alteracao.publico, false);
  const atual = await lerDefinicao(deps, id);

  // `config` faz MERGE por chave: mandar só `options` não apaga o `padrao`. `null` numa chave a tira.
  let config: Record<string, unknown> | undefined;
  if (alteracao.config !== undefined) {
    config = { ...(atual.config ?? {}) };
    for (const [chave, valor] of Object.entries(alteracao.config)) {
      if (valor === undefined) continue;
      if (valor === null || (typeof valor === "string" && valor.trim() === "")) delete config[chave];
      else config[chave] = valor;
    }
    const incoerente = incoerenciaDaDefinicao(atual.type, config as ConfigDoCampo);
    if (incoerente) throw recusa(deps, 422, "unprocessable_entity", incoerente);
  }

  const mudanca: Record<string, unknown> = { updated_by: pessoa(deps.actor) };
  if (alteracao.label !== undefined) mudanca.label = alteracao.label;
  if (alteracao.descricao !== undefined) mudanca.descricao = alteracao.descricao || null;
  if (alteracao.grupo !== undefined) mudanca.grupo = alteracao.grupo;
  if (alteracao.obrigatorio !== undefined) mudanca.obrigatorio = alteracao.obrigatorio;
  if (alteracao.publico !== undefined) mudanca.publico = alteracao.publico;
  if (alteracao.sempre_visivel !== undefined) mudanca.sempre_visivel = alteracao.sempre_visivel;
  if (alteracao.exibir_no_perfil !== undefined) mudanca.exibir_no_perfil = alteracao.exibir_no_perfil;
  if (alteracao.dica_de_ajuda !== undefined) mudanca.dica_de_ajuda = alteracao.dica_de_ajuda || null;
  if (config !== undefined) mudanca.config = config;

  const { data, error } = await deps.supabase
    .from("custom_field_definitions")
    .update(mudanca)
    .eq("organization_id", deps.organizationId)
    .eq("id", id)
    .select(COLUNAS_DA_DEFINICAO)
    .maybeSingle();
  if (error) throw erroDoBanco(deps, error);
  if (!data) throw recusa(deps, 404, "not_found", "Campo não encontrado.");
  const alterada = data as unknown as DefinicaoDeCampo;

  await audit({
    action: "custom_field.updated",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "custom_field_definition",
    resourceId: id,
    requestId: deps.requestId,
    metadata: { entidade: alterada.entidade, key: alterada.key, campos_alterados: campos },
  });
  return alterada;
}

/**
 * Os contadores de UM campo. A função do banco é só da service role (invoker, revogada de
 * `authenticated`), então a chamada vai pelo cliente admin — com a organização resolvida pela porta,
 * nunca vinda do corpo.
 */
export async function estatisticasDaDefinicao(
  deps: DepsDasDefinicoes,
  id: string,
): Promise<{ definicao: DefinicaoDeCampo; estatisticas: EstatisticasDoCampo }> {
  const definicao = await lerDefinicao(deps, id);
  const { data, error } = await createAdminClient().rpc("fn_estatisticas_do_campo_personalizado", {
    p_org: deps.organizationId,
    p_entidade: definicao.entidade,
    p_key: definicao.key,
  });
  if (error) throw erroDoBanco(deps, error);
  return { definicao, estatisticas: estatisticasDe((data ?? {}) as Record<string, unknown>, definicao) };
}

/** Tira a definição. Os valores ficam nos registros; a resposta diz quantos tinham valor. */
export async function removerDefinicao(
  deps: DepsDasDefinicoes,
  id: string,
): Promise<{ id: string; key: string; registros_com_valor: number }> {
  const { definicao, estatisticas } = await estatisticasDaDefinicao(deps, id);
  const { data, error } = await deps.supabase
    .from("custom_field_definitions")
    .delete()
    .eq("organization_id", deps.organizationId)
    .eq("id", id)
    .select("id");
  if (error) throw erroDoBanco(deps, error);
  if ((data ?? []).length === 0) throw recusa(deps, 404, "not_found", "Campo não encontrado.");

  await audit({
    action: "custom_field.deleted",
    ...colunasDeAtorNoAudit(deps.actor),
    organizationId: deps.organizationId,
    resourceType: "custom_field_definition",
    resourceId: id,
    requestId: deps.requestId,
    // Só a contagem: o VALOR dos registros nunca entra no audit.
    metadata: { entidade: definicao.entidade, key: definicao.key, registros_com_valor: estatisticas.preenchidos },
  });
  return { id, key: definicao.key, registros_com_valor: estatisticas.preenchidos };
}
