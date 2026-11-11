/**
 * POST /api/v1/client-errors — o erro do navegador vira linha no log do servidor.
 *
 * Por quê: com `SENTRY_DSN=off` (o padrão das instalações), o "Algo deu errado"
 * do `SegmentError` e do `global-error` morria no navegador. Em 11/11/2026 o
 * 429 do GoTrue derrubou telas e não deixou rastro. Contrato do corpo e limpeza
 * de dado pessoal em `lib/erros/erro-do-navegador.ts`.
 *
 * Pública no proxy (`lib/auth/public-paths.ts`) de propósito: o erro a relatar
 * pode ser justamente a sessão que não validou. A sessão, quando existe, só
 * ANOTA usuário e organização; não decide nada.
 *
 * Não é mutação de dado: nada é gravado no banco, só o log do processo. Por
 * isso não há audit log nem guarda de suporte (exceção declarada em
 * `tests/unit/suporte-cobertura-de-efeitos.test.ts`). O que segura abuso é a
 * Origin do próprio host, o teto do corpo e o limite por IP mais o global.
 */
import { createHash } from "node:crypto";
import { type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, noContent } from "@/lib/api/wrappers";
import { espiarCacheCurto, sessaoDosCookies } from "@/lib/auth/cache-curto";
import { env } from "@/lib/env";
import { ErroDoNavegadorSchema, TETO_DO_CORPO_BYTES } from "@/lib/erros/erro-do-navegador";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Relatos por IP por minuto. Uma tela quebrada manda 1; dez é folga de NAT. */
const LIMITE_POR_IP = 10;
/** Teto da instalação inteira por minuto: o log não pode virar alvo de enchente. */
const LIMITE_GLOBAL = 60;
const JANELA_SEG = 60;

function hostDe(valor: string | null | undefined): string | null {
  if (!valor) return null;
  try {
    return new URL(valor).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A Origin tem de ser o próprio host: o `Host` da requisição ou o da
 * `NEXT_PUBLIC_APP_URL` (proxy reverso na frente pode reescrever o `Host`).
 * Sem Origin, recusa — `sendBeacon` e `fetch` de POST mandam Origin.
 */
function origemDoProprioHost(req: NextRequest): boolean {
  const origem = hostDe(req.headers.get("origin"));
  if (!origem) return false;
  const host = req.headers.get("host")?.toLowerCase() ?? null;
  return origem === host || origem === hostDe(env.NEXT_PUBLIC_APP_URL);
}

const opaco = (valor: string) => createHash("sha256").update(valor).digest("hex").slice(0, 32);

/**
 * Usuário e organização, só para anotar — lidos do cache curto, SEM falar com
 * o GoTrue. Chamar `loadAuthUser` aqui podia renovar o token ou, num 429 do
 * refresh, deixar o auth-js APAGAR o cookie de sessão pela resposta desta rota:
 * um relato de erro não pode deslogar ninguém, nem somar chamadas a um GoTrue
 * que já está recusando. Sessão que não validou nos últimos segundos fica sem
 * anotação (`null`) — é "não sei", nunca decisão.
 */
function quemRelatou(req: NextRequest): { user_id: string | null; org_id: string | null } {
  const nada = { user_id: null, org_id: null };
  try {
    const sessao = sessaoDosCookies(req.cookies.getAll());
    if (!sessao) return nada;
    const validado = espiarCacheCurto<{ estado: string; user: { id: string } | null }>(`sessao:${sessao.chave}`);
    const userId = validado?.estado === "autenticado" ? (validado.user?.id ?? null) : null;
    if (!userId) return nada;
    const suporte = espiarCacheCurto<{ organization_id?: string } | null>(`suporte:${userId}:${sessao.chave}`);
    const vinculos =
      espiarCacheCurto<{ memberships: { organization_id: string }[] }>(`permissoes:${userId}`)?.memberships ?? [];
    const cookieOrg = req.cookies.get("active_org")?.value;
    const org =
      suporte?.organization_id ??
      vinculos.find((m) => m.organization_id === cookieOrg)?.organization_id ??
      (vinculos.length === 1 ? vinculos[0]!.organization_id : null);
    return { user_id: userId, org_id: org ?? null };
  } catch {
    return nada;
  }
}

/**
 * Lê o corpo pelo stream e para em `teto + 1` bytes, sem confiar no
 * `Content-Length` (que o cliente escreve, e que falta em corpo fatiado).
 * `"grande"` = passou do teto; `null` = não deu para ler.
 */
async function lerCorpoComTeto(req: NextRequest, teto: number): Promise<string | "grande" | null> {
  if (!req.body) return "";
  const leitor = req.body.getReader();
  const pedacos: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      if (total > teto) {
        await leitor.cancel().catch(() => {});
        return "grande";
      }
      pedacos.push(value);
    }
  } catch {
    return null;
  }
  const junto = new Uint8Array(total);
  let pos = 0;
  for (const p of pedacos) {
    junto.set(p, pos);
    pos += p.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(junto);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();

  if (!origemDoProprioHost(req)) {
    return fail("forbidden", "Origin not allowed", 403, { requestId });
  }

  const ip = ipDoCliente(req.headers);
  // Sem IP identificável não há origem a isolar (mesma regra de `lib/auth/rate-limit.ts`):
  // vale só o teto global.
  if (ip !== null) {
    const porIp = await checkRateLimit(`client-errors:ip:${opaco(ip)}`, LIMITE_POR_IP, JANELA_SEG);
    if (!porIp.allowed) {
      return fail("rate_limited", "Too many error reports", 429, {
        requestId,
        headers: { "Retry-After": String(JANELA_SEG) },
      });
    }
  }
  const global = await checkRateLimit("client-errors:global", LIMITE_GLOBAL, JANELA_SEG);
  if (!global.allowed) {
    return fail("rate_limited", "Too many error reports", 429, {
      requestId,
      headers: { "Retry-After": String(JANELA_SEG) },
    });
  }

  const lido = await lerCorpoComTeto(req, TETO_DO_CORPO_BYTES);
  if (lido === "grande") return fail("payload_too_large", "Body too large", 413, { requestId });
  if (lido === null) return fail("invalid_request", "Unreadable body", 400, { requestId });
  const texto = lido;

  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    return fail("invalid_request", "Invalid JSON", 400, { requestId });
  }
  const parsed = ErroDoNavegadorSchema.safeParse(json);
  if (!parsed.success) {
    return fail("validation_failed", "Invalid error report", 400, { requestId });
  }

  const autor = quemRelatou(req);
  logger.error("[client-error]", {
    request_id: requestId,
    ...autor,
    ...parsed.data,
  });
  return noContent(requestId);
}
