/**
 * Per-tenant rate limit for agent dispatch (S-13.07).
 *
 * Fixed-window counter on Upstash Redis: `ai-runs:<org>:<window-start>` with
 * INCR + EXPIRE. Sub-minute granularity is good enough for the 60/min default
 * and avoids pulling in `@upstash/ratelimit` (no new deps for this wave).
 *
 * In-memory fallback mirrors `lib/ai/rag/debounce.ts` — loud warn so operators
 * notice when Redis is misconfigured and the limit is effectively per-instance.
 */

import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { validarConfigRedisRest } from "@/lib/redis-config";

let _redis: Redis | null = null;
let _fallbackWarned = false;

function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  // A FORMA do valor é conferida antes de virar cliente. Sem isto, um `.env`
  // com as aspas sobrando constrói um cliente que falha em TODA chamada: cada
  // login paga uma ida à rede condenada e o aviso que sobra fala do Redis, não
  // do arquivo que precisa ser editado. Ver `lib/redis-config.ts`.
  const config = validarConfigRedisRest(url, token);
  if (!config.ok) {
    if (!_fallbackWarned) {
      logger.warn(
        `[ai-dispatcher.rate-limit] Redis ${config.reason} — using in-memory fallback (not safe for multi-instance)`,
      );
      _fallbackWarned = true;
    }
    return null;
  }
  // `retry: false`: com Redis inalcançável (URL errada, rede caída), o default
  // do SDK re-tenta com backoff e cada chamada passa a custar SEGUNDOS. Como
  // já existe fallback em memória logo abaixo, retentar aqui só transfere a
  // indisponibilidade do Redis para a latência do login. Falhe rápido e caia
  // para a memória. Medido: com URL morta, duas chamadas somavam ~8s numa
  // requisição de recuperação de senha, estourando o timeout da tela.
  _redis = new Redis({ url, token, retry: false });
  return _redis;
}

interface MemBucket {
  count: number;
  expiresAt: number;
}
const _memBuckets = new Map<string, MemBucket>();

/**
 * VARREDURA DAS JANELAS VENCIDAS — sem ela o mapa cresce para sempre.
 *
 * A chave embute a janela (`<bucket>:<windowStart>`), então uma chave nunca volta a
 * ser consultada depois de expirar: `windowStart` avança e a próxima chamada usa
 * outra chave. O `set` só sobrescrevia a MESMA chave, e nada apagava as anteriores —
 * o processo acumulava uma entrada por bucket por janela, indefinidamente.
 *
 * E o caminho em memória não é hipótese remota — mas a razão NÃO é a que este
 * comentário afirmava. A versão anterior dizia que as duas variáveis do Upstash são
 * "opcionais no kit self-host, então sem elas este é o caminho normal": falso, e
 * medido — `lib/env.ts:83-84` as declara `required()`, o app não sobe sem elas, e o
 * `.env.hostgator.example` as entrega apontando para o contêiner `srh`.
 *
 * O que de fato leva para cá é Redis INALCANÇÁVEL com a variável presente: contêiner
 * `srh` parado, rede caída, URL errada. O `catch` abaixo trata exatamente isso, e é o
 * estado normal da suíte de e2e — 120 quedas num único job, todas por `fetch failed`.
 * Num processo de longa duração, cada janela dessas deixava uma chave para trás: com
 * `webhook_in:<token>` (janela de 60s) são 1.440 por dia por token, nenhuma relida.
 *
 * Oportunista, e não um timer: um `setInterval` num módulo de request handler segura
 * o processo vivo e roda em todo runtime que importar o arquivo, inclusive edge. Aqui
 * o custo é O(n) uma vez a cada `VARRE_A_CADA` chamadas, e o resto entre passagens é
 * limitado por esse mesmo número.
 */
const VARRE_A_CADA = 128;
let _chamadasDesdeAVarredura = 0;

