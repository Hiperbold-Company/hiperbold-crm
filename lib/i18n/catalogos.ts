/**
 * O LEITOR DOS CATÁLOGOS — `lib/i18n/traducoes/<codigo>.json` na tela.
 *
 * ─── Só entra aqui o catálogo de um idioma que aparece ─────────────────────
 *
 * Um catálogo importado vai no pacote do navegador de TODO usuário. O de um
 * idioma `em_construcao` não é servido a ninguém, então pô-lo aqui seria pagar
 * centenas de KB por uma língua que ninguém pode escolher. A guarda está em
 * `tests/unit/catalogo-de-idioma-tem-forma`: este é o único arquivo que pode
 * importar um catálogo, e só o de um idioma visível.
 *
 * ─── O dicionário vem antes ────────────────────────────────────────────────
 *
 * `traduzir` consulta a coluna do dicionário e só depois o catálogo; os dois
 * caem no português. A leitura é síncrona e a mesma no servidor, no worker e
 * no navegador — nada de carga assíncrona por idioma nesta fatia.
 */
import type { Idioma } from "./idiomas";
import en from "./traducoes/en.json";
import type { IdiomaVisivel } from "./registro";

/**
 * ─── O mapa é EXAUSTIVO, e é isso que faltou ao inglês ─────────────────────
 *
 * Em 04/11/2026 (D-225) o inglês foi promovido a `completo` no registro com o
 * `en.json` inteiro, e este mapa ficou vazio: o seletor oferecia "English", a
 * escolha era aceita e gravada, e `traduzir` não achava frase nenhuma — a tela
 * seguia em português. Nenhum gate viu, porque a cobertura de tela lê o JSON
 * do DISCO, e não por este leitor.
 *
 * O tipo era `Partial<Record<Idioma, …>>`, que aceita o vazio para sempre. Agora
 * é `Record` sobre os idiomas VISÍVEIS cuja fonte é catálogo: enquanto nenhum
 * aparece, o mapa vazio compila; no dia em que um deles for promovido, o
 * compilador reprova até o `import` do JSON entrar aqui.
 */
type IdiomaDeCatalogoVisivel = Extract<IdiomaVisivel, { fonteDoTexto: "catalogo" }>["codigo"];

// Turco e chinês seguem em construção; a promoção de cada um importa o JSON aqui.
const CATALOGOS: Readonly<Record<IdiomaDeCatalogoVisivel, Readonly<Record<string, string>>>> = {
  en: en as Readonly<Record<string, string>>,
};

/** Os idiomas cujo texto vem de um catálogo, e não de coluna do dicionário. */
export const IDIOMAS_COM_CATALOGO = Object.keys(CATALOGOS) as Idioma[];

type MapaDeCatalogos = Partial<Record<Idioma, Readonly<Record<string, string>>>>;

/**
 * O leitor de um mapa de catálogos. Separado do mapa para o teste medir o
 * caminho inteiro com um catálogo que ainda não aparece (o `en.json`, lido do
 * disco pelo teste), sem importá-lo para o pacote de quem usa.
 */
export function leitorDeCatalogos(mapa: MapaDeCatalogos): (idioma: Idioma, texto: string) => string | undefined {
  return (idioma, texto) => mapa[idioma]?.[texto];
}

/** A frase no catálogo do idioma, ou `undefined` quando ele não a tem (ou não está carregado). */
export const entradaDoCatalogo = leitorDeCatalogos(CATALOGOS as MapaDeCatalogos);
