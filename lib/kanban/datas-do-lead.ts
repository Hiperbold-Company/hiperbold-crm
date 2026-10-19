/**
 * As duas datas do negócio que o quadro e a ficha mostram e filtram:
 *
 *  - "Criado em"            → `crm_leads.created_at`;
 *  - "Última movimentação"  → `crm_leads.stage_changed_at` (o carimbo de quando
 *    ele ENTROU na etapa atual; trigger `fn_stamp_stage_changed_at`) e, se nulo,
 *    `created_at` — o mesmo palpite honesto que o backfill da migration usou.
 *
 * Tudo aqui é PURO e recebe "agora" e o fuso por parâmetro: o filtro "Hoje" de
 * uma organização em São Paulo, olhado às 22h, é um dia diferente do UTC, e a
 * conta tem de ser a do fuso DA ORGANIZAÇÃO, não a do navegador de quem olha.
 *
 * Onde o filtro roda: o quadro recebe o funil inteiro de uma vez
 * (`/api/v1/pipelines/[id]/board` não pagina) e todos os filtros dele — dono,
 * status, tag, busca — rodam em `applyFilters`, no cliente. Estes seguem o mesmo
 * caminho: um filtro no servidor aqui divergiria dos outros no que a contagem das
 * colunas mostra.
 */

export const PERIODOS_PREDEFINIDOS = ["hoje", "7d", "30d", "mes"] as const;
export type PeriodoPredefinido = (typeof PERIODOS_PREDEFINIDOS)[number];

export const ROTULO_DO_PERIODO: Record<PeriodoPredefinido, string> = {
  hoje: "Hoje",
  "7d": "Últimos 7 dias",
  "30d": "Últimos 30 dias",
  mes: "Este mês",
};

/** Um filtro de data: um atalho OU um período personalizado (`de`/`ate`, `YYYY-MM-DD`). */
export interface FiltroDeData {
  predefinido?: PeriodoPredefinido;
  de?: string;
  ate?: string;
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;

export function filtroDeDataAtivo(f: FiltroDeData | undefined): boolean {
  return Boolean(f && (f.predefinido || f.de || f.ate));
}

/** Fuso válido ou, na falta, o do navegador — `Intl` lança em fuso que não existe. */
function fusoSeguro(tz: string | null | undefined): string {
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz });
      return tz;
    } catch {
      /* cai no do navegador */
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** O dia (`YYYY-MM-DD`) em que o instante cai NO FUSO dado; `null` se o instante é inválido. */
export function diaNoFuso(instante: string | Date, tz: string | null | undefined): string | null {
  const d = typeof instante === "string" ? new Date(instante) : instante;
  if (Number.isNaN(d.getTime())) return null;
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: fusoSeguro(tz),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const v = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")}`;
}

/** Soma dias a um `YYYY-MM-DD` (calendário, sem fuso). */
export function somaDias(dia: string, n: number): string {
  const [y, m, d] = dia.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** O intervalo fechado `[de, ate]` em dias do fuso; ponta ausente = aberta. `null` = sem filtro. */
export function intervaloDoFiltro(
  f: FiltroDeData | undefined,
  agora: Date,
  tz: string | null | undefined,
): { de?: string; ate?: string } | null {
  if (!f || !filtroDeDataAtivo(f)) return null;
  const hoje = diaNoFuso(agora, tz) as string;
  switch (f.predefinido) {
    case "hoje":
      return { de: hoje, ate: hoje };
    case "7d":
      return { de: somaDias(hoje, -6), ate: hoje };
    case "30d":
      return { de: somaDias(hoje, -29), ate: hoje };
    case "mes":
      return { de: `${hoje.slice(0, 8)}01`, ate: hoje };
    default: {
      const de = f.de && DIA.test(f.de) ? f.de : undefined;
      const ate = f.ate && DIA.test(f.ate) ? f.ate : undefined;
      if (!de && !ate) return null;
      return { de, ate };
    }
  }
}

/** O instante cai dentro do filtro (no fuso)? Sem filtro, sim; sem data, não. */
export function dentroDoFiltroDeData(
  instante: string | null | undefined,
  f: FiltroDeData | undefined,
  agora: Date,
  tz: string | null | undefined,
): boolean {
  const intervalo = intervaloDoFiltro(f, agora, tz);
  if (!intervalo) return true;
  if (!instante) return false;
  const dia = diaNoFuso(instante, tz);
  if (!dia) return false;
  if (intervalo.de && dia < intervalo.de) return false;
  if (intervalo.ate && dia > intervalo.ate) return false;
  return true;
}

/** A data da última movimentação: a entrada na etapa e, se faltar, a criação. */
export function ultimaMovimentacao(lead: {
  stage_changed_at?: string | null;
  created_at: string;
}): string {
  return lead.stage_changed_at || lead.created_at;
}

// ── URL ───────────────────────────────────────────────────────────────────────
// `criado=7d` | `criado_de=2026-10-01&criado_ate=2026-10-15`; o mesmo com `mov`.

export function filtroDeDataFromParams(
  sp: { get(key: string): string | null },
  chave: string,
): FiltroDeData | undefined {
  const pre = sp.get(chave);
  if (pre && (PERIODOS_PREDEFINIDOS as readonly string[]).includes(pre)) {
    return { predefinido: pre as PeriodoPredefinido };
  }
  const de = sp.get(`${chave}_de`);
  const ate = sp.get(`${chave}_ate`);
  const f: FiltroDeData = {
    ...(de && DIA.test(de) ? { de } : {}),
    ...(ate && DIA.test(ate) ? { ate } : {}),
  };
  return filtroDeDataAtivo(f) ? f : undefined;
}

export function filtroDeDataToParams(p: URLSearchParams, chave: string, f: FiltroDeData | undefined): void {
  if (!f) return;
  if (f.predefinido) {
    p.set(chave, f.predefinido);
    return;
  }
  if (f.de) p.set(`${chave}_de`, f.de);
  if (f.ate) p.set(`${chave}_ate`, f.ate);
}

// ── Rótulos ───────────────────────────────────────────────────────────────────

/**
 * "hoje", "há 3 dias", "há 2 meses" — o relativo do card. A conta é em DIAS DO
 * FUSO (meia-noite a meia-noite): "movido há 1 dia" às 00h10 de quem moveu às
 * 23h50 de ontem é verdade, e "há 0 dias" às 23h59 não seria.
 */
export function idadeEmDias(
  instante: string,
  agora: Date,
  tz: string | null | undefined,
): number | null {
  const d0 = diaNoFuso(instante, tz);
  const d1 = diaNoFuso(agora, tz);
  if (!d0 || !d1) return null;
  const [y0, m0, dd0] = d0.split("-").map(Number) as [number, number, number];
  const [y1, m1, dd1] = d1.split("-").map(Number) as [number, number, number];
  const dias = Math.round((Date.UTC(y1, m1 - 1, dd1) - Date.UTC(y0, m0 - 1, dd0)) / 86_400_000);
  return Math.max(0, dias);
}

export function rotuloDeIdade(
  instante: string,
  agora: Date,
  tz: string | null | undefined,
  t: (texto: string) => string = (x) => x,
): string | null {
  const dias = idadeEmDias(instante, agora, tz);
  if (dias === null) return null;
  if (dias === 0) return t("hoje");
  if (dias === 1) return t("ontem");
  if (dias < 60) return `${t("há")} ${dias} ${t("dias")}`;
  return `${t("há")} ${Math.floor(dias / 30)} ${t("meses")}`;
}
