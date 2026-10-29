/**
 * Os UTMs que a lista de Contatos mostra como coluna ("Personalizar colunas").
 *
 * O UTM NÃO mora no contato: a captação grava no NEGÓCIO (`crm_leads.custom_fields`). A coluna
 * é CALCULADA na leitura (doutrina DIRC: "calcular"), nunca copiada para o contato: para cada
 * chave, vale o valor do negócio MAIS RECENTE (`created_at`) do contato que tem aquela chave
 * preenchida. Decisão do dono do produto. Cada chave é escolhida por conta própria: o
 * `utm_source` pode vir de um negócio e o `utm_term` de outro, mais antigo.
 *
 * PURO. Quem busca os negócios (uma consulta só, por página) é `listContactsHandler`.
 */

export const CHAVES_DE_UTM = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

export type ChaveDeUtm = (typeof CHAVES_DE_UTM)[number];

/** Só as chaves achadas; chave ausente = nenhum negócio do contato a tem. */
export type UtmsDoContato = Partial<Record<ChaveDeUtm, string>>;

/** Um negócio como a consulta o devolve: o contato, a data e cada UTM já extraído do JSON. */
export type NegocioComUtm = {
  contact_id: string | null;
  created_at: string;
} & Partial<Record<ChaveDeUtm, unknown>>;

const CHAVES = new Set<string>(CHAVES_DE_UTM);

export function ehChaveDeUtm(id: string): id is ChaveDeUtm {
  return CHAVES.has(id);
}

/** Valor preenchido como texto, ou `null` (ausente, vazio, só espaço, objeto). */
function textoDoUtm(v: unknown): string | null {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function instante(iso: string): number {
  const n = Date.parse(iso);
  return Number.isNaN(n) ? Number.NEGATIVE_INFINITY : n;
}

/**
 * Os UTMs de cada contato, pelo negócio mais recente que tem cada chave. Não depende da ordem
 * de entrada. Contato sem negócio com UTM não aparece no mapa.
 */
export function utmsMaisRecentesPorContato(
  negocios: readonly NegocioComUtm[],
): Map<string, UtmsDoContato> {
  const melhor = new Map<string, Map<ChaveDeUtm, { valor: string; quando: number }>>();
  for (const n of negocios) {
    if (!n.contact_id) continue;
    const quando = instante(n.created_at);
    for (const chave of CHAVES_DE_UTM) {
      const valor = textoDoUtm(n[chave]);
      if (valor === null) continue;
      let doContato = melhor.get(n.contact_id);
      if (!doContato) {
        doContato = new Map();
        melhor.set(n.contact_id, doContato);
      }
      const atual = doContato.get(chave);
      if (!atual || quando > atual.quando) doContato.set(chave, { valor, quando });
    }
  }
  const saida = new Map<string, UtmsDoContato>();
  for (const [contato, chaves] of melhor) {
    const utms: UtmsDoContato = {};
    for (const [chave, { valor }] of chaves) utms[chave] = valor;
    saida.set(contato, utms);
  }
  return saida;
}

/** O `select` do PostgREST: só o contato, a data e os 5 UTMs extraídos (nunca o JSON inteiro). */
export const SELECT_DE_UTM = [
  "contact_id",
  "created_at",
  ...CHAVES_DE_UTM.map((c) => `${c}:custom_fields->>${c}`),
].join(", ");

/** Teto de negócios com UTM lidos por página de contatos: o `max_rows` padrão do PostgREST. */
export const UTM_LINHAS_POR_PAGINA = 1000;

/** O `or` que deixa de fora o negócio sem UTM nenhum. */
export const FILTRO_TEM_UTM = CHAVES_DE_UTM.map((c) => `custom_fields->>${c}.not.is.null`).join(",");
