/**
 * Filtros da lista de contatos: a parte PURA (sem banco, sem rede).
 *
 * A forma dos filtros mora em `lib/schemas/contacts.ts` (`filtrosDeContatosSchema`) e
 * é a mesma na URL da tela, na query do GET e no corpo de "excluir/exportar todos do
 * filtro". Aqui ficam as contas que dependem só de dados: em que INSTANTES começa e
 * termina um período no fuso da organização, e o resumo do filtro que vai para a
 * auditoria (sem texto pessoal).
 */
import {
  filtroDeDataAtivo,
  intervaloDoFiltro,
  somaDias,
  type FiltroDeData,
} from "@/lib/kanban/datas-do-lead";
import type { FiltrosDeContatos, FiltrosDeContatosEntrada } from "@/lib/schemas/contacts";

export type ChaveDePeriodo = "criado" | "ativ";

/** O período de uma das duas datas do contato, no formato que `datas-do-lead` entende. */
export function periodoDoFiltro(
  f: Pick<FiltrosDeContatos, "criado" | "criado_de" | "criado_ate" | "ativ" | "ativ_de" | "ativ_ate">,
  chave: ChaveDePeriodo,
): FiltroDeData | undefined {
  const predefinido = f[chave];
  const de = f[`${chave}_de` as const];
  const ate = f[`${chave}_ate` as const];
  const periodo: FiltroDeData = predefinido
    ? { predefinido }
    : { ...(de ? { de } : {}), ...(ate ? { ate } : {}) };
  return filtroDeDataAtivo(periodo) ? periodo : undefined;
}

/** Diferença, em ms, entre o relógio de parede do fuso e o UTC naquele instante. */
function deslocamentoDoFuso(instanteMs: number, tz: string): number {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instanteMs));
  const v = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? "0");
  const parede = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  return parede - Math.floor(instanteMs / 1000) * 1000;
}

/**
 * O instante (ISO, UTC) em que o dia `YYYY-MM-DD` COMEÇA no fuso. Fuso ausente ou
 * inválido cai em UTC — `Intl` lança em fuso que não existe, e a lista de contatos
 * não pode virar 500 por uma coluna que nenhum escritor valida.
 */
export function inicioDoDiaNoFuso(dia: string, tz: string | null | undefined): string {
  const [y, m, d] = dia.split("-").map(Number) as [number, number, number];
  const meiaNoiteUtc = Date.UTC(y, m - 1, d);
  if (!tz) return new Date(meiaNoiteUtc).toISOString();
  try {
    let t = meiaNoiteUtc;
    // Duas passadas bastam: o deslocamento só muda se a virada de horário de verão
    // cair entre o palpite e o resultado.
    for (let i = 0; i < 3; i++) {
      const proximo = meiaNoiteUtc - deslocamentoDoFuso(t, tz);
      if (proximo === t) break;
      t = proximo;
    }
    return new Date(t).toISOString();
  } catch {
    return new Date(meiaNoiteUtc).toISOString();
  }
}

/**
 * O período como intervalo semiaberto de instantes, `[gte, lt)`, contado em dias DO
 * FUSO DA ORGANIZAÇÃO: "Hoje" de uma clínica em São Paulo, olhado às 22h, não é o dia
 * do UTC. `null` = sem filtro.
 */
export function intervaloEmInstantes(
  periodo: FiltroDeData | undefined,
  agora: Date,
  tz: string | null | undefined,
): { gte?: string; lt?: string } | null {
  const dias = intervaloDoFiltro(periodo, agora, tz);
  if (!dias) return null;
  return {
    ...(dias.de ? { gte: inicioDoDiaNoFuso(dias.de, tz) } : {}),
    ...(dias.ate ? { lt: inicioDoDiaNoFuso(somaDias(dias.ate, 1), tz) } : {}),
  };
}

/** Há algum filtro de data ativo? (decide se a rota precisa ler o fuso da organização) */
export function temFiltroDeData(f: FiltrosDeContatos): boolean {
  return Boolean(periodoDoFiltro(f, "criado") || periodoDoFiltro(f, "ativ"));
}

/** Há algum filtro ativo? */
export function temFiltro(f: Partial<FiltrosDeContatosEntrada>): boolean {
  return Boolean(
    f.search?.trim() ||
      f.tag ||
      f.source ||
      f.criado ||
      f.criado_de ||
      f.criado_ate ||
      f.ativ ||
      f.ativ_de ||
      f.ativ_ate ||
      f.funil ||
      f.etapa ||
      (f.campo && f.campo_valor),
  );
}

/**
* O filtro como vai para a auditoria: o que foi filtrado, NUNCA o texto digitado.
 * Busca e valor de campo podem ser dado pessoal (um nome, um telefone, um cargo). Fica o suficiente para reconstituir "que tipo de conjunto era".
 */
export function resumoDoFiltroParaAuditoria(f: FiltrosDeContatos): Record<string, unknown> {
  const criado = periodoDoFiltro(f, "criado");
  const ativ = periodoDoFiltro(f, "ativ");
  return {
    ...(f.search?.trim() ? { busca: true } : {}),
    ...(f.tag ? { etiqueta: f.tag } : {}),
    ...(f.source ? { origem: f.source } : {}),
    ...(criado ? { entrou_no_crm: criado } : {}),
    ...(ativ ? { ultima_atividade: ativ } : {}),
    ...(f.funil ? { funil_id: f.funil } : {}),
    ...(f.etapa ? { etapa_id: f.etapa } : {}),
    ...(f.campo && f.campo_valor
      ? { campo: { escopo: f.campo_escopo, chave: f.campo, operador: f.campo_op } }
      : {}),
  };
}
