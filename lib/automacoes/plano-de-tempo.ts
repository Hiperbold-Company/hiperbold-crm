/**
 * O PLANO DE TEMPO DAS ESPERAS POR HORÁRIO das automações (lote 6).
 *
 * Duas esperas novas do bloco "Esperar", só na superfície `automacao`:
 *
 *  - `until_time` — "até um dia e horário": hoje, amanhã, daqui a N dias ou o
 *    próximo <dia da semana>, sempre às HH:MM no fuso da organização;
 *  - `until_date_field` — "até a data de um campo do negócio", com N dias antes
 *    ou depois e a hora do dia.
 *
 * Este arquivo é PURO: recebe o instante de agora e o fuso, devolve o instante
 * em que a espera termina. O motor (`node-handlers.ts`) só decide o que fazer
 * com ele.
 *
 * ─── Calendário e fuso ─────────────────────────────────────────────────────
 *
 * O dia é contado no relógio de parede da organização (`partesNoFuso`), e a hora
 * pedida vira instante por `instanteDe` (`lib/agenda/fuso.ts`) — a mesma peça da
 * agenda, que já decide as duas bordas do horário de verão: a hora que não existe
 * (o relógio pulou) vira o primeiro instante que existiu naquele dia; a hora que
 * acontece duas vezes fica com a primeira. Somar dias é conta de calendário em
 * UTC (`Date.UTC`), nunca `+ 24 h`: num dia de virada de horário de verão, 24 h
 * depois das 09:00 é 08:00 ou 10:00 na parede.
 *
 * ─── "Já passou" ───────────────────────────────────────────────────────────
 *
 *  - **Hoje às HH:MM** depois das HH:MM: a espera termina NA HORA (segue em
 *    frente). "Hoje às 9h" às 10h não vira "amanhã às 9h": quem quer o dia
 *    seguinte escolhe "amanhã". A tela diz isso ao lado da opção.
 *  - **Amanhã** e **daqui a N dias** (N ≥ 1) nunca "já passaram".
 *  - **Próximo <dia>**: o primeiro <dia> às HH:MM que ainda está no futuro. Se
 *    hoje é esse dia e a hora ainda não chegou, é hoje; se já passou, é daqui a
 *    7 dias.
 *  - **Data do campo**: a data (mais o deslocamento, na hora pedida) já passou,
 *    ou o campo está vazio ou ilegível → a espera sai por "Sem data". A data é
 *    lida UMA vez, ao entrar na espera: mudar o campo depois não move a espera
 *    em curso (simples e previsível — o que a tela mostrou é o que acontece).
 *
 * ─── Falha aberta ──────────────────────────────────────────────────────────
 *
 * Hora torta (`25:00`, vazio) só chega aqui num grafo escrito à mão: o publish a
 * recusa (`hora_da_espera_invalida`). Aqui ela não pode virar mordaça: "até um
 * dia e horário" com hora torta termina na hora; a data do campo com hora torta
 * sai por "Sem data".
 */
