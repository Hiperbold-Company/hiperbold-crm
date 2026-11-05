/**
 * OS PROBLEMAS DE UM FLUXO IMPORTADO SAEM NO IDIOMA DE QUEM LÊ — EM TODO IDIOMA.
 *
 * Medido no senkron da v1.86.0: `lib/followup/portabilidade.ts` chegou com
 * `LOCALE_DO_ZOD` só com `pt-BR` e `es`. Para quem usa turco, `zodNoIdioma("tr")`
 * chamava `undefined()`, e a importação de fluxo
 * (`/api/v1/ai/followup-flows/import`) quebrava com TypeError antes de ler o
 * arquivo. O `Record<Idioma, …>` já cobrava a linha no `tsc`, mas o vitest não
 * roda o `tsc`, e nenhum teste passava "tr".
 *
 * A guarda percorre `IDIOMAS`: um idioma promovido no registro entra na conta
 * no mesmo dia, sem ninguém lembrar deste mapa.
 */
import { describe, expect, it } from "vitest";

import { arquivoDeFluxoSchema, problemasDoArquivo, zodNoIdioma } from "@/lib/followup/portabilidade";
import { IDIOMAS } from "@/lib/i18n/idiomas";

const ARQUIVO_DE_OUTRO_FORMATO = { format: "outro", version: 1, flow: {} };

/** As palavras das mensagens genéricas do Zod sem locale (inglês). */
const PALAVRA_EM_INGLES = /\b(Invalid|expected|received)\b/;

/** Idioma cuja língua É o inglês: lá, mensagem em inglês é o certo e a régua acima não se aplica. */
const IDIOMA_QUE_FALA_INGLES = (idioma: string) => idioma === "en" || idioma.startsWith("en-");

describe("importar fluxo: os problemas saem no idioma de quem lê", () => {
  it.each(IDIOMAS)("%s tem locale do Zod, e (fora o inglês) nenhuma linha fica em inglês", (idioma) => {
    const r = arquivoDeFluxoSchema.safeParse(ARQUIVO_DE_OUTRO_FORMATO, zodNoIdioma(idioma));
    expect(r.success).toBe(false);
    if (!r.success) {
      const problemas = problemasDoArquivo(r.error);
      expect(problemas.length).toBeGreaterThan(0);
      if (!IDIOMA_QUE_FALA_INGLES(idioma)) {
        expect(problemas.filter((linha) => PALAVRA_EM_INGLES.test(linha))).toEqual([]);
      }
    }
  });
});
