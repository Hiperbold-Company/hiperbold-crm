import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { IDIOMAS_COM_CATALOGO, leitorDeCatalogos } from "@/lib/i18n/catalogos";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { DICIONARIO, traduzir, traduzirCom } from "@/lib/i18n/dicionario";
import { IdiomaProvider, useT } from "@/lib/i18n/IdiomaProvider";
import {
  IDIOMA_PADRAO,
  IDIOMAS,
  idiomaDaTela,
  idiomaDelNavegador,
  idiomaDoTexto,
  normalizarIdioma,
  parseAcceptLanguage,
  type Idioma,
} from "@/lib/i18n/idiomas";
import { IDIOMAS_COM_TEXTO, IDIOMAS_VISIVEIS, REGISTRO_DE_IDIOMAS, type IdiomaRegistrado } from "@/lib/i18n/registro";
import { profileSchema } from "@/lib/schemas/settings";

/**
 * UM IDIOMA QUE APARECE TRADUZ A TELA — medido pelo caminho que a tela usa.
 *
 * ─── O defeito que este arquivo vigia ──────────────────────────────────────
 *
 * Em 04/11/2026 (D-225) o inglês foi promovido a `completo` com o `en.json`
 * inteiro (14 mil frases), e o mapa `CATALOGOS` de `lib/i18n/catalogos.ts`
 * ficou `{}`. O seletor oferecia "English", a escolha era gravada, e `traduzir`
 * não achava frase nenhuma: a tela inteira seguia em português.
 *
 * A cobertura de tela (`i18n-espanhol-cobre-a-tela`) não viu porque lê o JSON
 * do DISCO. Este teste lê pelo `traduzir` e pelo `useT`, que é o que a pessoa vê.
 *
 * ─── Por que ele também cobre quem saiu do seletor ─────────────────────────
 *
 * Em 17/11/2026 espanhol e inglês saíram do seletor até a conferência tela a
 * tela. Quem já os tinha gravado tem de cair no português sem erro — e a língua
 * de um DESTINATÁRIO (`idiomaDoTexto`) não muda por uma decisão de interface.
 */

const PASTA = join(__dirname, "..", "..", "lib", "i18n", "traducoes");

function catalogoDoDisco(codigo: string): Record<string, string> {
  const arquivo = join(PASTA, `${codigo}.json`);
  return existsSync(arquivo) ? (JSON.parse(readFileSync(arquivo, "utf8")) as Record<string, string>) : {};
}

function Frase({ texto }: { texto: string }) {
  const t = useT();
  return createElement("span", { "data-testid": "frase" }, t(texto));
}

describe("a fonte declarada no registro é a que existe no disco", () => {
  it("todo idioma com catálogo em lib/i18n/traducoes declara fonteDoTexto: catalogo, e só ele", () => {
    // Sem isto, um idioma de catálogo marcado `dicionario` escaparia da cobrança
    // de tipo de `catalogos.ts` e repetiria o defeito do inglês.
    const comArquivo = readdirSync(PASTA)
      .filter((arquivo) => arquivo.endsWith(".json"))
      .map((arquivo) => arquivo.replace(/\.json$/, ""))
      .sort();
    const declarados = REGISTRO_DE_IDIOMAS.filter((idioma) => idioma.fonteDoTexto === "catalogo")
      .map((idioma) => idioma.codigo as string)
      .sort();
    expect(comArquivo.length).toBeGreaterThan(0);
    expect(declarados).toEqual(comArquivo);
  });
});

