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

export interface FiltrosDaTela {
  search?: string;
  tag?: string;
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

export const CHAVES_DE_FILTRO = [
  "search",
  "tag",
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

export function filtrosFromParams(sp: { get(chave: string): string | null }): FiltrosDaTela {
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

  return {
    ...(texto("search", 200) ? { search: texto("search", 200) } : {}),
    ...(texto("tag", 80) ? { tag: texto("tag", 80) } : {}),
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
  for (const chave of CHAVES_DE_FILTRO) {
    const v = f[chave];
    if (v) para.set(chave, v);
  }
  return para;
}

/** O objeto como vai no corpo de "excluir/exportar todos do filtro" (campos sem valor saem). */
export function filtrosParaCorpo(f: FiltrosDaTela): Record<string, string> {
  const corpo: Record<string, string> = {};
  for (const chave of CHAVES_DE_FILTRO) {
    const v = f[chave];
    if (v) corpo[chave] = v;
  }
  return corpo;
}

/** Quantos filtros estão ligados (para o rótulo "Limpar filtros" e o botão de filtros avançados). */
export function quantidadeDeFiltros(f: FiltrosDaTela): number {
  return [
    f.search,
    f.tag,
    f.source,
    f.criado || f.criado_de || f.criado_ate,
    f.ativ || f.ativ_de || f.ativ_ate,
    f.funil || f.etapa,
    f.campo && f.campo_valor,
  ].filter(Boolean).length;
}
