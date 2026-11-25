/**
 * Feriados FEDERAIS dos Estados Unidos — o calendário de dias úteis do perfil
 * `US` (`lib/legal/perfil-do-pais.ts`), no mesmo formato de `holidays-br.ts` e
 * `holidays-pt.ts`: datas `YYYY-MM-DD`, uma lista gerada de 2000 a 2100.
 *
 * ─── Quais, e por que a data OBSERVADA ─────────────────────────────────────
 *
 * Os onze de 5 U.S.C. § 6103(a), conferidos contra a tabela do OPM
 * (opm.gov › Federal Holidays) para 2026 e 2027 em 2026-11-24:
 *
 *   • fixos: New Year's Day (01-01), Juneteenth (06-19, só desde 2021),
 *     Independence Day (07-04), Veterans Day (11-11), Christmas Day (12-25);
 *   • móveis: Martin Luther King Jr. (3.ª segunda de janeiro), Washington's
 *     Birthday / Presidents Day (3.ª segunda de fevereiro), Memorial Day
 *     (última segunda de maio), Labor Day (1.ª segunda de setembro), Columbus
 *     Day (2.ª segunda de outubro), Thanksgiving (4.ª quinta de novembro).
 *
 * O prazo conta DIAS ÚTEIS, e o dia que não se trabalha é o OBSERVADO: fixo que
 * cai no sábado folga na sexta anterior; no domingo, na segunda seguinte
 * (Executive Order 11582 e § 6103(b)). Por isso a lista guarda a data
 * observada, e não a nominal — 4 de julho de 2026 é sábado, e quem não trabalha
 * é a sexta, 3 de julho. Caso de borda: 1.º de janeiro de 2028 é sábado, e a
 * folga é a sexta, 31 de dezembro de 2027 — dentro do ano ANTERIOR. O OPM
 * lista exatamente assim.
 *
 * Feriado ESTADUAL (o da Flórida, por exemplo) não entra: varia por estado, e
 * o perfil é do país. É a mesma régua de Portugal, que não lista feriado
 * municipal.
 */

/** Primeiro ano coberto pelo calendário gerado. */
export const PRIMEIRO_ANO_COBERTO = 2000;

/** Último ano coberto pelo calendário gerado. */
export const ULTIMO_ANO_COBERTO = 2100;

/** Juneteenth virou feriado federal em 17/06/2021 (Pub. L. 117-17). */
const PRIMEIRO_ANO_DO_JUNETEENTH = 2021;

function iso(ano: number, mes: number, dia: number): string {
  return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/** A data observada de um feriado fixo: sábado → sexta; domingo → segunda. */
function observado(ano: number, mes: number, dia: number): string {
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  const semana = data.getUTCDay();
  if (semana === 6) data.setUTCDate(data.getUTCDate() - 1);
  else if (semana === 0) data.setUTCDate(data.getUTCDate() + 1);
  return iso(data.getUTCFullYear(), data.getUTCMonth() + 1, data.getUTCDate());
}

/** O n-ésimo `diaDaSemana` (0 = domingo) do mês; `n = -1` é o último. */
function enesimoDiaDaSemana(ano: number, mes: number, diaDaSemana: number, n: number): string {
  if (n === -1) {
    const ultimo = new Date(Date.UTC(ano, mes, 0));
    const recuo = (ultimo.getUTCDay() - diaDaSemana + 7) % 7;
    return iso(ano, mes, ultimo.getUTCDate() - recuo);
  }
  const primeiro = new Date(Date.UTC(ano, mes - 1, 1));
  const avanco = (diaDaSemana - primeiro.getUTCDay() + 7) % 7;
  return iso(ano, mes, 1 + avanco + (n - 1) * 7);
}

const SEGUNDA = 1;
const QUINTA = 4;

/** Os feriados federais NOMINAIS de um ano, já na data observada. */
function feriadosObservadosDoAno(ano: number): string[] {
  return [
    observado(ano, 1, 1), // New Year's Day
    enesimoDiaDaSemana(ano, 1, SEGUNDA, 3), // Martin Luther King Jr. Day
    enesimoDiaDaSemana(ano, 2, SEGUNDA, 3), // Washington's Birthday (Presidents Day)
    enesimoDiaDaSemana(ano, 5, SEGUNDA, -1), // Memorial Day
    ...(ano >= PRIMEIRO_ANO_DO_JUNETEENTH ? [observado(ano, 6, 19)] : []), // Juneteenth
    observado(ano, 7, 4), // Independence Day
    enesimoDiaDaSemana(ano, 9, SEGUNDA, 1), // Labor Day
    enesimoDiaDaSemana(ano, 10, SEGUNDA, 2), // Columbus Day
    observado(ano, 11, 11), // Veterans Day
    enesimoDiaDaSemana(ano, 11, QUINTA, 4), // Thanksgiving Day
    observado(ano, 12, 25), // Christmas Day
  ];
}

/**
 * Os dias SEM EXPEDIENTE federal que caem no ano civil `ano`, em ordem.
 *
 * Inclui a folga do Ano-Novo SEGUINTE quando ela recua para 31 de dezembro (o
 * caso de 2027), e exclui a do próprio Ano-Novo quando ela recuou para o ano
 * anterior (o caso de 2028, que não tem folga em janeiro).
 */
export function feriadosDosEstadosUnidosDoAno(ano: number): string[] {
  const prefixo = `${ano}-`;
  return [...feriadosObservadosDoAno(ano), observado(ano + 1, 1, 1)]
    .filter((d) => d.startsWith(prefixo))
    .sort();
}

export const HOLIDAYS_US_ISO: string[] = (() => {
  const lista: string[] = [];
  for (let ano = PRIMEIRO_ANO_COBERTO; ano <= ULTIMO_ANO_COBERTO; ano++) {
    lista.push(...feriadosDosEstadosUnidosDoAno(ano));
  }
  return lista;
})();
