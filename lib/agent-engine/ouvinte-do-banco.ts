/**
 * O OUVINTE DO BANCO: uma conexão `pg` dedicada que faz `LISTEN` e acorda os
 * laços do worker quando o Postgres avisa que há trabalho (migration 1000).
 *
 * ─── Por que ele existe ──────────────────────────────────────────────────────
 *
 * Medido em produção (pg_stat_statements, ~52 dias): o laço dos handlers do
 * `event_log` consultava o PostgREST ~18 mil vezes/dia e o relógio da
 * `job_queue` ~40 mil vezes/dia, quase tudo com a fila vazia. As linhas do
 * `event_log` nascem em sua maioria de TRIGGERS — nem o app nem o worker sabem
 * quando elas aparecem —, então o sinal tem de sair do banco. Os gatilhos da
 * 1000 fazem `pg_notify('hb_event_log', <tipos>)` e `pg_notify('hb_job_queue',
 * '')`; este módulo os escuta e chama `aoEventLog`/`aoJobQueue`, que cortam a
 * soneca em curso (`sinal-de-trabalho.ts` e `queue/soneca.ts`).
 *
 * ─── O contrato com os laços: `ouvindo()` ────────────────────────────────────
 *
 * Os laços só usam os tetos LONGOS de recuo enquanto `ouvindo()` é `true`. Com
 * o ouvinte caído (ou nunca ligado) eles voltam aos tetos curtos de antes —
 * nenhum trabalho depende do NOTIFY chegar, ele só encurta a espera. Toda
 * mudança de estado ACORDA os dois laços:
 *
 *   - ao ligar, porque o que chegou enquanto não havia ouvinte não foi avisado;
 *   - ao cair, porque um laço dormindo o teto longo tem de recalcular a soneca
 *     com o teto curto agora, e não daqui a cinco minutos.
 *
 * ─── `ouvindo` só depois de PROVAR que o NOTIFY volta ────────────────────────
 *
 * `LISTEN` num pooler em modo transação (Supavisor/PgBouncer, porta 6543 no
 * Supabase) é aceito e NUNCA entrega nada: a sessão é devolvida ao pool depois
 * de cada comando. Marcar `ouvindo=true` só porque o `LISTEN` respondeu poria os
 * laços em soneca de cinco minutos sem ninguém para acordá-los. Por isso o
 * ouvinte manda um `pg_notify` de prova para si mesmo e só liga quando ele
 * volta; e repete a prova a cada `pingMs` — é também o que detecta o socket
 * mudo (Postgres reiniciado sem FIN chegar), que não emite `error`. URL com a
 * porta 6543 nem tenta.
 *
 * ─── Queda e reconexão ───────────────────────────────────────────────────────
 *
 * `error`/`end` da conexão, falha no LISTEN ou prova sem resposta: `ouvindo`
 * vira `false` na hora, a conexão é descartada e outra é aberta com recuo
 * exponencial (1 s, 2 s, 4 s… até `recuoMaxMs`). Cada conexão tem uma GERAÇÃO:
 * evento atrasado de uma conexão já descartada não mexe no estado da atual.
 *
 * Nunca lança: falha do ouvinte é degradação para o ritmo antigo, não motivo
 * para derrubar o worker.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import type { Logger } from './obs/logger';

export const CANAL_EVENT_LOG = 'hb_event_log';
export const CANAL_JOB_QUEUE = 'hb_job_queue';
/** Canal só da prova de vida. Cada worker reconhece a PRÓPRIA prova pelo token. */
export const CANAL_PROVA = 'hb_ouvinte_ping';

/** O mínimo de uma conexão que escuta. A de produção embrulha um `pg.Client`. */
export interface ClienteDeEscuta {
  conectar(): Promise<void>;
  consultar(sql: string, params?: string[]): Promise<void>;
  encerrar(): Promise<void>;
  aoNotificar(fn: (canal: string, payload: string) => void): void;
  /** `error` ou `end` da conexão. Pode disparar mais de uma vez. */
  aoCair(fn: (motivo: string) => void): void;
}

export interface OpcoesDoOuvinte {
  criarCliente: () => ClienteDeEscuta;
  /** Chamado com o payload do `hb_event_log` (tipos separados por vírgula, ou `*`). */
  aoEventLog: (tipos: string) => void;
  aoJobQueue: () => void;
  log: Logger;
  signal: AbortSignal;
  /** Primeira espera da reconexão. Default 1 s. */
  recuoInicialMs?: number;
  /** Teto do recuo da reconexão. Default 5 min. */
  recuoMaxMs?: number;
  /** De quanto em quanto tempo a prova de vida se repete. Default 60 s. */
  pingMs?: number;
  /** Quanto a prova espera o próprio NOTIFY voltar. Default 10 s. */
  prazoDaProvaMs?: number;
}

