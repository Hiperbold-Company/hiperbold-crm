/**
 * A conta de datas da exclusão dos dados depois do cancelamento (migration 0959, D-209). Funções puras: nada de
 * banco, relógio nem env aqui, para o teste provar a régua sem Postgres.
 *
 * Dia civil é o de São Paulo (o fuso fixo do produto, sem horário de verão): "faltam 30 dias" conta datas, não
 * horas, então a hora em que o cron roda não muda o marco do aviso.
 */

/** O padrão que a Política de Privacidade promete, e o piso (também aplicado dentro de `fn_exclusao_sincronizar`). */
export const DIAS_DE_GUARDA_PADRAO = 90;
export const DIAS_DE_GUARDA_PISO = 90;
export const DIAS_DE_GUARDA_TETO = 365;

/** Os dois marcos de aviso, em dias antes da exclusão. */
export const MARCO_LONGO_DIAS = 30;
export const MARCO_CURTO_DIAS = 7;

export type MarcoDoAviso = "d30" | "d7";

const FUSO = "America/Sao_Paulo";

/** `2026-10-16` no fuso de São Paulo. */
export function diaCivil(data: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" }).format(data);
}

/** `dd/mm/aaaa` no fuso de São Paulo (o formato do e-mail e do banner). */
export function dataBr(data: Date): string {
  const [a, m, d] = diaCivil(data).split("-");
  return `${d}/${m}/${a}`;
}

/** Quantos dias civis faltam de `agora` até `excluirEm` (negativo = já passou, 0 = hoje). */
export function diasRestantes(excluirEm: Date, agora: Date): number {
  const [a1, m1, d1] = diaCivil(agora).split("-").map(Number) as [number, number, number];
  const [a2, m2, d2] = diaCivil(excluirEm).split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86_400_000);
}

/** A data da exclusão a partir do fim da assinatura: fim + N dias (a mesma conta de `fn_exclusao_sincronizar`). */
export function dataDaExclusao(fimDaAssinatura: Date, diasDeGuarda: number): Date {
  return new Date(fimDaAssinatura.getTime() + diasDeGuarda * 86_400_000);
}

/**
 * Qual aviso está devido hoje, ou `null`. D-7 vale de 7 dias até 1 dia antes; D-30 de 30 até 8 dias antes (uma
 * rodada perdida não faz o aviso sumir). Programação feita com menos de 30 dias de prazo não manda o D-30
 * atrasado: manda só o D-7 quando chegar a hora. No dia da exclusão (0) e depois dela não há aviso. Quem já foi
 * enviado (`jaEnviados`) não volta.
 */
export function avisoDevido(
  excluirEm: Date,
  agora: Date,
  jaEnviados: { d30: boolean; d7: boolean },
): MarcoDoAviso | null {
  const dias = diasRestantes(excluirEm, agora);
  if (dias <= 0) return null;
  if (dias <= MARCO_CURTO_DIAS) return jaEnviados.d7 ? null : "d7";
  if (dias <= MARCO_LONGO_DIAS) return jaEnviados.d30 ? null : "d30";
  return null;
}

/** A chave de idempotência do aviso na fila de e-mails: por data de exclusão e marco. */
export function chaveDoAviso(excluirEm: Date, marco: MarcoDoAviso): string {
  return `exclusao:${diaCivil(excluirEm)}:${marco}`;
}

/**
 * Interpreta a configuração `DIAS_DE_GUARDA_APOS_CANCELAMENTO`. Vazio = a instalação nunca configurou: vale o
 * padrão de 90. Valor preenchido que não é inteiro de 90 a 365 (o mesmo intervalo de `fn_exclusao_sincronizar`) é
 * INVÁLIDO, e quem chama aborta a rodada: cair para 90 poderia ENCURTAR um prazo que a instalação alongou e
 * apagar gente sem o aviso que eles esperavam.
 */
export type DiasDeGuarda = { ok: true; dias: number } | { ok: false };

export function interpretarDiasDeGuarda(bruto: string | null | undefined): DiasDeGuarda {
  const texto = (bruto ?? "").trim();
  if (texto === "") return { ok: true, dias: DIAS_DE_GUARDA_PADRAO };
  if (!/^\d{1,4}$/.test(texto)) return { ok: false };
  const n = Number(texto);
  if (n < DIAS_DE_GUARDA_PISO || n > DIAS_DE_GUARDA_TETO) return { ok: false };
  return { ok: true, dias: n };
}
