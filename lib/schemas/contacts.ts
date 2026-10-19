/**
 * Zod schemas for `/api/v1/contacts/*` endpoints (EPIC-05 waves 1, 2, 8).
 *
 * Contracts:
 *  - contactCreateSchema    → POST /api/v1/contacts
 *  - contactPatchSchema     → PATCH /api/v1/contacts/[id]
 *  - contactListQuerySchema → GET /api/v1/contacts (search/tag/source/cursor)
 *  - lgpdAnonymizeSchema    → POST /api/v1/lgpd/anonymize (irreversible)
 */
import { z } from "zod";

import { chaveSensivelDeCampo } from "@/lib/contacts/campos-sensiveis";
import { normalizarTag, normalizarTags } from "@/lib/contacts/tag-normalizada";
import { isValidCpf, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";

import { objetoComTeto, TETO_DE_TAGS } from "./tetos";

const PHONE_REGEX = /^\+\d{8,15}$/;

/**
 * Teto de 32 KB no jsonb inteiro. O CHECK do banco só garante que é OBJETO —
 * sem limite de tamanho, um cliente da API escreveria megabytes numa coluna que
 * a listagem de contatos traz inteira, e o custo apareceria como "a tela de
 * contatos ficou lenta", longe da causa.
 */
const CUSTOM_FIELDS_MAX_BYTES = 32_768;

const customFieldsSchema = z
  .record(z.string().min(1).max(80), z.unknown())
  .refine((value) => JSON.stringify(value).length <= CUSTOM_FIELDS_MAX_BYTES, {
    message: "Campos personalizados excedem o limite de 32 KB",
  });

/**
 * O mod-11 da Receita Federal mora no PERFIL do país
 * (`lib/legal/perfil-do-pais.ts`), porque é ele quem responde pelo documento do
 * titular — aqui fica só o re-export, para não existirem duas implementações da
 * mesma regra. Quem importava deste módulo (rota de importação, testes,
 * `lib/schemas/index.ts`) continua importando.
 */
export { isValidCpf };

export const contactCreateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  display_name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  phone_number: z
    .string()
    .regex(PHONE_REGEX, "Telefone deve estar em formato E.164 (+5511999998888)")
    .optional(),
  cpf: z.string().refine(isValidCpf, "CPF inválido").optional(),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  // O marcador nasce em caixa baixa, pela MESMA regra da tag de conversa: o
  // "VIP" gravado verbatim não casava com o filtro `?tag=vip` (issue #1224).
  tags: z.array(z.string().max(200)).max(TETO_DE_TAGS).transform(normalizarTags).optional(),
  source: z.string().min(1).default("manual"),
  source_metadata: objetoComTeto.optional(),
  consent: objetoComTeto.optional(),
  custom_fields: customFieldsSchema.optional(),
});
export type ContactCreate = z.infer<typeof contactCreateSchema>;

/**
 * O PATCH genérico NÃO aceita `consent` nem `source_metadata` (D-151).
 *
 * Quem escreve pelo PATCH é a tela, um token de API ou um agente. Com o
 * consentimento ali, um `{"consent":{"marketing":{}}}` trocava a entrada de
 * marketing e a recusa (`declined_at`) sumia: a guarda de automação e a de
 * prospecção voltavam a liberar o envio. E `source_metadata.ad_id` livre
 * alimentava a hierarquia do anúncio. O consentimento tem rota própria
 * (`POST /api/v1/contacts/{id}/consent`, manager, só registra) e a origem é
 * escrita pela captação, nunca por edição. Mandar a chave é 422, e não descarte
 * em silêncio: quem chamou precisa saber que o campo não foi gravado.
 */
const CAMPO_FORA_DO_PATCH =
  "Este campo não é editável por aqui. Consentimento: POST /api/v1/contacts/{id}/consent. A origem do contato é gravada só pela captação.";

export const contactPatchSchema = contactCreateSchema.partial().extend({
  source: z.string().min(1).optional(),
  consent: z.never({ error: CAMPO_FORA_DO_PATCH }).optional(),
  source_metadata: z.never({ error: CAMPO_FORA_DO_PATCH }).optional(),
});
export type ContactPatch = z.infer<typeof contactPatchSchema>;

/**
 * O que `patchContactHandler` aceita: o PATCH da API mais o `consent` (e a
 * origem) que só código do servidor passa (a confirmação de dado proposto pela
 * IA grava a base legal junto). O schema HTTP nunca produz essas chaves.
 */