export interface OuvinteDoBanco {
  /** `true` só com a conexão de pé E a última prova de vida respondida. */
  ouvindo(): boolean;
  /** Resolve depois do abort do `signal`, com a conexão encerrada. */
  encerrado: Promise<void>;
  /**
   * Resolve quando a PRIMEIRA tentativa termina: `true` se ligou, `false` se
   * caiu (e a reconexão segue no recuo). É o que a linha de boot espera para
   * dizer a verdade sobre o ouvinte. Nunca rejeita.
   */
  primeiraTentativa: Promise<boolean>;
}

/** Ouvinte que nunca liga — o que o worker usa quando a URL não suporta LISTEN. */
export function ouvinteDesligado(): OuvinteDoBanco {
  return { ouvindo: () => false, encerrado: Promise.resolve(), primeiraTentativa: Promise.resolve(false) };
}

/**
 * A porta 6543 é a do pooler em modo TRANSAÇÃO do Supabase, onde `LISTEN` não
 * entrega notificação. A prova de vida pegaria isso também; recusar antes evita
 * uma conexão de tentativa a cada recuo para sempre.
 */
export function urlSemSuporteALISTEN(url: string): boolean {
  try {
    return new URL(url).port === '6543';
  } catch {
    return false;
  }
}

function msg(err: unknown): string {
  return ((err instanceof Error ? err.message : String(err)).split('\n', 1)[0] ?? '').slice(0, 300);
}

/** A conexão de produção: `pg.Client` cru, fora do pool, com teto de leitura. */
export function clienteDeEscutaPg(databaseUrl: string): ClienteDeEscuta {
  const cliente = new pg.Client({
    connectionString: databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    query_timeout: 10_000,
    // Conexão que não completa em 10 s conta como queda e entra no recuo: sem
    // isto, um `connect` pendurado deixaria o ouvinte parado sem reconectar.
    connectionTimeoutMillis: 10_000,
    application_name: 'agent-worker-ouvinte',
  });
  return {
    conectar: async () => {
      await cliente.connect();
    },
    consultar: async (sql, params) => {
      await cliente.query(sql, params);
    },
    encerrar: async () => {
      await cliente.end();
    },
    aoNotificar: (fn) => {
      cliente.on('notification', (n) => fn(n.channel, n.payload ?? ''));
    },
    aoCair: (fn) => {
      cliente.on('error', (err) => fn(msg(err)));
      cliente.on('end', () => fn('conexão encerrada'));
    },
  };
}

