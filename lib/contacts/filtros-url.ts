/**
 * Os filtros da tela de Contatos ↔ a URL. PURO, e usado pelo navegador: a tela, a
 * lista, a contagem, a exclusão e a exportação falam o MESMO objeto, e a URL é a
 * fonte (`/app/contacts?criado=7d&funil=…` recarrega no mesmo lugar e se compartilha).
 *
 * Os nomes são os de `filtrosDeContatosSchema` (o servidor lê a mesma query). Aqui só se
 * lê o que a tela é capaz de produzir, e o resto é descartado: uma URL editada à mão com
 * `funil=abc` não pode virar 422 numa lista que parecia vazia.
 */
import { PERIODOS_PREDEFINIDOS } from "@/lib/kanban/datas-do-lead";
import { DIA_MAXIMO_DO_FILTRO, DIA_MINIMO_DO_FILTRO } from "@/lib/schemas/contacts";
import { chaveSensivelDeCampo } from "@/lib/contacts/campos-sensiveis";
import { MAXIMO_DE_ETIQUETAS_NO_FILTRO, marcadoresEscolhidos } from "@/lib/inbox/marcador-da-conversa";

export interface FiltrosDaTela {
  search?: string;
  /**
   * Uma ou VÁRIAS etiquetas (#1274, upstream). Na URL saem repetidas (`?tag=a&tag=b`), a forma que
   * o servidor lê com `getAll`; no corpo de "excluir/exportar todos do filtro", como lista.
   */
  tag?: string[];
  /** E/OU entre as etiquetas: só `ou` é guardado (E é o padrão) e só com duas ou mais. */
  modo?: "ou";
  /** Só pessoais (spec 21, etapa 13). Desligado é o padrão do servidor: pessoal fica fora. */
  pessoais?: boolean;
  /** Só quem pediu opt-out (`yes`) ou só quem não pediu (`no`). Ausente = todos. */
  blocked?: "yes" | "no";
  source?: string;
  criado?: string;
  criado_de?: string;
  criado_ate?: string;
  ativ?: string;
  ativ_de?: string;
  ativ_ate?: string;
  funil?: string;
  /** Uma ou mais etapas, separadas por vírgula (a forma da URL e do servidor). */
  etapa?: string;
  campo_escopo?: "qualquer" | "contato" | "negocio";
  campo?: string;
  campo_op?: "contem" | "igual";
  campo_valor?: string;
}

/** Os filtros que são UM texto (a URL guarda `chave=valor`). Etiquetas, modo, pessoais e bloqueados à parte. */
export const CHAVES_DE_TEXTO = [
  "search",
  "source",
  "criado",
  "criado_de",
  "criado_ate",
  "ativ",
  "ativ_de",
  "ativ_ate",
  "funil",
  "etapa",
  "campo_escopo",
  "campo",
  "campo_op",
  "campo_valor",
] as const satisfies ReadonlyArray<keyof FiltrosDaTela>;
export type ChaveDeTexto = (typeof CHAVES_DE_TEXTO)[number];

export const CHAVES_DE_FILTRO = [
  ...CHAVES_DE_TEXTO,
  "tag",
  "modo",
  "pessoais",
  "blocked",
] as const satisfies ReadonlyArray<keyof FiltrosDaTela>;

/** Troca de filtros de TEXTO (`undefined` apaga a chave) — o que os filtros avançados produzem. */
export type MudancaDeTexto = Partial<Record<ChaveDeTexto, string | undefined>>;
/** Qualquer troca de filtro da tela. */
export type MudancaDeFiltros = MudancaDeTexto &
  Partial<Pick<FiltrosDaTela, "tag" | "modo" | "pessoais" | "blocked">>;

/** O objeto de "excluir/exportar todos do filtro" (o servidor o valida por `filtrosDeContatosSchema`). */
export type CorpoDoFiltro = Record<string, string | string[] | boolean>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIA = /^\d{4}-\d{2}-\d{2}$/;
/** O dia tem a forma certa E cai na janela que o servidor aceita (mesma de `filtrosDeContatosSchema`). */
const diaValido = (d: string | null): d is string =>
  Boolean(d && DIA.test(d) && d >= DIA_MINIMO_DO_FILTRO && d <= DIA_MAXIMO_DO_FILTRO);
const CHAVE_DE_CAMPO = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
/** O mesmo teto do servidor (`MAXIMO_DE_ETAPAS_NO_FILTRO`). */
const MAXIMO_DE_ETAPAS = 100;

/** Sem escopo (ou um desconhecido) é "qualquer": o contato OU algum negócio dele. */
function escopoDoCampo(v: string | null): "qualquer" | "contato" | "negocio" {
  return v === "contato" || v === "negocio" ? v : "qualquer";
}