function varrerVencidas(agora: number): void {
  for (const [chave, balde] of _memBuckets) {
    if (balde.expiresAt <= agora) _memBuckets.delete(chave);
  }
}

function memIncrement(key: string, windowSec: number): number {
  const now = Date.now();
  if (++_chamadasDesdeAVarredura >= VARRE_A_CADA) {
    _chamadasDesdeAVarredura = 0;
    varrerVencidas(now);
  }
  const existing = _memBuckets.get(key);
  if (!existing || existing.expiresAt <= now) {
    _memBuckets.set(key, { count: 1, expiresAt: now + windowSec * 1000 });
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

/** Só para teste: quantas chaves o contador em memória guarda NESTE instante. */
export function __chavesEmMemoriaParaTeste(): number {
  return _memBuckets.size;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  window_sec: number;
  /**
   * Janela em que o incremento caiu. É o que `devolverRateLimit` precisa para
   * devolver NA MESMA janela — a que virou entre o gasto e a devolução não pode
   * ser debitada por uma vaga que nunca saiu dela.
   */
  window_start?: number;
}

/**
 * Increments the per-tenant counter for the current window and returns whether
 * the call is below the limit. Counter expires automatically — no cleanup
 * needed beyond Redis TTL.
 */
export async function checkRateLimit(
  bucket: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const windowStart = Math.floor(Date.now() / (windowSec * 1000));
  const key = `${bucket}:${windowStart}`;

  const redis = getRedis();
  let count: number;
  if (!redis) {
    count = memIncrement(key, windowSec);
  } else {
    try {
      count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, windowSec);
      }
    } catch (err) {
      logger.warn("[ai-dispatcher.rate-limit] redis incr failed; falling back to in-memory", {
        error: err instanceof Error ? err.message : String(err),
        bucket,
      });
      count = memIncrement(key, windowSec);
    }
  }

  return {
    allowed: count <= limit,
    count,
    limit,
    window_sec: windowSec,
    window_start: windowStart,
  };
}

function memDecrement(key: string): void {
  const existing = _memBuckets.get(key);
  if (existing && existing.expiresAt > Date.now() && existing.count > 0) existing.count -= 1;
}

/**
 * DEVOLVE uma unidade ao contador: desfaz um `checkRateLimit` cujo efeito não se concretizou.
 *
 * Existe porque "gastar antes" queima a vaga de quem falhou (convite que não saiu, reenvio que
 * deu erro) e "só ler antes e gastar depois" deixa requisições concorrentes passarem juntas do
 * teto. Com a primitiva, o fluxo certo é reservar (incremento atômico, que já barra), tentar o
 * efeito e DEVOLVER se ele não aconteceu — o contador nunca fica abaixo do real nem concede
 * além do teto.
 *
 * Nunca fica negativo. Passe o `window_start` do resultado de `checkRateLimit` para devolver na
 * janela onde a vaga foi tomada; sem ele vale a janela corrente. Falha de Redis cai para a
 * memória, como no incremento, e nunca lança (devolver é compensação: não pode derrubar o
 * caminho de erro de quem a chama).
 */
export async function devolverRateLimit(
  bucket: string,
  windowSec: number,
  windowStart?: number,
): Promise<void> {
  const inicio = windowStart ?? Math.floor(Date.now() / (windowSec * 1000));
  const key = `${bucket}:${inicio}`;

  const redis = getRedis();
  if (!redis) {
    memDecrement(key);
    return;
  }
  try {
    const depois = await redis.decr(key);
    if (depois < 0) {
      // A chave não tinha vaga no Redis (o gasto caiu no contador em memória, ou a janela
      // expirou): desfaz o decremento e devolve no balde em memória, se houver.
      await redis.incr(key);
      // `decr` numa chave ausente a cria SEM expiração: sem isto ela ficaria para sempre.
      await redis.expire(key, windowSec);
      memDecrement(key);
    }
  } catch (err) {
    logger.warn("[ai-dispatcher.rate-limit] redis decr failed; falling back to in-memory", {
      error: err instanceof Error ? err.message : String(err),
      bucket,
    });
    memDecrement(key);
  }
}