import { diaDaSemanaLocal, instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { dataDoValor } from "@/lib/automation/gatilho-de-data-do-funil";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

/** Os dias que a espera "até um dia e horário" oferece. */
export const QUANDO_DA_ESPERA = ["today", "tomorrow", "in_days", "next_weekday"] as const;
export type QuandoDaEspera = (typeof QUANDO_DA_ESPERA)[number];

/** "Daqui a N dias": de 1 a 365. */
export const DIAS_DA_ESPERA_MIN = 1;
export const DIAS_DA_ESPERA_MAX = 365;
/** Deslocamento da data do campo: dez anos para cada lado (o mesmo do gatilho por data). */
export const DESLOCAMENTO_MAX_DIAS = 3650;

const HORA_RX = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** `HH:MM` → hora e minuto, ou `null` quando não é uma hora do relógio. */
export function lerHora(hhmm: string | undefined | null): { hora: number; minuto: number } | null {
  if (typeof hhmm !== "string") return null;
  const m = HORA_RX.exec(hhmm.trim());
  if (!m) return null;
  return { hora: Number(m[1]), minuto: Number(m[2]) };
}

export function horaValida(hhmm: string | undefined | null): boolean {
  return lerHora(hhmm) !== null;
}

interface DiaCivil {
  ano: number;
  mes: number;
  dia: number;
}

/** Soma dias no CALENDÁRIO (em UTC, sem fuso no meio): virada de mês, ano e bissexto. */
function somarDias(d: DiaCivil, n: number): DiaCivil {
  const t = new Date(Date.UTC(d.ano, d.mes - 1, d.dia + n));
  return { ano: t.getUTCFullYear(), mes: t.getUTCMonth() + 1, dia: t.getUTCDate() };
}

/** A configuração da espera "até um dia e horário" (o que o nó guarda). */
export interface EsperaAteODia {
  when: QuandoDaEspera;
  /** Só em `in_days`. */
  days?: number;
  /** Só em `next_weekday`: 0 = domingo … 6 = sábado. */
  weekday?: number;
  /** `HH:MM` no fuso da organização. */
  time: string;
}

/**
 * O instante em que a espera "até um dia e horário" termina. Nunca antes de
 * `agora`: o "hoje" que já passou devolve o próprio `agora` (segue na hora).
 */
export function instanteAteODia(
  cfg: EsperaAteODia,
  agora: Date,
  fusoBruto: string | null | undefined,
): Date {
  const hora = lerHora(cfg.time);
  if (!hora) return agora;
  const fuso = fusoUtilizavel(fusoBruto);
  const p = partesNoFuso(agora, fuso);
  const hoje: DiaCivil = { ano: p.ano, mes: p.mes, dia: p.dia };
  const em = (d: DiaCivil) => instanteDe({ ...d, hora: hora.hora, minuto: hora.minuto }, fuso);

  switch (cfg.when) {
    case "today": {
      const alvo = em(hoje);
      return alvo.getTime() > agora.getTime() ? alvo : agora;
    }
    case "tomorrow":
      return em(somarDias(hoje, 1));
    case "in_days": {
      const n = Number.isInteger(cfg.days)
        ? Math.min(Math.max(cfg.days as number, DIAS_DA_ESPERA_MIN), DIAS_DA_ESPERA_MAX)
        : DIAS_DA_ESPERA_MIN;
      return em(somarDias(hoje, n));
    }
    case "next_weekday": {
      const alvoDow = Number.isInteger(cfg.weekday) ? (((cfg.weekday as number) % 7) + 7) % 7 : 1;
      const delta = (alvoDow - diaDaSemanaLocal(agora, fuso) + 7) % 7;
      const candidato = em(somarDias(hoje, delta));
      return candidato.getTime() > agora.getTime() ? candidato : em(somarDias(hoje, delta + 7));
    }
  }
}

/** A configuração da espera "até a data de um campo do negócio". */
export interface EsperaAteAData {
  /** A chave do campo de data em `crm_leads.custom_fields`. */
  field_key: string;
  /** Dias depois da data (negativo = antes; 0 = no dia). */
  offset_days: number;
  /** `HH:MM` no fuso da organização. */
  time: string;
}

/**
 * O instante "data do campo + deslocamento, às HH:MM", ou `null` quando o valor
 * não é uma data (vazio, texto, `30/02/2026`) ou a hora é torta. Aceita o ISO
 * que o formulário grava (`2026-11-20`, também com hora) e o `dd/mm/aaaa` da
 * importação — a mesma leitura do gatilho por data (`dataDoValor`).
 *
 * NÃO compara com agora: quem decide "já passou" é o motor, que tem o relógio.
 */
export function instanteDaDataDoCampo(
  valor: unknown,
  cfg: Pick<EsperaAteAData, "offset_days" | "time">,
  fusoBruto: string | null | undefined,
): Date | null {
  const hora = lerHora(cfg.time);
  const data = dataDoValor(valor);
  if (!hora || !data || !Number.isInteger(cfg.offset_days)) return null;
  if (Math.abs(cfg.offset_days) > DESLOCAMENTO_MAX_DIAS) return null;
  const [ano, mes, dia] = data.split("-").map(Number);
  if (ano === undefined || mes === undefined || dia === undefined) return null;
  const alvo = somarDias({ ano, mes, dia }, cfg.offset_days);
  return instanteDe({ ...alvo, hora: hora.hora, minuto: hora.minuto }, fusoUtilizavel(fusoBruto));
}

// ---------------------------------------------------------------------------
// As frases (card do bloco, resumo da execução, ajuda do formulário)
// ---------------------------------------------------------------------------

/** Literais por extenso: o gate de tradução enxerga cada chave usada. */
export const DIAS_DA_SEMANA_POR_EXTENSO = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
] as const;

/** "até amanhã, 09:00" — a espera inteira numa frase curta. */
export function fraseDaEsperaAteODia(cfg: EsperaAteODia): string {
  const hora = horaValida(cfg.time) ? cfg.time : "--:--";
  switch (cfg.when) {
    case "today":
      return `até hoje, ${hora}`;
    case "tomorrow":
      return `até amanhã, ${hora}`;
    case "in_days": {
      const n = cfg.days ?? DIAS_DA_ESPERA_MIN;
      return `até daqui a ${n} ${n === 1 ? "dia" : "dias"}, ${hora}`;
    }
    case "next_weekday": {
      const dia = DIAS_DA_SEMANA_POR_EXTENSO[cfg.weekday ?? 1] ?? DIAS_DA_SEMANA_POR_EXTENSO[1];
      const artigo = cfg.weekday === 0 || cfg.weekday === 6 ? "o próximo" : "a próxima";
      return `até ${artigo} ${dia}, ${hora}`;
    }
  }
}

/** "até 2 dias antes de “Data da visita”, 09:00". */
export function fraseDaEsperaAteAData(cfg: EsperaAteAData, nomeDoCampo?: string): string {
  const hora = horaValida(cfg.time) ? cfg.time : "--:--";
  const campo = `“${nomeDoCampo ?? cfg.field_key ?? "campo"}”`;
  const n = Math.abs(cfg.offset_days);
  const dias = `${n} ${n === 1 ? "dia" : "dias"}`;
  if (cfg.offset_days === 0) return `até a data de ${campo}, ${hora}`;
  if (cfg.offset_days < 0) return `até ${dias} antes de ${campo}, ${hora}`;
  return `até ${dias} depois de ${campo}, ${hora}`;
}
