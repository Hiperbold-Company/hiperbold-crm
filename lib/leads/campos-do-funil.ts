import { customFieldSchema, type CustomFieldDef } from "@/lib/schemas/settings";

/**
 * Lê `pipelines.settings.fields` sem explodir se o jsonb estiver velho ou vazio.
 *
 * ⚠️ DESDE A MIGRATION 1015 este array é PROJEÇÃO: quando a organização tem campos em
 * `custom_field_definitions`, o banco o deriva delas (contato + negócio, todos os funis) com a
 * obrigatoriedade DESTE funil (`settings.campos_obrigatorios`). Organização sem definição nenhuma —
 * ou clone que ainda não aplicou a 1015 — continua com a lista que o funil declarava (legado). Os
 * dois caminhos chegam aqui na MESMA forma, e é por isso que nenhum leitor precisou mudar.
 */
export function camposDoFunil(settings: Record<string, unknown> | null | undefined): CustomFieldDef[] {
  if (!settings) return [];
  const raw = settings.fields;
  if (!Array.isArray(raw)) return [];
  const out: CustomFieldDef[] = [];
  for (const item of raw) {
    const parsed = customFieldSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** A que pertence o campo (issue #2791): ao negócio ou ao contato. */
export type EscopoDoCampo = "negocio" | "contato";

/**
 * O escopo do campo, com a ausência valendo `negocio`.
 *
 * A chave é opcional no `settings` de propósito: toda definição que já existe
 * não a tem, e a leitura dela é `negocio` — sem isto, funil antigo mudaria de
 * comportamento no dia em que a propriedade nasceu.
 */
export function escopoDoCampo(campo: Pick<CustomFieldDef, "escopo">): EscopoDoCampo {
  return campo.escopo === "contato" ? "contato" : "negocio";
}

/** Os campos de UM escopo, na ordem em que o funil os declara. */
export function camposPorEscopo(
  campos: CustomFieldDef[],
  escopo: EscopoDoCampo,
): CustomFieldDef[] {
  return campos.filter((campo) => escopoDoCampo(campo) === escopo);
}

/**
 * O embed `crm_pipelines(settings)` do PostgREST vem objeto (FK to-one) ou,
 * se a relação vacilar, array. Os dois caem aqui — lixo vira `null`.
 */
export function settingsDoEmbed(embed: unknown): Record<string, unknown> | null {
  const alvo = Array.isArray(embed) ? embed[0] : embed;
  if (!alvo || typeof alvo !== "object") return null;
  const settings = (alvo as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  return settings as Record<string, unknown>;
}


/**
 * Os campos que o gatilho "N dias até uma data do funil" pode usar: DATA e do
 * NEGÓCIO.
 *
 * A varredura (`app/api/v1/cron/lead-date-field-due`) lê `crm_leads.custom_fields`,
 * e o valor de um campo do CONTATO (#2791) mora em `contacts.custom_fields` — uma
 * regra apontada para ele é salva, o dia chega, e nada dispara. É a lista que
 * os seletores (editor de regras, Designer, calendário do funil) oferecem.
 */
export function camposDeDataDoNegocio(
  settings: Record<string, unknown> | null | undefined,
): CustomFieldDef[] {
  return camposPorEscopo(camposDoFunil(settings), "negocio").filter((campo) => campo.type === "date");
}

/**
 * Os campos do NEGÓCIO que guardam ARQUIVO (#2829) — o `type: "file"` do funil.
 *
 * O anexo NÃO mora em `crm_leads.custom_fields`: mora em `crm_lead_attachments`,
 * uma linha por arquivo, presa a `lead_id` + `field_key`. Quem lê o card precisa
 * da DEFINIÇÃO (chave e rótulo) para saber quais campos desenhar — inclusive os
 * VAZIOS, que aparecem como tal —, e é por isso que esta lista sai do funil e
 * não da tabela de anexos.
 *
 * Só o escopo do negócio: arquivo de CONTATO não tem onde ser pendurado (a
 * tabela exige `lead_id`), e `CustomFieldsEditor` já diz isso na ficha do
 * contato em vez de oferecer um uploader que não salvaria.
 */
export function camposDeArquivoDoNegocio(
  settings: Record<string, unknown> | null | undefined,
): CustomFieldDef[] {
  return camposPorEscopo(camposDoFunil(settings), "negocio").filter((campo) => campo.type === "file");
}

/**
 * A chave está declarada neste funil como campo do CONTATO? É a recusa do
 * servidor para o gatilho por data — a mesma regra do seletor, pela porta da API.
 * Chave não declarada não é recusada: o `custom_fields` do negócio aceita chave
 * livre, e a varredura a lê.
 */
export function campoEhDoContato(
  settings: Record<string, unknown> | null | undefined,
  chave: string,
): boolean {
  return camposDoFunil(settings).some((campo) => campo.key === chave && escopoDoCampo(campo) === "contato");
}


/**
 * O campo que este papel VÊ na ficha (1015): `publico: false` é só para administrador. Ausência é
 * público — toda definição anterior à 1015 continua visível a todos. Esconder não apaga valor.
 */
export function campoVisivelAoPapel(campo: { publico?: boolean }, ehAdmin: boolean): boolean {
  return ehAdmin || campo.publico !== false;
}

export function camposVisiveisAoPapel<T extends { publico?: boolean }>(campos: T[], ehAdmin: boolean): T[] {
  return campos.filter((campo) => campoVisivelAoPapel(campo, ehAdmin));
}

/**
 * Os campos do NEGÓCIO que ESTE funil mostra (decisão do dono do produto, 24/11/2026).
 *
 * O cadastro é da organização (1015) e todo funil recebe todos em `settings.fields`; o funil só
 * ESCOLHE em `settings.campos_visiveis`. Ausente/nulo = todos (todo funil que já existia). Campo do
 * CONTATO passa sempre: a escolha é só dos campos de negócio. Chave da lista que não existe mais é
 * ignorada. Esconder não apaga valor — quem filtra é só a TELA (formulário, ficha, quadro, lista) e
 * a exigência de obrigatórios; `fields`, a API, as automações e a varredura por data seguem com todos.
 */
export function camposVisiveisNoFunil<T extends Pick<CustomFieldDef, "key" | "escopo">>(
  settings: Record<string, unknown> | null | undefined,
  campos: T[],
): T[] {
  const lista = settings?.campos_visiveis;
  if (!Array.isArray(lista)) return campos;
  const visiveis = new Set(lista.filter((k): k is string => typeof k === "string"));
  return campos.filter((campo) => escopoDoCampo(campo) === "contato" || visiveis.has(campo.key));
}

/** `camposDoFunil` já recortado pela escolha do funil — o que as telas do negócio desenham. */
export function camposDoFunilVisiveis(settings: Record<string, unknown> | null | undefined): CustomFieldDef[] {
  return camposVisiveisNoFunil(settings, camposDoFunil(settings));
}
