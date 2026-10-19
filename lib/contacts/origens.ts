/**
 * As origens de contato que a tela oferece como filtro (`contacts.source`) e o
 * rótulo que a exportação escreve. Uma lista só: a tela e o CSV falam igual.
 */
export const ORIGENS_DE_CONTATO: ReadonlyArray<{ value: string; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "site", label: "Site (landing page)" },
  { value: "nuvemshop", label: "Nuvemshop" },
  { value: "import_csv", label: "Importado (CSV)" },
  // Os dois valores que a atribuição de anúncio grava em `contacts.source`
  // (`PlataformaDeAnuncio` em lib/leads/atribuicao-de-anuncio.ts). Sem eles, o
  // contato que veio de um clique em anúncio existe no banco e não é alcançável
  // por nenhum filtro desta tela.
  { value: "meta_ads", label: "Anúncio da Meta" },
  { value: "google_ads", label: "Anúncio do Google" },
];

/** O rótulo da origem; valor desconhecido volta como está (não esconde dado). */
export function rotuloDaOrigem(valor: string | null | undefined): string {
  if (!valor) return "";
  return ORIGENS_DE_CONTATO.find((o) => o.value === valor)?.label ?? valor;
}