describe("todo idioma visível de catálogo chega à tela", () => {
  const visiveisDeCatalogo = IDIOMAS_VISIVEIS.filter(
    // Alargado: com só o português visível o tipo estreita a "dicionario".
    (idioma) => (idioma.fonteDoTexto as IdiomaRegistrado["fonteDoTexto"]) === "catalogo",
  );

  it("o leitor carrega o catálogo de cada um, e traduzir devolve a frase dele", () => {
    const faltando: string[] = [];
    for (const { codigo } of visiveisDeCatalogo) {
      if (!IDIOMAS_COM_CATALOGO.includes(codigo as Idioma)) faltando.push(`${codigo}: catálogo não carregado`);
      const amostra = Object.entries(catalogoDoDisco(codigo))
        .filter(([chave, valor]) => valor !== chave && !DICIONARIO[chave]?.[codigo as Exclude<Idioma, "pt-BR">])
        .slice(0, 200);
      if (amostra.length === 0) faltando.push(`${codigo}: catálogo sem frase própria para medir`);
      const erradas = amostra.filter(([chave, valor]) => traduzir(chave, codigo as Idioma) !== valor);
      if (erradas.length > 0) faltando.push(`${codigo}: ${erradas.length}/${amostra.length} frases saem em português`);
    }
    expect(faltando).toEqual([]);
  });

  it("o mesmo caminho de leitura traduz o inglês hoje, com o en.json do disco", () => {
    // O inglês está fora do seletor e o catálogo dele não vai no pacote; o
    // leitor e o `traduzir` são os mesmos, só o mapa vem do disco. Sem isto a
    // prova do caso acima ficaria vazia enquanto nenhum catálogo aparece.
    const comCatalogo = IDIOMAS_COM_TEXTO.filter((idioma) => idioma.fonteDoTexto === "catalogo");
    expect(comCatalogo.map((idioma) => idioma.codigo)).toContain("en");
    for (const { codigo } of comCatalogo) {
      const disco = catalogoDoDisco(codigo);
      const t = traduzirCom(leitorDeCatalogos({ [codigo]: disco }));
      const amostra = Object.entries(disco)
        .filter(([chave, valor]) => valor !== chave && !DICIONARIO[chave]?.[codigo as Exclude<Idioma, "pt-BR">])
        .slice(0, 200);
      expect(amostra.length, codigo).toBeGreaterThan(0);
      const erradas = amostra.filter(([chave, valor]) => t(chave, codigo as Idioma) !== valor);
      expect(erradas.length, `${codigo}: frases que saem em português`).toBe(0);
    }
    expect(traduzirCom(leitorDeCatalogos({ en: catalogoDoDisco("en") }))("Contatos", "en")).toBe("Contacts");
  });

  it("o useT dentro do IdiomaProvider pinta a frase do catálogo", () => {
    for (const { codigo } of visiveisDeCatalogo) {
      const [chave, valor] =
        Object.entries(catalogoDoDisco(codigo)).find(
          ([k, v]) => v !== k && !DICIONARIO[k]?.[codigo as Exclude<Idioma, "pt-BR">],
        ) ?? [];
      const { unmount } = render(
        createElement(IdiomaProvider, { locale: codigo, children: createElement(Frase, { texto: chave ?? "" }) }),
      );
      expect(screen.getByTestId("frase").textContent, codigo).toBe(valor);
      unmount();
    }
  });
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "accept-language": "es-MX,es;q=0.9,en;q=0.8" }),
}));

describe("espanhol e inglês fora do seletor (17/11/2026): só a TELA muda", () => {
  it("o seletor só oferece o português; a gravação e as saídas seguem aceitando es e en", () => {
    expect(IDIOMAS_VISIVEIS.map((idioma) => idioma.codigo)).toEqual(["pt-BR"]);
    expect(IDIOMAS).toEqual(["pt-BR", "es", "en"]);
    expect(profileSchema.shape.locale.safeParse("es").success).toBe(true);
  });

  it.each(["es", "en"])("quem tinha %s gravado vê a tela em português", (gravado) => {
    expect(idiomaDaTela(gravado)).toBe(IDIOMA_PADRAO);
    render(
      createElement(IdiomaProvider, { locale: idiomaDaTela(gravado), children: createElement(Frase, { texto: "Contatos" }) }),
    );
    expect(screen.getByTestId("frase").textContent).toBe("Contatos");
  });

  it("idiomaDaTela: visível segue ele mesmo; o resto cai no padrão", () => {
    expect(idiomaDaTela("pt-BR")).toBe("pt-BR");
    for (const codigo of ["es-MX", "en-US", "tr", "zh-CN", "xx", null, undefined]) {
      expect(idiomaDaTela(codigo)).toBe(IDIOMA_PADRAO);
    }
  });

  it("o provider cai no padrão para um código que não tem texto nenhum", () => {
    render(createElement(IdiomaProvider, { locale: "xx", children: createElement(Frase, { texto: "Contatos" }) }));
    expect(screen.getByTestId("frase").textContent).toBe("Contatos");
  });

  it("tela anônima: perfil ou navegador em espanhol leem português", async () => {
    const { idiomaDoVisitante } = await import("@/lib/i18n/idiomaAnonimo");
    expect(await idiomaDoVisitante(null)).toBe(IDIOMA_PADRAO);
    expect(await idiomaDoVisitante("es")).toBe(IDIOMA_PADRAO);
  });

  it("saída fora da tela intacta: o idioma gravado e o do destinatário seguem es/en", () => {
    expect(normalizarIdioma("es")).toBe("es");
    expect(normalizarIdioma("en")).toBe("en");
    expect(parseAcceptLanguage("es-MX,es;q=0.9,en;q=0.8")).toBe("es");
    expect(idiomaDelNavegador(["en-US", "es"])).toBe("en");
    expect(idiomaDoTexto("es-419")).toBe("es");
    expect(traduzir("Contatos", idiomaDoTexto("es-MX"))).toBe("Contactos");
    expect(tagDeIdioma("es")).toBe("es");
  });
});