/** As etapas do filtro como lista (a URL guarda separadas por vírgula). */
export function etapasDoFiltro(f: Pick<FiltrosDaTela, "etapa">): string[] {
  return f.etapa ? f.etapa.split(",").filter(Boolean) : [];
}

export function filtrosFromParams(sp: {
  get(chave: string): string | null;
  getAll(chave: string): string[];
}): FiltrosDaTela {
  const texto = (chave: string, max: number): string | undefined => {
    const v = sp.get(chave)?.trim();
    return v ? v.slice(0, max) : undefined;
  };
  const periodo = (chave: "criado" | "ativ"): Partial<FiltrosDaTela> => {
    const atalho = sp.get(chave);
    if (atalho && (PERIODOS_PREDEFINIDOS as readonly string[]).includes(atalho)) {
      return { [chave]: atalho };
    }
    const de = sp.get(`${chave}_de`);
    const ate = sp.get(`${chave}_ate`);
    return {
      ...(diaValido(de) ? { [`${chave}_de`]: de } : {}),
      ...(diaValido(ate) ? { [`${chave}_ate`]: ate } : {}),
    };
  };
  const funil = sp.get("funil");
  // Ids inválidos saem um a um: o resto da lista continua valendo.
  const etapa = [...new Set((sp.get("etapa") ?? "").split(",").map((e) => e.trim()))]
    .filter((e) => UUID.test(e))
    .slice(0, MAXIMO_DE_ETAPAS)
    .join(",");
  const campo = sp.get("campo");
  const valor = texto("campo_valor", 200);
  const comCampo = campo && CHAVE_DE_CAMPO.test(campo) && !chaveSensivelDeCampo(campo) && valor;
  const tags = marcadoresEscolhidos(sp.getAll("tag").map((t) => t.slice(0, 80))).slice(
    0,
    MAXIMO_DE_ETIQUETAS_NO_FILTRO,
  );
  const blocked = sp.get("blocked");

  return {
    ...(texto("search", 200) ? { search: texto("search", 200) } : {}),
    ...(tags.length > 0 ? { tag: tags } : {}),
    // O modo só faz sentido com DUAS etiquetas: com uma, `&modo=ou` seria ruído.
    ...(tags.length > 1 && sp.get("modo") === "ou" ? { modo: "ou" as const } : {}),
    ...(sp.get("pessoais") === "true" ? { pessoais: true } : {}),
    ...(blocked === "yes" || blocked === "no" ? { blocked } : {}),
    ...(texto("source", 80) ? { source: texto("source", 80) } : {}),
    ...periodo("criado"),
    ...periodo("ativ"),
    ...(funil && UUID.test(funil) ? { funil } : {}),
    ...(etapa ? { etapa } : {}),
    ...(comCampo
      ? {
          campo,
          campo_valor: valor,
          campo_escopo: escopoDoCampo(sp.get("campo_escopo")),
          campo_op: sp.get("campo_op") === "igual" ? ("igual" as const) : ("contem" as const),
        }
      : {}),
  };
}

/** Só o que tem valor: URL curta, e o servidor aplica os padrões. */
export function filtrosToParams(f: FiltrosDaTela, para: URLSearchParams = new URLSearchParams()): URLSearchParams {
  for (const chave of CHAVES_DE_TEXTO) {
    const v = f[chave];
    if (v) para.set(chave, v);
  }
  const tags = f.tag ?? [];
  for (const marcador of tags) para.append("tag", marcador);
  if (tags.length > 1 && f.modo === "ou") para.set("modo", "ou");
  if (f.pessoais) para.set("pessoais", "true");
  if (f.blocked) para.set("blocked", f.blocked);
  return para;
}

/** O objeto como vai no corpo de "excluir/exportar todos do filtro" (campos sem valor saem). */
export function filtrosParaCorpo(f: FiltrosDaTela): CorpoDoFiltro {
  const corpo: CorpoDoFiltro = {};
  for (const chave of CHAVES_DE_TEXTO) {
    const v = f[chave];
    if (v) corpo[chave] = v;
  }
  if (f.tag && f.tag.length > 0) corpo.tag = [...f.tag];
  if (f.tag && f.tag.length > 1 && f.modo === "ou") corpo.modo = "ou";
  if (f.pessoais) corpo.pessoais = true;
  if (f.blocked) corpo.blocked = f.blocked;
  return corpo;
}

/** Quantos filtros estão ligados (para o rótulo "Limpar filtros" e o botão de filtros avançados). */
export function quantidadeDeFiltros(f: FiltrosDaTela): number {
  return [
    f.search,
    f.tag && f.tag.length > 0,
    f.pessoais,
    f.blocked,
    f.source,
    f.criado || f.criado_de || f.criado_ate,
    f.ativ || f.ativ_de || f.ativ_ate,
    f.funil || f.etapa,
    f.campo && f.campo_valor,
  ].filter(Boolean).length;
}
