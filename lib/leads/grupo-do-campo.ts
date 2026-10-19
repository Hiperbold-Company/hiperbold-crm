/**
 * Em qual bloco da ficha um campo do funil aparece: "Dados do lead" ou
 * "Rastreamento".
 *
 * O grupo vive em `crm_pipelines.settings.fields[].grupo` (jsonb, sem migration).
 * Funil antigo não tem a chave, e por isso AUSENTE é INFERIDO pela chave do campo:
 * quem importou `utm_source` ou `gclid` no funil não precisa reabrir cada campo
 * para a ficha sair arrumada.
 *
 * Função pura e sem import de env/Supabase de propósito: a tela, o editor de
 * campos e o teste usam a MESMA regra, e uma segunda cópia dela divergiria no
 * primeiro parâmetro de rastreamento novo.
 */
export const GRUPOS_DE_CAMPO = ["dados", "rastreamento"] as const;
export type GrupoDeCampo = (typeof GRUPOS_DE_CAMPO)[number];

/** Ordem dos blocos na ficha: o que descreve a pessoa primeiro, de onde veio depois. */
export const ROTULO_DO_GRUPO: Record<GrupoDeCampo, string> = {
  dados: "Dados do lead",
  rastreamento: "Rastreamento",
};

/** Identificadores de clique/campanha que não começam com `utm_`. */
const CHAVES_DE_RASTREAMENTO = new Set([
  "gclid",
  "fbclid",
  "gbraid",
  "wbraid",
  "ttclid",
  "msclkid",
  "src",
  "sck",
  "xcod",
]);

/** A inferência, pela chave. Sem caixa: `UTM_Source` e `GCLID` valem como minúsculas. */
export function inferirGrupoPelaChave(chave: string): GrupoDeCampo {
  const k = chave.trim().toLowerCase();
  if (k.startsWith("utm_") || CHAVES_DE_RASTREAMENTO.has(k)) return "rastreamento";
  return "dados";
}

/** O grupo declarado; na falta dele, o inferido. */
export function grupoDoCampo(campo: { key: string; grupo?: GrupoDeCampo | null }): GrupoDeCampo {
  return campo.grupo === "dados" || campo.grupo === "rastreamento"
    ? campo.grupo
    : inferirGrupoPelaChave(campo.key);
}

/**
 * Separa os campos nos blocos da ficha, na ordem de `GRUPOS_DE_CAMPO`, mantendo a
 * ordem do funil dentro de cada um. Bloco sem campo NÃO entra na resposta: é assim
 * que "bloco vazio não aparece" deixa de depender de quem desenha a tela.
 */
export function agruparCampos<T extends { key: string; grupo?: GrupoDeCampo | null }>(
  campos: readonly T[],
): Array<{ grupo: GrupoDeCampo; campos: T[] }> {
  return GRUPOS_DE_CAMPO.map((grupo) => ({
    grupo,
    campos: campos.filter((c) => grupoDoCampo(c) === grupo),
  })).filter((b) => b.campos.length > 0);
}
