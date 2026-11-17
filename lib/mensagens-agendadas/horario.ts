/**
 * O horário da mensagem agendada, sempre NO FUSO DA ORGANIZAÇÃO.
 *
 * O seletor da tela mostra data e hora de parede; o banco guarda o instante
 * (timestamptz). A conversão é a da agenda (`lib/agenda/fuso.ts`), para quem
 * está noutro fuso no navegador ler a mesma hora que o cliente vai receber.
 */
import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";

/** Fuso de reserva quando a organização não tem um (o padrão do produto). */
export const FUSO_PADRAO = "America/Sao_Paulo";

const dois = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` + `HH:MM` no fuso → instante. `null` quando a entrada não é data e hora. */
export function instanteDaParede(data: string, hora: string, fuso: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  const h = /^(\d{2}):(\d{2})$/.exec(hora);
  if (!d || !h) return null;
  const [ano, mes, dia, hh, mm] = [d[1], d[2], d[3], h[1], h[2]].map(Number) as [number, number, number, number, number];
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || hh > 23 || mm > 59) return null;
  const instante = instanteDe({ ano, mes, dia, hora: hh, minuto: mm }, fuso);
  return Number.isNaN(instante.getTime()) ? null : instante;
}

/** O instante como data e hora de parede no fuso, nos formatos dos `<input>` da tela. */
export function paredeDoInstante(instante: Date, fuso: string): { data: string; hora: string } {
  const p = partesNoFuso(instante, fuso);
  return { data: `${p.ano}-${dois(p.mes)}-${dois(p.dia)}`, hora: `${dois(p.hora)}:${dois(p.minuto)}` };
}

/** "18/11" e "14:30" — o rótulo curto do selo e do balão, no fuso da organização. */
export function rotuloDoHorario(instante: Date, fuso: string, tag: string): { data: string; hora: string } {
  const data = new Intl.DateTimeFormat(tag, { timeZone: fuso, day: "2-digit", month: "2-digit" }).format(instante);
  const hora = new Intl.DateTimeFormat(tag, {
    timeZone: fuso,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instante);
  return { data, hora };
}
