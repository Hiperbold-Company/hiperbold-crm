/**
 * O CAMPO PERSONALIZADO DO CONTATO GRAVADO PELO AGENTE (`crm_set_contact_custom_field`).
 *
 * Três peças, todas sobre `custom_field_definitions` com `entidade = 'contato'`:
 *
 *  1. QUAIS campos o agente pode gravar (`camposGravaveisPeloAgente`): os do
 *     contato, públicos e de tipo que dá para escrever em texto. Campo NÃO
 *     público fica de fora — só administrador o vê na ficha, e o agente não lê
 *     o que grava (`leitorVeCamposRestritos("ia") === false`). Arquivo fica de
 *     fora porque o valor é um upload, não uma resposta da conversa.
 *  2. O VALOR convertido pelo tipo (`converterValorDoCampoDoContato`). Nenhuma
 *     régua nova: lista (`select`, `multiselect`, `searchable_select`) passa por
 *     `canonizarValorDoCampo` — a régua de opção das escritas do servidor, que
 *     aceita o rótulo, o valor ou um apelido sem diferenciar maiúsculas e
 *     acentos —, e número, data, sim/não, e-mail e telefone por
 *     `coagirPeloTipo`, a mesma conversão do bloco de campo das automações.
 *     Moeda é número na unidade da moeda, como a ficha grava.
 *  3. A DESCRIÇÃO que o modelo lê (`descricaoComOsCamposDoContato`): a frase da
 *     ferramenta mais a lista das chaves, com tipo e opções. A lista é por
 *     organização, então ela entra no MONTADOR do turno
 *     (`lib/agent-engine/edge/crm/ferramentas-do-turno.ts`), não no handler.
 *
 * Arquivo puro (sem I/O): a leitura do banco fica em `lerCamposDoContato`, que
 * recebe o cliente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { coagirPeloTipo } from "@/lib/automacoes/campos";
import { canonizarValorDoCampo } from "@/lib/leads/campos-pesquisaveis";
import type { CustomFieldDef } from "@/lib/schemas/settings";

import type { EntidadeDoCampo, TipoDoCampo } from "./definicoes";

/** Teto de um valor de texto gravado pelo agente — a mesma ordem do `padrao` (500). */
export const TETO_DO_TEXTO_DO_CAMPO = 500;

/** Quantos campos a descrição lista (a cota por entidade é 50). */
const CAMPOS_NA_DESCRICAO = 50;
/** Quantas opções de UM campo a descrição lista; o resto é aceito pelo rótulo do mesmo jeito. */
const OPCOES_NA_DESCRICAO = 25;

/** Os tipos que a conversa não preenche: o valor é um arquivo. */
const TIPOS_FORA_DO_AGENTE: ReadonlySet<TipoDoCampo> = new Set(["file"]);

/** Uma definição como o agente precisa dela — o recorte das colunas que a leitura pede. */
export interface CampoDoContato {
  key: string;
  label: string;
  type: TipoDoCampo;
  entidade: EntidadeDoCampo;
  publico: boolean;
  descricao: string | null;
  config: Record<string, unknown>;
}

const COLUNAS = "key, label, type, entidade, publico, descricao, config, position";

/**
 * As definições da organização, das DUAS entidades (a do negócio serve para a
 * recusa dizer "este campo é do negócio" em vez de "não existe"). Ordem da tela.
 * Falha de leitura devolve `null`: quem chama recusa como indisponível, nunca
 * como "campo inexistente".
 */
