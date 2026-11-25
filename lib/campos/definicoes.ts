/**
 * OS CAMPOS PERSONALIZADOS DA ORGANIZAÇÃO (migration 1015) — a forma de uma definição.
 *
 * Até a 1015 cada funil declarava os campos em `crm_pipelines.settings.fields[]`. Agora a fonte da
 * verdade é `public.custom_field_definitions`, em dois níveis: CONTATO (valor em
 * `contacts.custom_fields`) e NEGÓCIO (valor em `crm_leads.custom_fields`, vale para TODOS os funis).
 *
 * ⚠️ QUEM LÊ O CAMPO CONTINUA LENDO `settings.fields`. O banco o deriva das definições (gatilhos da
 * 1015), com a obrigatoriedade de cada funil (`settings.campos_obrigatorios`). Por isso
 * `paraCampoDoFunil` abaixo é o ESPELHO em TypeScript de `fn_campos_personalizados_projetados`: a
 * forma que sai daqui é a que os mais de cinquenta leitores de `camposDoFunil` já conhecem.
 *
 * Este arquivo não importa nada de servidor: a tela (`use client`) usa os schemas e os rótulos.
 */
import { z } from "zod";

import { mostrarQuandoSchema } from "@/lib/schemas/mostrar-quando";
import {
  MOEDAS_DO_CAMPO,
  camposObrigatoriosDoFunilSchema,
  customFieldSchema,
  type CustomFieldDef,
} from "@/lib/schemas/settings";

export const ENTIDADES_DE_CAMPO = ["contato", "negocio"] as const;
export type EntidadeDoCampo = (typeof ENTIDADES_DE_CAMPO)[number];

/** Os tipos que o CRM já sabe guardar e validar — os MESMOS do schema do funil, derivados dele. */
export const TIPOS_DE_CAMPO_DA_ORGANIZACAO = customFieldSchema.shape.type.options;
export type TipoDoCampo = CustomFieldDef["type"];

/**
 * A cota: 50 campos por ENTIDADE por organização. É o teto de 50 campos do negócio que valia por
 * funil (#3111), agora por organização — e o contato ganha o mesmo teto, que antes não tinha.
 * A migração de dados pode deixar uma organização acima dele (a união dos funis); nada some, só
 * campo NOVO é recusado até ela ficar abaixo.
 */
export const COTA_DE_CAMPOS_POR_ENTIDADE = 50;

/** Tipos de lista: os únicos que têm `options`. */
export const TIPOS_COM_OPCOES: ReadonlySet<TipoDoCampo> = new Set(["select", "multiselect", "searchable_select"]);
/** Tipos de lista FECHADA: sem opção nenhuma o campo nasce inutilizável. */
export const TIPOS_QUE_EXIGEM_OPCOES: ReadonlySet<TipoDoCampo> = new Set(["select", "multiselect"]);

/**
 * O que é próprio do tipo e mora em `config` — as MESMAS chaves que a projeção do banco copia para o
 * item de `fields` (ver `fn_campos_personalizados_projetados`). Chave fora daqui não é gravada.
 */
export const configDoCampoSchema = z
  .object({
    options: customFieldSchema.shape.options,
    mostrar_quando: mostrarQuandoSchema.optional(),
    // `null` só tem sentido na ALTERAÇÃO: tira a chave do config (merge por chave em `alterarDefinicao`).
    // É o que a tela manda ao apagar a validação; a criação o ignora (`configLimpo`).
    padrao: z.string().max(500).nullable().optional(),
    mensagem_padrao: z.string().max(200).nullable().optional(),
    allow_new: z.boolean().optional(),
    multiple: z.boolean().optional(),
    moeda: z.enum(MOEDAS_DO_CAMPO).nullable().optional(),
  })
  .strict();
export type ConfigDoCampo = z.infer<typeof configDoCampoSchema>;

const textoOpcional = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .nullable()
    .optional();

const propriedadesEditaveis = {
  label: z.string().trim().min(1).max(80),
  descricao: textoOpcional(500),
  grupo: z.enum(["dados", "rastreamento"]).nullable().optional(),
  obrigatorio: z.boolean().optional(),
  publico: z.boolean().optional(),
  sempre_visivel: z.boolean().optional(),
  exibir_no_perfil: z.boolean().optional(),
  dica_de_ajuda: textoOpcional(300),
  config: configDoCampoSchema.optional(),
};