/**
 * Lê o contador SEM incrementar (issue #64).
 *
 * Existe porque bloqueio por tentativa-que-falhou precisa de duas operações
 * distintas: *consultar* antes de chamar o provedor (senão o ataque nunca é
 * barrado antes de acontecer) e *incrementar* só quando a tentativa falha
 * (senão login bem-sucedido consome o orçamento e tranca quem acertou a senha).
 */
export async function peekRateLimit(bucket: string, windowSec: number): Promise<number> {
  const windowStart = Math.floor(Date.now() / (windowSec * 1000));
  const key = `${bucket}:${windowStart}`;

  const emMemoria = (): number => {
    const existing = _memBuckets.get(key);
    return !existing || existing.expiresAt <= Date.now() ? 0 : existing.count;
  };

  const redis = getRedis();
  if (!redis) return emMemoria();
  try {
    const value = await redis.get<number | string>(key);
    const noRedis = value == null ? 0 : Number(value);
    // O MAIOR DOS DOIS, e não o do Redis — issue #185.
    //
    // As duas trilhas precisam concordar sobre ONDE o contador mora, e não
    // concordavam: `checkRateLimit` cai para a memória quando a ESCRITA falha,
    // enquanto esta leitura só caía no `catch` se ela PRÓPRIA lançasse. Existe um
    // estado em que o Redis **recusa escrita e atende leitura** — MISCONF por
    // falha de persistência (disco cheio, permissão do `/data`, cota estourada),
    // que é o caso relatado no Docker Desktop do Windows. Aí o `incr` cai para a
    // memória, o `get` volta 200 com a chave ausente, e este peek devolvia 0 com
    // o contador real vivo na memória.
    //
    // O que morria com isso é o teto por CONTA de `lib/auth/rate-limit.ts` — o
    // único que barra força bruta distribuída por muitos IPs, e que o comentário
    // de lá declara "NÃO configurável" justamente por isso. Medido contra a pilha
    // real (@upstash/redis -> serverless-redis-http -> redis:7-alpine com o
    // `/data` sem permissão), 10 senhas erradas seguidas na MESMA conta, teto 5:
    //   MISCONF  -> [false x10]                       nunca bloqueou
    //   saudável -> [false x5, true x5]               bloqueou na 6ª
    // Duas fotos, uma variável trocada.
    //
    // Note que "Redis totalmente fora" NÃO tinha o buraco: aí as duas trilhas
    // caem juntas para a memória e o teto sobrevive por processo. O estado
    // perigoso é o PARCIAL — e é o que falha aberto se a leitura confiar só no
    // Redis. Aqui a política é falhar FECHADO: contar o maior, nunca o menor.
    //
    // O CASO QUE ISTO CUSTA, para a escolha ficar consciente: Redis que cai e
    // VOLTA dentro da mesma janela. Se 5 falhas do usuário X foram registradas
    // na memória enquanto o Redis estava fora, o contador compartilhado dele
    // segue em 0 quando volta — e o `max` mantém a conta trancada pelo resto da
    // janela (300s no login), mesmo com a senha certa. É deliberado e é o lado
    // certo de errar: as 5 falhas contadas foram falhas REAIS, o teto por conta
    // é o único que barra força bruta distribuída por muitos IPs, e o balde em
    // memória expira junto com a janela — o bloqueio tem fim, o vazamento não
    // teria. Com o Redis saudável nada disso ocorre: `checkRateLimit` só escreve
    // em `_memBuckets` no ramo de fallback, então `emMemoria()` devolve 0 e o
    // `max` é no-op.
    return Math.max(noRedis, emMemoria());
  } catch {
    return emMemoria();
  }
}
