import { fusoUtilizavel } from "@/lib/tempo/fusos";

/**
 * A data curta da lista de Automações ("Última execução em DD/MM/AAAA").
 *
 * Sempre no fuso da EMPRESA ativa (`organizations.timezone`), nunca no do
 * processo: a lista é desenhada no servidor (contêiner em UTC) e de novo no
 * navegador. Sem fuso fixo, uma execução no fim da noite virava "amanhã" no
 * servidor, o texto divergia e o React recusava a hidratação (#418, prévia de
 * 24/11). Fuso nulo ou que o `Intl` recusa cai no padrão (`fusoUtilizavel`).
 */
export function dataDaUltimaExecucao(iso: string, idioma: string, fuso: string | null | undefined): string {
  return new Date(iso).toLocaleDateString(idioma, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: fusoUtilizavel(fuso),
  });
}
