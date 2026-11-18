/**
 * O REGISTRO DE IDIOMAS — o único lugar onde um idioma existe.
 *
 * ─── O problema que ele resolve ────────────────────────────────────────────
 *
 * Antes deste arquivo, "o produto fala espanhol" estava escrito à mão em seis
 * lugares: a lista `IDIOMAS`, os nomes do seletor do topo, as opções do perfil,
 * as da organização, a tag BCP-47 e o casamento do `Accept-Language`. Um idioma
 * novo exigia lembrar de todos, e o PR #773 (chinês) mostrou o custo do outro
 * lado: acrescentar o código numa lista o fazia APARECER em todas elas no mesmo
 * commit em que entrava o primeiro caractere traduzido.
 *
 * ─── O nível é a promessa, e ele decide o que aparece ──────────────────────
 *
 * - `em_construcao`: está sendo traduzido. Não aparece em tela nenhuma, não é
 *   servido a ninguém e não reprova ninguém — quem acrescenta uma frase em
 *   português não precisa escrever a versão deste idioma. Exceção: o idioma
 *   RETIRADO do seletor (seção abaixo) segue servido fora da tela e cobrado.
 * - `telas_principais`: aparece. A régua de "telas principais" é medida, e ela
 *   ainda não existe (fatia 5 do PROG-022) — por isso nenhum idioma pode
 *   declarar este nível hoje, e um teste reprova quem declarar.
 * - `completo`: aparece, e toda frase de tela precisa dele. Era o nível do
 *   espanhol e do inglês até 17/11/2026, e é o do português.
 *
 * Quem decide o que é visível é o NÍVEL, não uma lista paralela:
 * `IDIOMAS_VISIVEIS` só inclui códigos cujo nível aparece (`IDIOMAS`, em
 * `./idiomas`, inclui também os retirados do seletor). Promover um idioma é
 * mudar uma linha aqui, e o compilador aponta cada lugar que passa a precisar
 * dele (o `Locale` de data em `datas.ts`, o catálogo em `catalogos.ts`).
 *
 * ─── Retirado do seletor não é o mesmo que nunca ter tido texto ────────────
 *
 * Um idioma que já apareceu e saiu (`retiradoDoSeletorEm`) volta a
 * `em_construcao` só para a TELA: não é oferecido no seletor e quem o tem
 * gravado vê a tela no padrão (`idiomaDaTela`). Fora da tela nada muda: ele
 * segue em `IDIOMAS`, é aceito na gravação, `normalizarIdioma` o devolve e as
 * saídas (e-mail, push, avisos, prospecção) seguem escrevendo nele. O texto
 * continua existindo e sendo vigiado, e o TIPO `Idioma` continua a incluí-lo.
 *
 * ─── Por que o `Locale` de data NÃO mora aqui ──────────────────────────────
 *
 * Este arquivo é importado por componente cliente e não pode arrastar os
 * objetos do `date-fns`; e `tests/unit/i18n-a-data-segue-o-idioma` só permite
 * importar `date-fns/locale` na camada de data. O mapa `Record<Idioma, Locale>`
 * de `datas.ts` segue exaustivo, e é ele que o compilador cobra na promoção.
 */

export type NivelDeIdioma = "em_construcao" | "telas_principais" | "completo";

export interface IdiomaRegistrado {
  /** O que se grava em `user_metadata.locale` e `organizations.locale`. */
  readonly codigo: string;
  /** Cada língua no nome dela própria: é assim que se reconhece a sua numa lista que você não sabe ler. */
  readonly nomeNativo: string;
  /** O que cabe no botão do topo, no espaço de um ícone. */
  readonly rotuloCurto: string;
  /** Para `Intl` e `toLocale*String`. */
  readonly tagBcp47: string;
  /** As subtags primárias do `Accept-Language` que levam a este idioma (`pt-PT` → `pt` → `pt-BR`). */
  readonly subtagsDoNavegador: readonly string[];
  readonly nivel: NivelDeIdioma;
  /**
   * De onde vem o texto: coluna do `DICIONARIO` ou `lib/i18n/traducoes/<codigo>.json`.
   * Um idioma de catálogo que aparece OBRIGA o catálogo a estar carregado em
   * `catalogos.ts` — o compilador cobra, e é o que faltou ao inglês em 04/11/2026.
   */
  readonly fonteDoTexto: "dicionario" | "catalogo";
  /** Data em que um idioma que aparecia saiu do seletor. Ausente em quem nunca apareceu. */
  readonly retiradoDoSeletorEm?: string;
  /** Quem responde pela tradução. `null` enquanto ninguém assumiu. */
  readonly mantenedor: string | null;
}