/** Criar: tudo o que a tela manda. `key`, `entidade` e `type` só aqui — depois não mudam. */
export const novaDefinicaoSchema = z
  .object({
    entidade: z.enum(ENTIDADES_DE_CAMPO),
    key: customFieldSchema.shape.key,
    type: customFieldSchema.shape.type,
    ...propriedadesEditaveis,
  })
  .strict();
export type NovaDefinicao = z.infer<typeof novaDefinicaoSchema>;

/**
 * Alterar: as mesmas propriedades, todas opcionais. `strict()` RECUSA `key`, `type` e `entidade`
 * em vez de ignorá-los em silêncio — quem os manda acha que mudou e não mudou.
 */
export const alteracaoDeDefinicaoSchema = z
  .object({
    ...propriedadesEditaveis,
    label: propriedadesEditaveis.label.optional(),
  })
  .strict();
export type AlteracaoDeDefinicao = z.infer<typeof alteracaoDeDefinicaoSchema>;

/** Uma linha de `custom_field_definitions`, como o PostgREST devolve. */
export interface DefinicaoDeCampo {
  id: string;
  organization_id: string;
  entidade: EntidadeDoCampo;
  key: string;
  label: string;
  type: TipoDoCampo;
  descricao: string | null;
  grupo: "dados" | "rastreamento" | null;
  obrigatorio: boolean;
  publico: boolean;
  sempre_visivel: boolean;
  exibir_no_perfil: boolean;
  dica_de_ajuda: string | null;
  config: Record<string, unknown>;
  position: number | string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export const COLUNAS_DA_DEFINICAO =
  "id, organization_id, entidade, key, label, type, descricao, grupo, obrigatorio, publico, sempre_visivel, exibir_no_perfil, dica_de_ajuda, config, position, created_at, updated_at, created_by, updated_by";

/**
 * Coerência de tipo × configuração. Devolve a razão da recusa (em português, chave do dicionário),
 * ou `null`. As MESMAS regras que `lib/pipelines/campos-do-funil.ts` aplicava por funil.
 */
export function incoerenciaDaDefinicao(type: TipoDoCampo, config: ConfigDoCampo | undefined): string | null {
  const opcoes = config?.options;
  if (TIPOS_QUE_EXIGEM_OPCOES.has(type) && (opcoes?.length ?? 0) === 0) {
    return "Campo de lista precisa de pelo menos uma opção.";
  }
  if (!TIPOS_COM_OPCOES.has(type) && opcoes !== undefined) {
    return "Só campos de lista têm opções.";
  }
  if (opcoes) {
    const valores = opcoes.map((o) => o.value);
    if (new Set(valores).size !== valores.length) return "As opções do campo têm valores repetidos.";
  }
  if (type !== "searchable_select" && (config?.allow_new !== undefined || config?.multiple !== undefined)) {
    return "Permitir valor novo e múltipla escolha só existem na lista pesquisável.";
  }
  if (type !== "currency" && config?.moeda != null) {
    return "Só campos de moeda têm moeda.";
  }
  if (typeof config?.padrao === "string" && config.padrao.trim() !== "") {
    try {
      new RegExp(config.padrao);
    } catch {
      return "A expressão de validação não é válida.";
    }
  }
  return null;
}

/** Só as chaves de `config` que a projeção copia; o resto (de uma versão futura, por exemplo) fica. */
const CHAVES_PROJETADAS = ["options", "mostrar_quando", "padrao", "mensagem_padrao", "allow_new", "multiple", "moeda"] as const;

/**
 * A definição na forma de UM item de `settings.fields` — espelho de
 * `fn_campos_personalizados_projetados`. Ausência é o padrão de toda prop: `publico` só aparece
 * quando é `false`, `escopo` só quando é `contato`, e assim por diante.
 */
export function paraCampoDoFunil(
  d: Pick<
    DefinicaoDeCampo,
    | "key"
    | "label"
    | "type"
    | "entidade"
    | "obrigatorio"
    | "grupo"
    | "descricao"
    | "publico"
    | "sempre_visivel"
    | "exibir_no_perfil"
    | "dica_de_ajuda"
    | "config"
  >,
  obrigatorioEm?: CustomFieldDef["obrigatorio_em"],
): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const chave of CHAVES_PROJETADAS) {
    const valor = (d.config ?? {})[chave];
    if (valor !== undefined && valor !== null) item[chave] = valor;
  }
  item.key = d.key;
  item.label = d.label;
  item.type = d.type;
  if (d.obrigatorio) item.required = true;
  if (d.grupo) item.grupo = d.grupo;
  if (d.entidade === "contato") item.escopo = "contato";
  if (d.descricao) item.descricao = d.descricao;
  if (d.publico === false) item.publico = false;
  if (d.sempre_visivel) item.sempre_visivel = true;
  if (d.exibir_no_perfil) item.exibir_no_perfil = true;
  if (d.dica_de_ajuda) item.dica_de_ajuda = d.dica_de_ajuda;
  if (obrigatorioEm && typeof obrigatorioEm === "object") item.obrigatorio_em = obrigatorioEm;
  return item;
}

