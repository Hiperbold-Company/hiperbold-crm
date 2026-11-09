/**
 * O ouvinte do banco (migration 1000): LISTEN numa conexão própria, acorda os
 * laços no NOTIFY, e só diz `ouvindo` depois de PROVAR que a notificação volta.
 *
 * A conexão é um dublê do Postgres (a fronteira externa), não do ouvinte: ele
 * entrega o NOTIFY de prova como o servidor entregaria — ou não, para simular o
 * pooler em modo transação, que aceita LISTEN e nunca entrega.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@/lib/agent-engine/obs/logger';
import {
  CANAL_EVENT_LOG,
  CANAL_JOB_QUEUE,
  CANAL_PROVA,
  iniciarOuvinteDoBanco,
  urlSemSuporteALISTEN,
  type ClienteDeEscuta,
} from '@/lib/agent-engine/ouvinte-do-banco';

interface Dublê extends ClienteDeEscuta {
  consultas: string[];
  encerrado: boolean;
  /** O servidor entrega o NOTIFY de prova? `false` = pooler em modo transação. */
  entrega: boolean;
  falharConexao: boolean;
  notificar(canal: string, payload: string): void;
  cair(motivo: string): void;
}

function dublê(): Dublê {
  let aoNotificar: ((canal: string, payload: string) => void) | null = null;
  let aoCair: ((motivo: string) => void) | null = null;
  const d: Dublê = {
    consultas: [],
    encerrado: false,
    entrega: true,
    falharConexao: false,
    conectar: async () => {
      if (d.falharConexao) throw new Error('connect ECONNREFUSED');
    },
    consultar: async (sql, params) => {
      if (d.encerrado) throw new Error('Client was closed');
      d.consultas.push(sql);
      if (sql.startsWith('select pg_notify') && d.entrega && params) {
        const [canal, token] = params;
        queueMicrotask(() => aoNotificar?.(canal!, token!));
      }
    },
    encerrar: async () => {
      d.encerrado = true;
    },
    aoNotificar: (fn) => {
      aoNotificar = fn;
    },
    aoCair: (fn) => {
      aoCair = fn;
    },
    notificar: (canal, payload) => aoNotificar?.(canal, payload),
    cair: (motivo) => aoCair?.(motivo),
  };
  return d;
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const logger = log as unknown as Logger;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function montar(fabrica: () => Dublê) {
  const abort = new AbortController();
  const criados: Dublê[] = [];
  const aoEventLog = vi.fn();
  const aoJobQueue = vi.fn();
  const ouvinte = iniciarOuvinteDoBanco({
    criarCliente: () => {
      const d = fabrica();
      criados.push(d);
      return d;
    },
    aoEventLog,
    aoJobQueue,
    log: logger,
    signal: abort.signal,
    recuoInicialMs: 1_000,
    recuoMaxMs: 8_000,
    pingMs: 60_000,
    prazoDaProvaMs: 5_000,
  });
  return { abort, criados, aoEventLog, aoJobQueue, ouvinte };
}

describe('iniciarOuvinteDoBanco', () => {
  it('liga só depois da prova: LISTEN nos três canais, ouvindo=true, e acorda os dois laços', async () => {
    const { criados, aoEventLog, aoJobQueue, ouvinte, abort } = montar(dublê);
    await expect(ouvinte.primeiraTentativa).resolves.toBe(true);
    expect(ouvinte.ouvindo()).toBe(true);
    expect(criados[0]!.consultas.slice(0, 3)).toEqual([
      `listen ${CANAL_EVENT_LOG}`,
      `listen ${CANAL_JOB_QUEUE}`,
      `listen ${CANAL_PROVA}`,
    ]);
    // Ligar acorda: o que chegou antes do ouvinte não foi avisado a ninguém.
    expect(aoEventLog).toHaveBeenCalledWith('*');
    expect(aoJobQueue).toHaveBeenCalledTimes(1);
    abort.abort();
    await ouvinte.encerrado;
    expect(criados[0]!.encerrado).toBe(true);
  });

  it('NOTIFY de cada canal chama o laço certo, com o payload', async () => {
    const { criados, aoEventLog, aoJobQueue, ouvinte, abort } = montar(dublê);
    await ouvinte.primeiraTentativa;
    aoEventLog.mockClear();
    aoJobQueue.mockClear();

    criados[0]!.notificar(CANAL_EVENT_LOG, 'media.persist_requested');
    expect(aoEventLog).toHaveBeenCalledWith('media.persist_requested');
    expect(aoJobQueue).not.toHaveBeenCalled();

    criados[0]!.notificar(CANAL_JOB_QUEUE, '');
    expect(aoJobQueue).toHaveBeenCalledTimes(1);

    // Prova de OUTRO worker no mesmo canal: não é nossa, ninguém acorda.
    criados[0]!.notificar(CANAL_PROVA, 'token-alheio');
    expect(aoEventLog).toHaveBeenCalledTimes(1);
    abort.abort();
  });

  it('pooler em modo transação (LISTEN aceito, NOTIFY nunca volta): nunca diz ouvindo', async () => {
    const { ouvinte, abort } = montar(() => Object.assign(dublê(), { entrega: false }));
    const primeira = ouvinte.primeiraTentativa;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(primeira).resolves.toBe(false);
    expect(ouvinte.ouvindo()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('sem conexão'),
      expect.objectContaining({ motivo: expect.stringContaining('pooler em modo transação') }),
    );
    abort.abort();
  });

  it('queda: ouvindo=false NA HORA, acorda os laços (tetos curtos) e reconecta com recuo', async () => {
    const { criados, aoEventLog, aoJobQueue, ouvinte, abort } = montar(dublê);
    await ouvinte.primeiraTentativa;
    aoEventLog.mockClear();
    aoJobQueue.mockClear();

    criados[0]!.cair('Connection terminated unexpectedly');
    expect(ouvinte.ouvindo()).toBe(false);
    expect(aoEventLog).toHaveBeenCalledWith('*');
    expect(aoJobQueue).toHaveBeenCalledTimes(1);
    expect(criados[0]!.encerrado).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('caiu'),
      expect.objectContaining({ reconecta_em_ms: 1_000 }),
    );

    // Antes do recuo, nenhuma conexão nova.
    await vi.advanceTimersByTimeAsync(999);
    expect(criados).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(criados).toHaveLength(2);
    expect(ouvinte.ouvindo()).toBe(true);

    // Evento atrasado da conexão VELHA não mexe no estado da nova.
    criados[0]!.cair('eco tardio');
    expect(ouvinte.ouvindo()).toBe(true);
    abort.abort();
  });

  it('banco fora do ar: o recuo da reconexão dobra até o teto e volta a 1 s depois de ligar', async () => {
    let fora = true;
    const { criados, ouvinte, abort } = montar(() =>
      Object.assign(dublê(), { falharConexao: fora }),
    );
    await vi.advanceTimersByTimeAsync(0);
    // Tentativas em 0, 1, 3, 7, 15, 23 s (recuo 1, 2, 4, 8, 8).
    await vi.advanceTimersByTimeAsync(23_000);
    expect(criados).toHaveLength(6);
    const recuos = log.warn.mock.calls.map((c) => (c[1] as { reconecta_em_ms: number }).reconecta_em_ms);
    expect(recuos).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
    expect(ouvinte.ouvindo()).toBe(false);

    fora = false;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(ouvinte.ouvindo()).toBe(true);

    log.warn.mockClear();
    criados.at(-1)!.cair('reinício do Postgres');
    expect(log.warn.mock.calls[0]![1]).toMatchObject({ reconecta_em_ms: 1_000 });
    abort.abort();
  });

  it('prova de vida periódica: socket mudo (NOTIFY para de voltar) derruba e reconecta', async () => {
    const { criados, ouvinte, abort } = montar(dublê);
    await ouvinte.primeiraTentativa;
    criados[0]!.entrega = false;

    await vi.advanceTimersByTimeAsync(60_000); // dispara a prova
    expect(ouvinte.ouvindo()).toBe(true); // ainda dentro do prazo da prova
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ouvinte.ouvindo()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('caiu'),
      expect.objectContaining({ motivo: 'prova de vida sem resposta' }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(criados).toHaveLength(2);
    expect(ouvinte.ouvindo()).toBe(true);
    abort.abort();
  });

  it('desligamento: encerra a conexão, não reconecta e não deixa timer', async () => {
    const { criados, ouvinte, abort } = montar(dublê);
    await ouvinte.primeiraTentativa;
    abort.abort();
    await ouvinte.encerrado;
    expect(ouvinte.ouvindo()).toBe(false);
    expect(criados[0]!.encerrado).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(criados).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('laço que lança no acordar não derruba o ouvinte', async () => {
    const abort = new AbortController();
    const ouvinte = iniciarOuvinteDoBanco({
      criarCliente: dublê,
      aoEventLog: () => {
        throw new Error('boom');
      },
      aoJobQueue: () => {
        throw new Error('boom');
      },
      log: logger,
      signal: abort.signal,
    });
    await expect(ouvinte.primeiraTentativa).resolves.toBe(true);
    expect(ouvinte.ouvindo()).toBe(true);
    abort.abort();
  });
});

describe('urlSemSuporteALISTEN', () => {
  it('a porta 6543 (pooler do Supabase em modo transação) não liga o ouvinte', () => {
    expect(urlSemSuporteALISTEN('postgresql://u:p@aws-0-sa-east-1.pooler.supabase.com:6543/postgres')).toBe(true);
    expect(urlSemSuporteALISTEN('postgresql://u:p@aws-0-sa-east-1.pooler.supabase.com:5432/postgres')).toBe(false);
    expect(urlSemSuporteALISTEN('postgresql://u:p@db:5432/postgres')).toBe(false);
    expect(urlSemSuporteALISTEN('isto não é url')).toBe(false);
  });
});
