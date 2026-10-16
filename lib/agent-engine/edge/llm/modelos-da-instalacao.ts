/**
 * `MODELOS_DA_INSTALACAO` lida pelo `pg.Pool` do motor — o freio de custo da chave
 * da instalação (regra em `@/lib/ai/modelos-da-instalacao`). Mesma razão do
 * `billing_settings` em `run-model-call.ts`: o caminho do turno não faz `fetch`
 * (invariante `autonomia-preview-core`), então a configuração de `platform_config`
 * vem do banco pelo mesmo `db`, com cache curto POR POOL.
 *
 * Ordem igual à do resolvedor da instalação: linha do banco (knob, não segredo);
 * sem linha, o `.env`; sem nada, o padrão. Nunca lança: erro de leitura vale o
 * padrão (que é a lista mais restrita — falhar fechado no custo, aberto no turno).
 */
import type pg from 'pg';

import { CHAVE_MODELOS_DA_INSTALACAO, lerModelosDaInstalacao } from '@/lib/ai/modelos-da-instalacao';

const TTL_MS = 60_000;
const SQL = `select valor from platform_config where chave = 'MODELOS_DA_INSTALACAO' and not eh_segredo limit 1`;
const cache = new WeakMap<pg.Pool, { lista: string[]; expiraEm: number }>();

export async function modelosDaInstalacaoPeloDb(db: pg.Pool): Promise<string[]> {
  const guardado = cache.get(db);
  if (guardado && guardado.expiraEm > Date.now()) return guardado.lista;
  // O `.env` só vale sem linha no banco (mesma ordem do resolvedor da instalação).
  const ambiente: Record<string, string | undefined> = process.env;
  let bruto: string | null = ambiente[CHAVE_MODELOS_DA_INSTALACAO] ?? null;
  try {
    const { rows } = await db.query<{ valor: string | null }>(SQL);
    const doBanco = rows?.[0]?.valor;
    if (typeof doBanco === 'string') bruto = doBanco;
  } catch {
    // tabela ausente (schema atrasado) ou banco indisponível: vale o .env / o padrão
  }
  const lista = lerModelosDaInstalacao(bruto);
  cache.set(db, { lista, expiraEm: Date.now() + TTL_MS });
  return lista;
}