/**
 * A REGRA DE OBRIGATORIEDADE de um funil: `settings.campos_obrigatorios`, chave → regra. Lixo vira
 * ausência (o leitor do funil nunca explode por causa de um jsonb velho).
 */
export const regraDeObrigatoriedadeSchema = customFieldSchema.shape.obrigatorio_em.unwrap();
export const camposObrigatoriosSchema = camposObrigatoriosDoFunilSchema;
export type CamposObrigatorios = z.infer<typeof camposObrigatoriosSchema>;

export function camposObrigatoriosDoFunil(settings: Record<string, unknown> | null | undefined): CamposObrigatorios {
  const bruto = settings?.campos_obrigatorios;
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return {};
  const saida: CamposObrigatorios = {};
  for (const [chave, regra] of Object.entries(bruto as Record<string, unknown>)) {
    const lida = regraDeObrigatoriedadeSchema.safeParse(regra);
    if (lida.success && customFieldSchema.shape.key.safeParse(chave).success) saida[chave] = lida.data;
  }
  return saida;
}

/** Os presets do Regex de validação (aba Avançado). `custom` é o que a pessoa digitar. */
export const PRESETS_DE_VALIDACAO = {
  nenhum: null,
  email: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
  url: "^https?://\\S+$",
  telefone: "^\\+?[0-9 ()-]{8,20}$",
} as const;
export type PresetDeValidacao = keyof typeof PRESETS_DE_VALIDACAO | "custom";

/** Qual preset o `padrao` gravado é — `custom` quando não casa com nenhum. */
export function presetDoPadrao(padrao: string | undefined | null): PresetDeValidacao {
  if (!padrao || padrao.trim() === "") return "nenhum";
  for (const [nome, regex] of Object.entries(PRESETS_DE_VALIDACAO)) {
    if (regex === padrao) return nome as PresetDeValidacao;
  }
  return "custom";
}

/** Contadores da aba Estatísticas, como a rota devolve. */
export interface EstatisticasDoCampo {
  total: number;
  preenchidos: number;
  vazios: number;
  /** 0 a 100, uma casa. `0` quando não há registro nenhum. */
  taxa: number;
  ultimo_uso: string | null;
  tamanho_medio: number | null;
  criado_em: string;
  editado_em: string;
}

/** A conta da taxa, de um lugar só (a rota e o aviso da exclusão). */
export function estatisticasDe(
  bruto: { total?: unknown; preenchidos?: unknown; anexados?: unknown; ultimo_uso?: unknown; tamanho_medio?: unknown },
  definicao: Pick<DefinicaoDeCampo, "type" | "created_at" | "updated_at">,
): EstatisticasDoCampo {
  const total = Number(bruto.total ?? 0) || 0;
  // Arquivo não mora em `custom_fields`: quem conta é `crm_lead_attachments` (`anexados`).
  const preenchidos = Math.min(
    total,
    Number((definicao.type === "file" ? bruto.anexados : bruto.preenchidos) ?? 0) || 0,
  );
  const tamanho = bruto.tamanho_medio === null || bruto.tamanho_medio === undefined ? null : Number(bruto.tamanho_medio);
  return {
    total,
    preenchidos,
    vazios: total - preenchidos,
    taxa: total === 0 ? 0 : Math.round((preenchidos / total) * 1000) / 10,
    ultimo_uso: typeof bruto.ultimo_uso === "string" ? bruto.ultimo_uso : null,
    tamanho_medio: tamanho !== null && Number.isFinite(tamanho) ? tamanho : null,
    criado_em: definicao.created_at,
    editado_em: definicao.updated_at,
  };
}
