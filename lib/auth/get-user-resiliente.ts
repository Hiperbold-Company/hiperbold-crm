/**
 * `getUser()` que separa "não está logado" de "não deu para perguntar agora".
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Medido em produção: a cada publicação do CRM, quem estava logado caía em
 * `/login` e digitava a senha de novo — com a sessão ainda válida em
 * `auth.sessions`. Durante a troca de contêiner o `getUser()` falha por rede
 * (`AuthRetryableFetchError`, status 0 ou 502/503/504), e o `proxy.ts` e
 * `app/app/layout.tsx` liam `user: null` como "deslogado" e redirecionavam.
 *
 * O auth-js NÃO apaga a sessão nesse caso (`_callRefreshToken` só chama
 * `_removeSession` em erro não-retentável): quem mandava a pessoa embora era o
 * nosso código, não a biblioteca.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * - Erro TRANSITÓRIO (rede, 5xx, exceção lançada sem status de recusa): tenta
 *   de novo, com espera curta e dentro de um orçamento de tempo. Se persistir,
 *   devolve `indisponivel` — quem chama responde "tente de novo", nunca login.
 * - Erro DEFINITIVO (sessão ausente, JWT inválido/expirado, 401/403, usuário
 *   inexistente, 4xx em HTML de um proxy): `deslogado` na hora, sem tentar de
 *   novo. Falhar fechado continua sendo o desfecho para quem não tem sessão.
 *
 * Cada tentativa usa um CLIENTE NOVO: o GoTrueClient guarda a falha de refresh
 * por um tempo (`lastRefreshFailure`, cooldown) e, no mesmo cliente, a segunda
 * tentativa devolveria a falha em cache sem ir à rede.
 */

/** O mínimo de um erro do auth-js que a regra lê. */
export interface ErroDeAuth {
  name?: string;
  status?: number;
  code?: string;
  message?: string;
  /** `AuthUnknownError` carrega aqui o que a biblioteca pegou ao ler a resposta. */
  originalError?: unknown;
}

interface RespostaDoGetUser<U> {
  data: { user: U | null };
  error: ErroDeAuth | null;
}

export interface ClienteComAuth<U> {
  auth: { getUser: () => Promise<RespostaDoGetUser<U>> };
}

export type ResultadoDoGetUser<U> =
  | { estado: "autenticado"; user: U; erro: null }
  | { estado: "deslogado"; user: null; erro: ErroDeAuth | null }
  | { estado: "indisponivel"; user: null; erro: ErroDeAuth };

/** Esperas entre as tentativas: no máximo 2 novas tentativas, 1 s somadas. */
export const ESPERAS_PADRAO_MS: readonly number[] = [300, 700];

/**
 * Tentativa que demorou mais que isto NÃO ganha outra.
 *
 * O auth-js já repete sozinho dentro de `_refreshAccessToken` (backoff
 * 200/400/800… ms enquanto couber em 30 s — GoTrueClient.js:4021-4047). Uma
 * tentativa lenta é o sinal de que a biblioteca já repetiu; repetir por cima
 * multiplicaria a espera (~77 s no pior caso) e as chamadas a `/token` na
 * volta do GoTrue.
 */
export const LIMITE_DA_TENTATIVA_MS = 2000;

/** Orçamento da navegação inteira: a próxima espera só começa se couber nele. */
export const ORCAMENTO_TOTAL_MS = 3000;

/** `undefined`/0 (sem resposta) ou 5xx: lado do servidor ou da rede. */
function statusDeInfra(status: number | undefined): boolean {
  return status === undefined || status === 0 || status >= 500;
}

function statusDe(valor: unknown): number | undefined {
  if (!valor || typeof valor !== "object") return undefined;
  const s = (valor as { status?: unknown }).status;
  return typeof s === "number" ? s : undefined;
}

/**
 * Erro que vale tentar de novo.
 *
 * - `AuthRetryableFetchError`: o fetch não completou (status 0) ou o GoTrue
 *   respondeu 5xx/52x.
 * - `status >= 500`: erro do servidor de autenticação, não do token.
 * - `AuthUnknownError` (resposta que não era JSON): transitório só quando o
 *   status de origem é 0 ou 5xx. ⚠️ No auth-js 2.117.2 resposta não-JSON com
 *   5xx já vira `AuthRetryableFetchError` (lib/fetch.js:45), e o
 *   `originalError` do `AuthUnknownError` é o erro do `JSON.parse`, SEM
 *   status: o que chega aqui como `AuthUnknownError` é, por construção, um
 *   não-5xx (400/413/431…) em HTML de um proxy na frente — definitivo. Por isso
 *   status AUSENTE conta como definitivo neste caso, e só neste.
 *
 * Por `name` e não por `instanceof`: pode haver mais de uma cópia do auth-js
 * na árvore (ver `ehSessaoAusente` em `lib/auth/server.ts`).
 */