export type ContactPatchInterno = Omit<ContactPatch, "consent" | "source_metadata"> & {
  consent?: Record<string, unknown>;
  source_metadata?: Record<string, unknown>;
};

/**
 * O documento do titular vem do PERFIL DO PAÍS da organização (issue #1033).
 *
 * `contactCreateSchema` continua sendo a régua brasileira — é o schema que as
 * telas de cliente usam e o comportamento de quem já instalou. Estas fábricas
 * só trocam o campo do documento: tudo o mais é o MESMO schema, estendido, e
 * não uma segunda cópia — duas listas de campos divergem no dia em que uma
 * ganhar um campo novo.
 *
 * Por que fábrica e não ler o país aqui dentro: o schema é síncrono e puro, e a
 * resposta certa vem do banco (`perfilDaOrganizacao`), resolvida uma vez por
 * requisição na borda. O que NÃO se faz é deixar o corpo da requisição escolher
 * o país — quem decide é a organização, pela coluna dela (mesma doutrina da
 * moeda em `lib/catalogo/moeda-da-org.ts`).
 */
export function contactCreateSchemaDoPais(perfil: PerfilDoPais) {
  return contactCreateSchema.extend({
    cpf: z
      .string()
      .refine(perfil.documento.valida, perfil.documento.mensagemInvalido)
      .optional(),
  });
}

/** O mesmo, para o PATCH (`app/api/v1/contacts/[id]/route.ts`). */
export function contactPatchSchemaDoPais(perfil: PerfilDoPais) {
  return contactPatchSchema.extend({
    cpf: z
      .string()
      .refine(perfil.documento.valida, perfil.documento.mensagemInvalido)
      .optional(),
  });
}

export const CONTACT_ORDER_BY = [
  "last_activity_at",
  "created_at",
  "display_name",
  "email",
  "phone_number",
] as const;

/** Atalhos de período — os mesmos do quadro do funil (`lib/kanban/datas-do-lead.ts`). */
const PERIODOS_DE_CONTATOS = ["hoje", "7d", "30d", "mes"] as const;
/** Janela de datas aceita nos filtros: fora dela (`9999-12-31`) o cálculo do dia seguinte vira 500 no banco. */
export const DIA_MINIMO_DO_FILTRO = "2000-01-01";
export const DIA_MAXIMO_DO_FILTRO = "2100-12-31";
const DIA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const diaIso = () =>
  z
    .string()
    .regex(DIA_ISO)
    .refine((d) => d >= DIA_MINIMO_DO_FILTRO && d <= DIA_MAXIMO_DO_FILTRO, {
      message: "Data fora do intervalo aceito.",
    });
/** Chave de campo personalizado que o filtro aceita: vira caminho JSON no PostgREST, então só letras, números e `_`. */
export const CHAVE_DE_CAMPO_FILTRAVEL = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

/**
 * Os filtros da lista de contatos — a MESMA forma na URL da tela, na query do
 * GET, e (como objeto) no corpo de "excluir/exportar todos do filtro". Uma
 * definição só: o que a tela mostra, o que se exclui e o que se exporta são o
 * mesmo conjunto porque passam pela mesma régua (`lib/contacts/consulta.ts`).
 */
const formaDosFiltros = {
    search: z.string().max(200).optional(),
    // O filtro normaliza pelo MESMO caminho da escrita: `?tag=VIP` acha o que a
    // ficha gravou como "vip" (issue #1224).
    tag: z.string().transform(normalizarTag).optional(),
    source: z.string().max(80).optional(),
    /** Entrou no CRM (`contacts.created_at`): atalho OU `criado_de`/`criado_ate`. */
    criado: z.enum(PERIODOS_DE_CONTATOS).optional(),
    criado_de: diaIso().optional(),
    criado_ate: diaIso().optional(),
    /** Última atividade (`contacts.last_activity_at`). */
    ativ: z.enum(PERIODOS_DE_CONTATOS).optional(),
    ativ_de: diaIso().optional(),
    ativ_ate: diaIso().optional(),
    /** Contatos que têm negócio neste funil (e, opcionalmente, nesta etapa). */
    funil: z.string().uuid().optional(),
    etapa: z.string().uuid().optional(),
    /** Campo personalizado: do contato ou de algum negócio dele. */
    campo_escopo: z.enum(["contato", "negocio"]).default("contato"),
    campo: z
      .string()
      .regex(CHAVE_DE_CAMPO_FILTRAVEL)
      .refine((c) => !chaveSensivelDeCampo(c), { message: "Campo não filtrável." })
      .optional(),
    campo_op: z.enum(["contem", "igual"]).default("contem"),
    campo_valor: z.string().min(1).max(200).optional(),
};

