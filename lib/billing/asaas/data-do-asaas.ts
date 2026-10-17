import { instanteDe } from "@/lib/agenda/fuso";

/**
 * Datas que o Asaas devolve sem fuso, lidas como HORA DE PAREDE de São Paulo.
 *
 * `expirationDate` do QR do Pix vem como `"2026-10-17 23:59:59"`. `new Date("2026-10-17 23:59:59")` lê isso no
 * fuso do NAVEGADOR de quem olha (e, no servidor, em UTC), então a hora mostrada ao cliente mudava com o
 * aparelho dele: um Pix que expira às 23:59 em São Paulo aparecia vencendo às 20:59 ou 02:59 do dia seguinte,
 * conforme o computador. Aqui a leitura é manual, pelas partes, e sempre em `America/Sao_Paulo`. Sem import de
 * servidor de propósito: a tela (componente de cliente) e o teste leem a mesma função.
 */
export const FUSO_DO_ASAAS = "America/Sao_Paulo";

const SEM_FUSO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const COM_FUSO = /(?:Z|[+-]\d{2}:?\d{2})$/;

/** O instante que a data do Asaas representa, ou `null` quando o texto não é uma data reconhecível. */
export function instanteDaDataDoAsaas(texto: string | null | undefined): Date | null {
  const bruto = (texto ?? "").trim();
  if (!bruto) return null;

  const m = SEM_FUSO.exec(bruto);
  if (m) {
    const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const hora = m[4] === undefined ? 0 : Number(m[4]);
    const minuto = m[5] === undefined ? 0 : Number(m[5]);
    const segundo = m[6] === undefined ? 0 : Number(m[6]);
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || hora > 23 || minuto > 59 || segundo > 59) return null;
    return instanteDe({ ano, mes, dia, hora, minuto, segundo }, FUSO_DO_ASAAS);
  }

  // Já carrega o fuso (ISO com Z ou deslocamento): o instante está dito, e só então vale o parser nativo.
  if (COM_FUSO.test(bruto)) {
    const instante = new Date(bruto);
    return Number.isNaN(instante.getTime()) ? null : instante;
  }
  return null;
}

/** A data do Asaas escrita no idioma de quem lê, SEMPRE no horário de São Paulo; `null` se não der para ler. */
export function formatarDataDoAsaas(texto: string | null | undefined, tagDoIdioma: string): string | null {
  const instante = instanteDaDataDoAsaas(texto);
  if (!instante) return null;
  return instante.toLocaleString(tagDoIdioma, { timeZone: FUSO_DO_ASAAS });
}