export function iniciarOuvinteDoBanco(o: OpcoesDoOuvinte): OuvinteDoBanco {
  const recuoInicialMs = o.recuoInicialMs ?? 1_000;
  const recuoMaxMs = o.recuoMaxMs ?? 300_000;
  const pingMs = o.pingMs ?? 60_000;
  const prazoDaProvaMs = o.prazoDaProvaMs ?? 10_000;

  let ouvindo = false;
  let geracao = 0;
  let falhasSeguidas = 0;
  let atual: ClienteDeEscuta | null = null;
  let timerReconexao: ReturnType<typeof setTimeout> | undefined;
  let timerPing: ReturnType<typeof setTimeout> | undefined;
  // A prova em curso: o token que tem de voltar e quem espera por ele.
  let prova: { token: string; resolver: (ok: boolean) => void } | null = null;

  let resolverPrimeira!: (ok: boolean) => void;
  const primeiraTentativa = new Promise<boolean>((resolve) => {
    resolverPrimeira = resolve;
  });
  let resolverEncerrado!: () => void;
  const encerrado = new Promise<void>((resolve) => {
    resolverEncerrado = resolve;
  });

  const acordarOsDois = (): void => {
    try {
      o.aoEventLog('*');
    } catch {
      /* acordar nunca derruba o ouvinte */
    }
    try {
      o.aoJobQueue();
    } catch {
      /* idem */
    }
  };

  const mudar = (v: boolean): void => {
    // Resolver duas vezes é no-op: só a primeira mudança (ou queda) conta.
    resolverPrimeira(v);
    if (ouvindo === v) return;
    ouvindo = v;
    acordarOsDois();
  };

  const encerrarCliente = (c: ClienteDeEscuta | null): void => {
    if (c) c.encerrar().catch(() => undefined);
  };

  const abandonarProva = (): void => {
    const p = prova;
    prova = null;
    p?.resolver(false);
  };

  const provar = async (c: ClienteDeEscuta): Promise<boolean> => {
    const token = randomUUID();
    const voltou = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (prova?.token === token) prova = null;
        resolve(false);
      }, prazoDaProvaMs);
      prova = {
        token,
        resolver: (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
      };
    });
    await c.consultar('select pg_notify($1, $2)', [CANAL_PROVA, token]);
    return voltou;
  };

  const queda = (motivo: string): void => {
    geracao += 1;
    if (timerPing !== undefined) clearTimeout(timerPing);
    timerPing = undefined;
    abandonarProva();
    const c = atual;
    atual = null;
    encerrarCliente(c);
    const estavaOuvindo = ouvindo;
    mudar(false);
    resolverPrimeira(false);
    if (o.signal.aborted) return;
    const espera = Math.min(recuoInicialMs * 2 ** Math.min(falhasSeguidas, 30), recuoMaxMs);
    falhasSeguidas += 1;
    const dados = { motivo, reconecta_em_ms: espera };
    if (estavaOuvindo) {
      o.log.warn('ouvinte do banco caiu — laços voltam aos tetos curtos até reconectar', dados);
    } else {
      o.log.warn('ouvinte do banco sem conexão — laços seguem nos tetos curtos', dados);
    }
    timerReconexao = setTimeout(() => {
      timerReconexao = undefined;
      void conectar();
    }, espera);
  };

  const armarPing = (minha: number, c: ClienteDeEscuta): void => {
    timerPing = setTimeout(() => {
      timerPing = undefined;
      if (minha !== geracao) return;
      provar(c)
        .then((ok) => {
          if (minha !== geracao) return;
          if (ok) armarPing(minha, c);
          else queda('prova de vida sem resposta');
        })
        .catch((err: unknown) => {
          if (minha === geracao) queda(msg(err));
        });
    }, pingMs);
  };

  const conectar = async (): Promise<void> => {
    if (o.signal.aborted) return;
    geracao += 1;
    const minha = geracao;
    let c: ClienteDeEscuta;
    try {
      c = o.criarCliente();
    } catch (err) {
      queda(msg(err));
      return;
    }
    atual = c;
    c.aoNotificar((canal, payload) => {
      if (minha !== geracao) return;
      if (canal === CANAL_PROVA) {
        if (prova?.token === payload) {
          const p = prova;
          prova = null;
          p.resolver(true);
        }
        return;
      }
      try {
        if (canal === CANAL_EVENT_LOG) o.aoEventLog(payload);
        else if (canal === CANAL_JOB_QUEUE) o.aoJobQueue();
      } catch {
        /* acordar nunca derruba o ouvinte */
      }
    });
    c.aoCair((motivo) => {
      if (minha === geracao) queda(motivo);
    });
    try {
      await c.conectar();
      for (const canal of [CANAL_EVENT_LOG, CANAL_JOB_QUEUE, CANAL_PROVA]) {
        await c.consultar(`listen ${canal}`);
      }
      const ok = await provar(c);
      if (minha !== geracao) return;
      if (!ok) {
        queda('o NOTIFY de prova não voltou (pooler em modo transação?)');
        return;
      }
      if (o.signal.aborted) return;
      falhasSeguidas = 0;
      mudar(true);
      o.log.info('ouvinte do banco: ouvindo', {
        canais: [CANAL_EVENT_LOG, CANAL_JOB_QUEUE],
      });
      armarPing(minha, c);
    } catch (err) {
      if (minha === geracao) queda(msg(err));
    }
  };

  const aoAbortar = (): void => {
    geracao += 1;
    if (timerReconexao !== undefined) clearTimeout(timerReconexao);
    if (timerPing !== undefined) clearTimeout(timerPing);
    timerReconexao = undefined;
    timerPing = undefined;
    abandonarProva();
    ouvindo = false;
    resolverPrimeira(false);
    const c = atual;
    atual = null;
    if (c) {
      c.encerrar()
        .catch(() => undefined)
        .finally(resolverEncerrado);
    } else {
      resolverEncerrado();
    }
  };

  if (o.signal.aborted) {
    resolverPrimeira(false);
    resolverEncerrado();
  } else {
    o.signal.addEventListener('abort', aoAbortar, { once: true });
    void conectar();
  }

  return { ouvindo: () => ouvindo, encerrado, primeiraTentativa };
}