export async function lerCamposDaOrganizacao(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<CampoDoContato[] | null> {
  try {
    const { data, error } = await supabase
      .from("custom_field_definitions")
      .select(COLUNAS)
      .eq("organization_id", organizationId)
      .order("position", { ascending: true });
    if (error || !Array.isArray(data)) return null;
    return (data as Array<CampoDoContato & { config: unknown }>).map((d) => ({
      key: d.key,
      label: d.label,
      type: d.type,
      entidade: d.entidade,
      publico: d.publico !== false,
      descricao: d.descricao ?? null,
      config: d.config && typeof d.config === "object" && !Array.isArray(d.config) ? (d.config as Record<string, unknown>) : {},
    }));
  } catch {
    return null;
  }
}

/** Os campos do CONTATO que o agente pode gravar, na ordem da tela. */
export function camposGravaveisPeloAgente(campos: readonly CampoDoContato[]): CampoDoContato[] {
  return campos.filter((c) => c.entidade === "contato" && c.publico && !TIPOS_FORA_DO_AGENTE.has(c.type));
}

/** A definição no formato que as réguas de opção leem (`CustomFieldDef`). */
function comoDefDoFunil(campo: CampoDoContato): Pick<CustomFieldDef, "type" | "options" | "allow_new" | "multiple"> {
  const c = campo.config;
  return {
    type: campo.type,
    ...(Array.isArray(c.options) ? { options: c.options as CustomFieldDef["options"] } : {}),
    ...(c.allow_new === true ? { allow_new: true } : {}),
    ...(c.multiple === true ? { multiple: true } : {}),
  };
}

function opcoesDe(campo: CampoDoContato): Array<{ value: string; label: string }> {
  const bruto = campo.config.options;
  if (!Array.isArray(bruto)) return [];
  return bruto.filter(
    (o): o is { value: string; label: string } =>
      !!o && typeof (o as { value?: unknown }).value === "string" && typeof (o as { label?: unknown }).label === "string",
  );
}

export type ValorConvertido =
  | { ok: true; valor: unknown }
  | { ok: false; motivo: "valor_invalido" | "opcao_invalida" | "tipo_nao_suportado"; mensagem: string };

/** O valor como texto, para as conversões que leem texto (`coagirPeloTipo`). */
function comoTexto(bruto: unknown): string {
  if (Array.isArray(bruto)) return bruto.map((b) => String(b)).join(", ");
  if (typeof bruto === "boolean") return bruto ? "sim" : "não";
  return String(bruto ?? "");
}

/** As opções de um campo numa linha, para o erro de ensino. */
function listaDeOpcoes(campo: CampoDoContato): string {
  return opcoesDe(campo)
    .slice(0, OPCOES_NA_DESCRICAO)
    .map((o) => `«${o.label}»`)
    .join(", ");
}

/**
 * Converte o valor que o modelo mandou para o que a ficha guarda. Recusa com a
 * frase para o MODELO (pergunte de novo, escolha uma opção), nunca grava torto.
 */
export function converterValorDoCampoDoContato(campo: CampoDoContato, bruto: unknown): ValorConvertido {
  if (TIPOS_FORA_DO_AGENTE.has(campo.type)) {
    return {
      ok: false,
      motivo: "tipo_nao_suportado",
      mensagem: `O campo «${campo.label}» guarda um arquivo e não é preenchido pela conversa.`,
    };
  }
  if (bruto === null || bruto === undefined || comoTexto(bruto).trim() === "") {
    return { ok: false, motivo: "valor_invalido", mensagem: `Valor vazio para «${campo.label}»: só grave o que a pessoa respondeu.` };
  }

  if (campo.type === "select" || campo.type === "multiselect" || campo.type === "searchable_select") {
    const def = comoDefDoFunil(campo);
    const r = canonizarValorDoCampo(def, typeof bruto === "boolean" || typeof bruto === "number" ? String(bruto) : bruto);
    if (r.ok) return { ok: true, valor: r.valor };
    const opcoes = listaDeOpcoes(campo);
    return {
      ok: false,
      motivo: "opcao_invalida",
      mensagem:
        `«${r.item}» não é uma opção do campo «${campo.label}». ` +
        (opcoes ? `Opções: ${opcoes}. ` : "") +
        "Grave uma delas (pelo nome) ou pergunte de novo à pessoa.",
    };
  }

  const texto = comoTexto(bruto).trim();
  if (campo.type === "text" || campo.type === "textarea" || campo.type === "url") {
    if (texto.length > TETO_DO_TEXTO_DO_CAMPO) {
      return {
        ok: false,
        motivo: "valor_invalido",
        mensagem: `O texto para «${campo.label}» passa de ${TETO_DO_TEXTO_DO_CAMPO} caracteres: resuma o que a pessoa disse.`,
      };
    }
    return { ok: true, valor: texto };
  }

  // Moeda é número na unidade da moeda (a ficha grava `1250.5`, não centavos).
  const tipo = campo.type === "currency" ? "number" : campo.type;
  const r = coagirPeloTipo({ type: tipo }, texto);
  if (r.ok) return { ok: true, valor: r.valor };
  const esperado: Record<string, string> = {
    number: "um número",
    date: "uma data (AAAA-MM-DD ou DD/MM/AAAA)",
    boolean: "sim ou não",
    email: "um e-mail",
    phone: "um telefone",
  };
  return {
    ok: false,
    motivo: "valor_invalido",
    mensagem: `O campo «${campo.label}» espera ${esperado[tipo] ?? "outro formato"}: confirme com a pessoa e grave de novo.`,
  };
}

const NOME_DO_TIPO: Record<TipoDoCampo, string> = {
  text: "texto",
  textarea: "texto",
  url: "link",
  number: "número",
  currency: "valor em dinheiro (número)",
  date: "data AAAA-MM-DD",
  boolean: "sim/não",
  email: "e-mail",
  phone: "telefone",
  select: "uma opção",
  multiselect: "uma ou mais opções",
  searchable_select: "opção da lista",
  file: "arquivo",
};

/** Uma linha da lista de campos: `- chave (tipo) «Rótulo»: opções «A», «B»`. */
function linhaDoCampo(campo: CampoDoContato): string {
  const tipo =
    campo.type === "searchable_select" && campo.config.multiple === true ? "uma ou mais opções da lista" : NOME_DO_TIPO[campo.type];
  const opcoes = opcoesDe(campo);
  const extra = opcoes.length > OPCOES_NA_DESCRICAO ? ` e mais ${opcoes.length - OPCOES_NA_DESCRICAO}` : "";
  const livre = campo.type === "searchable_select" && campo.config.allow_new === true ? " (aceita valor novo)" : "";
  const sufixo = opcoes.length > 0 ? `: opções ${listaDeOpcoes(campo)}${extra}${livre}` : "";
  return `- ${campo.key} (${tipo}) «${campo.label}»${sufixo}`;
}

/**
 * A frase da ferramenta seguida dos campos que ESTA organização tem. Sem campo
 * nenhum, a frase diz isso — o modelo não tenta gravar o que não existe.
 */
export function descricaoComOsCamposDoContato(base: string, campos: readonly CampoDoContato[]): string {
  const gravaveis = camposGravaveisPeloAgente(campos).slice(0, CAMPOS_NA_DESCRICAO);
  if (gravaveis.length === 0) {
    return `${base} Esta empresa ainda não criou nenhum campo do contato que você possa preencher: não use esta ferramenta.`;
  }
  return [base, "Campos do contato desta empresa (chave, tipo, rótulo e opções):", ...gravaveis.map(linhaDoCampo)].join("\n");
}

/** A lista curta das chaves, para o erro de ensino de chave inexistente. */
export function chavesDisponiveis(campos: readonly CampoDoContato[]): string {
  const gravaveis = camposGravaveisPeloAgente(campos).slice(0, CAMPOS_NA_DESCRICAO);
  return gravaveis.length === 0 ? "nenhum" : gravaveis.map((c) => `${c.key} («${c.label}»)`).join(", ");
}