const campoEValorJuntos = (v: { campo?: string; campo_valor?: string }) => !v.campo === !v.campo_valor;
const MENSAGEM_CAMPO_E_VALOR = { message: "Informe o campo e o valor juntos.", path: ["campo_valor"] };

export const filtrosDeContatosSchema = z
  .object(formaDosFiltros)
  .refine(campoEValorJuntos, MENSAGEM_CAMPO_E_VALOR);
export type FiltrosDeContatos = z.output<typeof filtrosDeContatosSchema>;
export type FiltrosDeContatosEntrada = z.input<typeof filtrosDeContatosSchema>;

export const contactListQuerySchema = z
  .object({
    ...formaDosFiltros,
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    order_by: z.enum(CONTACT_ORDER_BY).default("last_activity_at"),
    order_dir: z.enum(["asc", "desc"]).default("desc"),
  })
  .refine(campoEValorJuntos, MENSAGEM_CAMPO_E_VALOR);
export type ContactListQuery = z.output<typeof contactListQuerySchema>;
export type ContactListQueryParams = z.input<typeof contactListQuerySchema>;
export type ContactOrderBy = (typeof CONTACT_ORDER_BY)[number];

export const lgpdAnonymizeSchema = z.object({
  contact_id: z.string().uuid(),
  justification: z.string().min(10).max(1000),
});
export type LgpdAnonymizeInput = z.infer<typeof lgpdAnonymizeSchema>;

/**
 * Juntar contatos duplicados.
 *
 * O principal fica FORA do array de secundários e o `refine` é o que garante
 * isso na borda — `fn_mesclar_contatos` recusa o mesmo caso com `22023`, mas um
 * 422 com a lista de campos é o que a tela consegue mostrar. As duas guardas
 * existem porque a rota não é a única porta: a RPC é alcançável por
 * `authenticated` (é assim que a RLS a autoriza), e ela precisa se defender só.
 *
 * O teto de 20 secundários por chamada não é arbitrário: a fusão trava as
 * linhas (`for update`) e reponta toda FK que aponta para elas: um lote grande
 * segura escrita de contato para a organização inteira enquanto roda.
 */
export const contactsMergeSchema = z
  .object({
    primary_contact_id: z.string().uuid(),
    secondary_contact_ids: z.array(z.string().uuid()).min(1).max(20),
  })
  .refine((v) => !v.secondary_contact_ids.includes(v.primary_contact_id), {
    message: "O contato principal não pode estar entre os que serão absorvidos.",
    path: ["secondary_contact_ids"],
  })
  .refine((v) => new Set(v.secondary_contact_ids).size === v.secondary_contact_ids.length, {
    message: "Contato repetido na seleção.",
    path: ["secondary_contact_ids"],
  });
export type ContactsMergeInput = z.infer<typeof contactsMergeSchema>;

/** Teto de contatos por chamada de exclusão em lote. */
export const TETO_DA_EXCLUSAO_EM_LOTE = 5_000;
/** Teto de linhas por exportação. */
export const TETO_DA_EXPORTACAO = 20_000;

/**
 * Quem entra num lote: ids explícitos (a seleção da tela) OU "todos do filtro".
 * "Todos do filtro" nunca viaja como lista de milhares de ids: o servidor
 * resolve o filtro, e `esperado` é a contagem que a pessoa VIU — se a lista
 * mudou no meio do caminho, a exclusão recusa em vez de apagar outro conjunto.
 */
export const alvoDeLoteSchema = z.union([
  z.object({
    ids: z.array(z.string().uuid()).min(1).max(TETO_DA_EXCLUSAO_EM_LOTE),
  }),
  z.object({
    filtro: filtrosDeContatosSchema,
    esperado: z.number().int().min(1),
  }),
]);
export type AlvoDeLote = z.output<typeof alvoDeLoteSchema>;

export const contactsBulkDeleteSchema = alvoDeLoteSchema;

/** Exportação: o mesmo alvo, sem teto de ids de exclusão (o teto é o da exportação). */
export const contactsExportSchema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(TETO_DA_EXPORTACAO) }),
  z.object({ filtro: filtrosDeContatosSchema, esperado: z.number().int().min(1).optional() }),
]);
export type ContactsExportInput = z.output<typeof contactsExportSchema>;