export function ehFalhaTransitoria(erro: ErroDeAuth | null | undefined): boolean {
  if (!erro) return false;
  if (erro.name === "AuthRetryableFetchError") return true;
  if (erro.name === "AuthUnknownError") {
    const s = statusDe(erro.originalError) ?? erro.status;
    return s !== undefined && statusDeInfra(s);
  }
  return typeof erro.status === "number" && erro.status >= 500;
}

function esperarDeVerdade(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exceção LANÇADA (não devolvida) pelo `getUser`. Sem status, ou com 0/5xx, é
 * rede ou servidor — transitória. Com status 4xx é recusa, e fica definitiva.
 */
function erroDaExcecao(e: unknown): ErroDeAuth {
  const o = e && typeof e === "object" ? (e as { name?: unknown; message?: unknown }) : {};
  const status = statusDe(e);
  const message = typeof o.message === "string" ? o.message : String(e);
  if (statusDeInfra(status)) {
    return { name: "AuthRetryableFetchError", message, status: status ?? 0 };
  }
  return { name: typeof o.name === "string" ? o.name : "Error", message, status };
}

export interface OpcoesDoGetUserResiliente {
  /** Uma espera por nova tentativa. `[]` = tentativa única. */
  esperasMs?: readonly number[];
  /** Injetável para o teste não dormir de verdade. */
  esperar?: (ms: number) => Promise<void>;
  /** Injetável para o teste medir tempo sem relógio de verdade. */
  agora?: () => number;
  limiteDaTentativaMs?: number;
  orcamentoTotalMs?: number;
}

/**
 * Chama `getUser()` com novas tentativas em falha transitória, dentro de um
 * orçamento de tempo (ver `LIMITE_DA_TENTATIVA_MS` e `ORCAMENTO_TOTAL_MS`).
 *
 * Não há corte (timeout) DENTRO de cada tentativa, de propósito: o laço de
 * refresh do auth-js trata qualquer falha de fetch, inclusive abort, como
 * retentável e segue repetindo até 30 s — o corte não encurtaria a espera. E
 * abandonar um refresh em voo é pior que esperar: se o GoTrue girar o refresh
 * token e a resposta não chegar ao navegador, o token velho volta na próxima
 * requisição e a detecção de reuso do GoTrue derruba a sessão — o logout que
 * este módulo existe para evitar.
 *
 * Devolve também o CLIENTE da última tentativa: quem segue usando o Supabase
 * depois (consultas com a sessão do usuário) usa o mesmo cliente que validou.
 */
export async function getUserResiliente<U, C extends ClienteComAuth<U>>(
  criarCliente: () => C | Promise<C>,
  opcoes: OpcoesDoGetUserResiliente = {},
): Promise<{ cliente: C; resultado: ResultadoDoGetUser<U> }> {
  const esperas = opcoes.esperasMs ?? ESPERAS_PADRAO_MS;
  const esperar = opcoes.esperar ?? esperarDeVerdade;
  const agora = opcoes.agora ?? Date.now;
  const limiteDaTentativa = opcoes.limiteDaTentativaMs ?? LIMITE_DA_TENTATIVA_MS;
  const orcamento = opcoes.orcamentoTotalMs ?? ORCAMENTO_TOTAL_MS;
  const inicio = agora();

  let tentativa = 0;
  for (;;) {
    const cliente = await criarCliente();
    const inicioDaTentativa = agora();
    let user: U | null = null;
    let erro: ErroDeAuth | null = null;
    try {
      const resposta = await cliente.auth.getUser();
      user = resposta.data.user;
      erro = resposta.error;
    } catch (e) {
      erro = erroDaExcecao(e);
    }

    if (user) return { cliente, resultado: { estado: "autenticado", user, erro: null } };

    if (!erro || !ehFalhaTransitoria(erro)) {
      return { cliente, resultado: { estado: "deslogado", user: null, erro } };
    }

    const indisponivel = {
      cliente,
      resultado: { estado: "indisponivel" as const, user: null, erro },
    };
    const espera = esperas[tentativa];
    if (espera === undefined) return indisponivel;
    const fim = agora();
    // Tentativa lenta: a biblioteca já repetiu por dentro. Não empilhar outra.
    if (fim - inicioDaTentativa > limiteDaTentativa) return indisponivel;
    // A próxima espera tem de caber no orçamento da navegação.
    if (fim - inicio + espera > orcamento) return indisponivel;
    tentativa += 1;
    await esperar(espera);
  }
}