export const REGISTRO_DE_IDIOMAS = [
  {
    codigo: "pt-BR",
    nomeNativo: "Português (BR)",
    rotuloCurto: "PT",
    tagBcp47: "pt-BR",
    subtagsDoNavegador: ["pt"],
    nivel: "completo",
    fonteDoTexto: "dicionario",
    mantenedor: "mantenedores do projeto",
  },
  {
    codigo: "es",
    nomeNativo: "Español",
    rotuloCurto: "ES",
    // `es` e não `es-ES`: o público é a América Latina, e com `es` puro o
    // navegador resolve pela região de quem lê.
    tagBcp47: "es",
    subtagsDoNavegador: ["es"],
    // Fora do seletor desde 17/11/2026 (decisão do dono do produto): há telas
    // pela metade. Volta a `completo` depois da conferência tela a tela.
    nivel: "em_construcao",
    fonteDoTexto: "dicionario",
    retiradoDoSeletorEm: "2026-11-17",
    mantenedor: "mantenedores do projeto",
  },
  {
    codigo: "tr",
    nomeNativo: "Türkçe",
    rotuloCurto: "TR",
    tagBcp47: "tr",
    subtagsDoNavegador: ["tr"],
    // O primeiro idioma com catálogo completo (`lib/i18n/traducoes/tr.json`).
    // Entra em construção, como o chinês (doc de decisão 198): aparece quando
    // houver a carga por idioma e a régua de telas principais (fatia 5).
    nivel: "em_construcao",
    fonteDoTexto: "catalogo",
    mantenedor: "Agenterix (@nusretbayindir-stack)",
  },
  {
    codigo: "zh-CN",
    nomeNativo: "简体中文",
    rotuloCurto: "中",
    tagBcp47: "zh-CN",
    subtagsDoNavegador: ["zh"],
    // A tradução chega pelo PR #773, de @xxjjjj. Registrar o idioma antes do
    // catálogo é o que deixa o catálogo entrar sem aparecer para ninguém.
    nivel: "em_construcao",
    fonteDoTexto: "catalogo",
    mantenedor: null,
  },
  {
    codigo: "en",
    nomeNativo: "English",
    rotuloCurto: "EN",
    // `en` e não `en-US`, pela mesma razão do `es`: com a tag pura o navegador
    // resolve pela região de quem lê (data, número), em vez de impor os EUA.
    tagBcp47: "en",
    subtagsDoNavegador: ["en"],
    // Catálogo em `lib/i18n/traducoes/en.json`, lido por `catalogos.ts` (fatia 4
    // do PROG-022). Promovido a `completo` no Hiperbold CRM em 04/11/2026 (D-225)
    // e tirado do seletor em 17/11/2026, até a conferência tela a tela.
    nivel: "em_construcao",
    fonteDoTexto: "catalogo",
    retiradoDoSeletorEm: "2026-11-17",
    mantenedor: "Hiperbold",
  },
] as const satisfies readonly IdiomaRegistrado[];

export type IdiomaDoRegistro = (typeof REGISTRO_DE_IDIOMAS)[number];

/** Um idioma cujo nível permite aparecer para quem usa. */
export type IdiomaVisivel = Extract<IdiomaDoRegistro, { nivel: "telas_principais" | "completo" }>;

/**
 * Um idioma em que o produto sabe escrever: o que aparece e o que saiu do
 * seletor mas tem texto. É o universo do TIPO `Idioma`; quem é oferecido e
 * aceito é a lista `IDIOMAS_VISIVEIS`, menor.
 */
export type IdiomaComTexto =
  | IdiomaVisivel
  | Extract<IdiomaDoRegistro, { retiradoDoSeletorEm: string }>;

/** O nível deste idioma deixa ele aparecer para quem usa? */
export function nivelApareceParaQuemUsa(nivel: NivelDeIdioma): boolean {
  return nivel !== "em_construcao";
}

function ehVisivel(idioma: IdiomaDoRegistro): idioma is IdiomaVisivel {
  return nivelApareceParaQuemUsa(idioma.nivel);
}

/** Os idiomas que aparecem, na ordem do registro — o padrão do produto primeiro. */
export const IDIOMAS_VISIVEIS: readonly IdiomaVisivel[] = REGISTRO_DE_IDIOMAS.filter(ehVisivel);

function temTexto(idioma: IdiomaDoRegistro): idioma is IdiomaComTexto {
  return ehVisivel(idioma) || "retiradoDoSeletorEm" in idioma;
}

/** Os idiomas com texto, na ordem do registro: os visíveis e os retirados do seletor. */
export const IDIOMAS_COM_TEXTO: readonly IdiomaComTexto[] = REGISTRO_DE_IDIOMAS.filter(temTexto);

/** Os que ainda não aparecem: citados na mensagem dos gates, para quem contribui saber que não precisa deles. */
export const IDIOMAS_EM_CONSTRUCAO: readonly IdiomaDoRegistro[] = REGISTRO_DE_IDIOMAS.filter(
  (idioma) => !nivelApareceParaQuemUsa(idioma.nivel),
);

/**
 * Os dados de um idioma visível. Um código que não aparece (retirado do
 * seletor, ou que escapou do tipo em tempo de execução) devolve o padrão do
 * produto (a primeira linha do registro) — nunca uma tela quebrada.
 */
export function idiomaVisivelPorCodigo(codigo: IdiomaComTexto["codigo"]): IdiomaVisivel {
  return IDIOMAS_VISIVEIS.find((idioma) => idioma.codigo === codigo) ?? REGISTRO_DE_IDIOMAS[0];
}

/**
 * Os dados de um idioma com texto, visível ou não — para quem escreve na
 * língua de um DESTINATÁRIO (a tag BCP-47 de `toLocaleString`, por exemplo).
 */
export function idiomaComTextoPorCodigo(codigo: IdiomaComTexto["codigo"]): IdiomaComTexto {
  return IDIOMAS_COM_TEXTO.find((idioma) => idioma.codigo === codigo) ?? REGISTRO_DE_IDIOMAS[0];
}
