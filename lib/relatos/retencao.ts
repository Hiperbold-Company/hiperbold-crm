/**
 * A poda dos relatos de problema (migration 1018): linha e print com mais de 90 dias.
 *
 * Roda dentro do cron `data-retention`, fora do `podarHistorico` (as podas dele são por função do
 * banco; esta tem arquivo no Storage). Ordem: ler o lote vencido, remover os prints, apagar as
 * linhas. Se a remoção do arquivo falhar, a linha fica para a rodada seguinte (sem ponteiro, o
 * arquivo nunca mais seria achado). Erro sobe: quem chama nomeia a falha e audita.
 */
import { RETENCAO_DOS_RELATOS_DIAS } from "./regras";

export const LOTE_DOS_RELATOS = 200;
export const MAX_LOTES_DOS_RELATOS = 20;

/** Só a superfície que a poda usa — o teste injeta uma implementação. */
export interface PodaDosRelatosDb {
  vencidos(antesDe: string, lote: number): Promise<{
    data: { id: string; screenshot_path: string | null }[] | null;
    error: { message: string } | null;
  }>;
  removerPrints(caminhos: string[]): Promise<{ error: { message: string } | null }>;
  apagar(ids: string[]): Promise<{ data: number | null; error: { message: string } | null }>;
}

export interface ResultadoDaPodaDosRelatos {
  relatos_apagados: number;
  prints_apagados: number;
  lotes_relatos: number;
  relatos_tem_resto: boolean;
  retencao_relatos_dias: number;
}

export async function podarRelatosVencidos(
  db: PodaDosRelatosDb,
  agora: number = Date.now(),
): Promise<ResultadoDaPodaDosRelatos> {
  const corte = new Date(agora - RETENCAO_DOS_RELATOS_DIAS * 86_400_000).toISOString();
  const resultado: ResultadoDaPodaDosRelatos = {
    relatos_apagados: 0,
    prints_apagados: 0,
    lotes_relatos: 0,
    relatos_tem_resto: false,
    retencao_relatos_dias: RETENCAO_DOS_RELATOS_DIAS,
  };
  for (let i = 0; i < MAX_LOTES_DOS_RELATOS; i += 1) {
    const { data, error } = await db.vencidos(corte, LOTE_DOS_RELATOS);
    if (error) throw new Error(`bug_reports: ${error.message}`);
    const linhas = data ?? [];
    if (linhas.length === 0) return resultado;
    const caminhos = linhas.map((l) => l.screenshot_path).filter((c): c is string => !!c);
    if (caminhos.length > 0) {
      const { error: erroDoArquivo } = await db.removerPrints(caminhos);
      if (erroDoArquivo) throw new Error(`bug_reports: ${erroDoArquivo.message}`);
      resultado.prints_apagados += caminhos.length;
    }
    const { data: apagados, error: erroDaLinha } = await db.apagar(linhas.map((l) => l.id));
    if (erroDaLinha) throw new Error(`bug_reports: ${erroDaLinha.message}`);
    resultado.relatos_apagados += apagados ?? 0;
    resultado.lotes_relatos += 1;
    if (linhas.length < LOTE_DOS_RELATOS) return resultado;
  }
  resultado.relatos_tem_resto = true;
  return resultado;
}
