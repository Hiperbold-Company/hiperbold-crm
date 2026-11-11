import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { fetchDoServidor } from "@/lib/supabase/fetch-do-servidor";
import { urlDoSupabaseNoServidor } from "@/lib/supabase/url-do-servidor";
import { isPublicPath } from "@/lib/auth/public-paths";
import {
  getUserResiliente,
  type ErroDeAuth,
  type ResultadoDoGetUser,
} from "@/lib/auth/get-user-resiliente";
import {
  comCacheCurto,
  ehCookieDeSessao,
  etiquetaDeSessao,
  etiquetaDeUsuario,
  sessaoDosCookies,
} from "@/lib/auth/cache-curto";
import { logger } from "@/lib/logger";
import type { User } from "@supabase/supabase-js";
import { CABECALHO_SEM_CSS, PARAMETRO_SEM_CSS } from "@/lib/branding/sem-css-personalizado";
import {
  verifyImpersonateCookieEdge,
  IMPERSONATE_COOKIE_NAME_EDGE,
} from "@/lib/impersonate/cookie-edge";

const COOKIE_NAME = "sb-deskcomm-auth";

/**
 * Antes do `exp`, o tempo em que o proxy NÃO usa o cache e sempre chama o
 * `getUser`. Somado à margem de 5 s do cache curto dá os 90 s em que o auth-js
 * renova o token (`EXPIRY_MARGIN_MS`).
 */
const FOLGA_DA_RENOVACAO_MS = 85_000;
/** Quanto tempo um token recusado de forma definitiva deixa de ir ao GoTrue. */
const TTL_DA_RECUSA_MS = 5_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O servidor de autenticação não respondeu, nem depois das novas tentativas.
 *
 * NÃO é "deslogado": a sessão provavelmente segue válida (é o caso de toda
 * publicação, durante a troca de contêiner). Por isso nada de `/login` e nada
 * de apagar cookie — os cookies que um refresh bem-sucedido já gravou em
 * `response` são copiados, senão o navegador ficaria com o refresh token velho.
 *
 * API recebe 503 no envelope de erro; tela recebe a página `/503` (pública,
 * traduzida) por REWRITE, para a URL continuar a mesma e recarregar bastar.
 *
 * ⚠️ O `status: 503` do rewrite NÃO chega ao navegador: no Next a página
 * reescrita responde com o próprio status (200). Chegam o conteúdo de
 * manutenção, o `Cache-Control: no-store` e o `Retry-After`; o status, não.
 * Aceito de propósito — o que importa é não mandar ao login nem apagar cookie.
 */
function respostaDeAuthIndisponivel(
  request: NextRequest,
  response: NextResponse,
  pathname: string,
  requestId: string,
): NextResponse {
  const saida = pathname.startsWith("/api/")
    ? new NextResponse(
        JSON.stringify({
          error: {
            code: "unavailable",
            message: "Authentication service temporarily unavailable — retry shortly",
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      )
    : NextResponse.rewrite(new URL("/503", request.url), {
        status: 503,
        request: { headers: request.headers },
      });
  response.cookies.getAll().forEach((c) => saida.cookies.set(c));
  saida.headers.set("x-request-id", requestId);
  saida.headers.set("Retry-After", "5");
  saida.headers.set("Cache-Control", "no-store");
  return saida;
}

export async function proxy(request: NextRequest) {
  // Saída de emergência do CSS personalizado. ANTES do `NextResponse.next`: ele
  // copia os cabeçalhos da requisição no momento em que é criado, e o que for
  // posto depois não chega aos Server Components. Sempre gravado, para um
  // cabeçalho forjado pelo cliente não valer.
  request.headers.set(
    CABECALHO_SEM_CSS,
    request.nextUrl.searchParams.has(PARAMETRO_SEM_CSS) ? "1" : "0",
  );
  // O caminho atual, para os Server Components (o `next` do desafio de MFA em
  // `exigirProvaDeMfa`). Mesma regra: antes do `next`, e sempre gravado.
  request.headers.set("x-pathname", request.nextUrl.pathname);
  // Inject X-Request-Id for downstream correlation (audit log, error wrappers). O que o
  // cliente manda só vale em formato UUID: o valor é gravado no audit de ~25 rotas e vai
  // para o CSV da auditoria, e um texto livre ali era injeção de fórmula na planilha (D-107).
  // O id sanitizado entra nos cabeçalhos da REQUISIÇÃO antes de o `next()` copiá-los: o que
  // as rotas leem com `headers().get("x-request-id")` é este, nunca o do cliente.
  const recebido = request.headers.get("x-request-id");
  const requestId = recebido && UUID_RE.test(recebido) ? recebido : crypto.randomUUID();
  request.headers.set("x-request-id", requestId);
  const response = NextResponse.next({ request: { headers: request.headers } });
  response.headers.set("x-request-id", requestId);

  const { pathname, search } = request.nextUrl;
  // Recupera retornos de OAuth social já emitidos antes da landing pública existir.
  // Apenas a navegação é tratada: o vínculo de conta segue protegido pelos guards canônicos.
  // Passa adiante só o SINAL `connected=1` — nunca o `connect_token` nem o valor recebido.
  if (
    request.method === "GET" &&
    pathname === "/app/connections" &&
    request.nextUrl.searchParams.has("connected") &&
    request.nextUrl.searchParams.has("connect_token")
  ) {
    const landing = NextResponse.redirect(new URL("/auth/social-return?connected=1", request.url));
    landing.headers.set("Cache-Control", "no-store");
    landing.headers.set("Referrer-Policy", "no-referrer");
    return landing;
  }
  // EPIC-11: the admin surface is reached by PATH (`/admin/*`) — the self-host kit
  // points `NEXT_PUBLIC_ADMIN_URL` at the same host as the app and maps no `admin.`
  // sub-domain. The host-based branch below stays a NOOP today and only exists as
  // documentation of the intended deploy topology.
  const host = request.headers.get("host") ?? "";
  const isAdminSurface = host.startsWith("admin.") || pathname.startsWith("/admin");

  if (isPublicPath(pathname)) {
    return response;
  }

  // Um cliente NOVO por tentativa (ver `lib/auth/get-user-resiliente.ts`): o
  // GoTrueClient guarda a falha de refresh em cache, e a mesma instância
  // devolveria a falha sem ir à rede. O adaptador de cookies é o mesmo — um
  // refresh que deu certo numa tentativa chega à seguinte pelo `request.cookies`.
  //
  // ─── 429 no refresh não pode apagar a sessão (11/11/2026) ────────────────
  // Com o token vencido, o `getUser` passa pelo refresh em `/token`. Se o GoTrue
  // responde 429, o auth-js trata como erro definitivo e chama `_removeSession`:
  // o `setAll` recebe `sb-deskcomm-auth=""` com maxAge 0. Aplicado na hora, a
  // nova tentativa já lia o cookie vazio e saía "deslogado", e o 503 levava a
  // exclusão ao navegador — o logout que este módulo existe para evitar.
  //
  // Por isso cada tentativa SEGURA as escritas de cookie até terminar
  // (`aoTerminarTentativa`). Terminou em falha transitória (429, rede, 5xx) e a
  // tentativa só APAGOU o cookie de sessão: a exclusão é descartada e o
  // `request.cookies` volta ao que era antes da tentativa. Se houve escrita com
  // valor (refresh que girou o token antes de outra falha), tudo vale: o token
  // novo precisa chegar ao navegador, senão o velho volta e o GoTrue derruba a
  // sessão por reuso. Fora do `getUser` (a RPC de `/admin`), a escrita é direta.
  type Escrita = { name: string; value: string; options: CookieOptions };
  type Tentativa = { antes: { name: string; value: string }[]; escritas: Escrita[]; fechada: boolean };
  const aplicar = (e: Escrita) => {
    request.cookies.set(e.name, e.value);
    response.cookies.set(e.name, e.value, e.options);
  };
  const abrirTentativa = (): Tentativa => ({
    antes: request.cookies.getAll().filter((c) => ehCookieDeSessao(c.name)),
    escritas: [],
    fechada: false,
  });
  const tentativas: Tentativa[] = [];
  const criarCliente = (tentativa: Tentativa) =>
    createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      // #1082: base na URL pública, endereço interno só no transporte (ver
      // `lib/supabase/fetch-do-servidor.ts`). O middleware não gera link, mas
      // segue a mesma regra dos outros dois clients — um desenho só.
      global: {
        fetch: fetchDoServidor(
          urlDoSupabaseNoServidor(env.SUPABASE_SERVER_URL, env.NEXT_PUBLIC_SUPABASE_URL),
          env.NEXT_PUBLIC_SUPABASE_URL,
        ),
      },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: Escrita[]) {
          cookiesToSet.forEach((e) => {
            if (tentativa.fechada) return aplicar(e);
            // O auth-js relê o cookie dentro da mesma tentativa: o pedido vê já.
            request.cookies.set(e.name, e.value);
            tentativa.escritas.push(e);
          });
        },
      },
      cookieOptions: {
        name: COOKIE_NAME,
        sameSite: "strict",
        httpOnly: true,
        secure: cookieSecure(),
        path: "/",
      },
    });
  type Cliente = ReturnType<typeof criarCliente>;
  const clienteDaTentativa = (): Cliente => {
    const t = abrirTentativa();
    tentativas.push(t);
    return criarCliente(t);
  };
  const terminarTentativa = ({ transitoria, erro }: { transitoria: boolean; erro: ErroDeAuth | null }) => {
    const t = tentativas.at(-1);
    if (!t || t.fechada) return;
    t.fechada = true;
    const daSessao = t.escritas.filter((e) => ehCookieDeSessao(e.name));
    const soApagou = daSessao.length > 0 && daSessao.every((e) => e.value === "");
    if (transitoria && soApagou) {
      for (const c of t.antes) request.cookies.set(c.name, c.value);
      t.escritas.filter((e) => !ehCookieDeSessao(e.name)).forEach(aplicar);
      logger.error("[proxy] refresh falhou de forma transitória — exclusão do cookie de sessão descartada", {
        name: erro?.name ?? null,
        code: erro?.code ?? null,
        status: erro?.status ?? null,
        path: pathname,
        request_id: requestId,
      });
      return;
    }
    t.escritas.forEach(aplicar);
  };

  // Validate JWT server-side (NEVER use getSession on backend per CLAUDE.md).
  // Falha TRANSITÓRIA (rede, 5xx, 429 — a troca de contêiner de toda
  // publicação, ou o GoTrue pedindo calma) tenta de novo; se persistir,
  // responde "indisponível" em vez de mandar ao login.
  //
  // CACHE CURTO ENTRE REQUISIÇÕES (11/11/2026). O proxy roda em TODA
  // requisição não pública — documento, prefetch de RSC, cada `/api/v1` — e
  // chamava `/auth/v1/user` em cada uma. Em produção isso produziu rajadas de
  // várias por segundo e o GoTrue respondeu 429 `over_request_rate_limit`. O
  // cache é o MESMO de `lib/auth/server.ts` (`sessaoDaRequisicao`), com a mesma
  // chave: um acerto aqui também poupa o `getUser` da renderização.
  //
  // As travas de segurança são as de lá, e não se afrouxam:
  //  - a chave é o HASH do cookie `sb-deskcomm-auth` (e dos pedaços `.N`):
  //    cookie diferente (token rotacionado, outra pessoa), chave diferente.
  //    Sem cookie legível, sem cache — caminho direto;
  //  - o teto é o `exp` do JWT MENOS 90 s (`FOLGA_DA_RENOVACAO_MS` mais a margem
  //    de 5 s do cache): é dentro dessa janela que o auth-js renova o token no
  //    `getUser`, e o proxy é quem leva o cookie renovado ao navegador. Cachear
  //    ali tiraria a renovação do proxy. Sem `exp` legível, NÃO se cacheia;
  //  - só o SUCESSO fica os 30 s. Token RECUSADO de forma definitiva fica 5 s
  //    (`TTL_DA_RECUSA_MS`), só para um cookie inválido não ir ao GoTrue a cada
  //    requisição; o login seguinte grava cookie novo, com chave nova, e não
  //    esbarra nisso. "Indisponível" nunca é guardado;
  //  - `invalidarSessao`/`invalidarUsuario` (sair, revogar, trocar senha)
  //    derrubam a entrada.
  // O cookie aqui é só CHAVE de cache; quem autoriza continua sendo o
  // `getUser()` validado no servidor, feito na primeira requisição da janela.
  const sessao = sessaoDosCookies(request.cookies.getAll());
  // Objeto, e não `let`: a atribuição acontece dentro do `carregar`.
  const validou: { cliente: Cliente | null } = { cliente: null };
  const lerUsuario = async (): Promise<ResultadoDoGetUser<User>> => {
    const r = await getUserResiliente<User, Cliente>(clienteDaTentativa, {
      aoTerminarTentativa: terminarTentativa,
    });
    validou.cliente = r.cliente;
    return r.resultado;
  };
  const resultado =
    sessao && sessao.expiraEm !== null
      ? await comCacheCurto<ResultadoDoGetUser<User>>({
          chave: `sessao-recusada:${sessao.chave}`,
          ttlMs: TTL_DA_RECUSA_MS,
          guardar: (r) => r.estado === "deslogado" && !!r.erro && r.erro.name !== "AuthSessionMissingError",
          carregar: () =>
            comCacheCurto<ResultadoDoGetUser<User>>({
              chave: `sessao:${sessao.chave}`,
              etiquetas: [etiquetaDeSessao(sessao.chave)],
              etiquetasDoValor: (r) => (r.user ? [etiquetaDeUsuario(r.user.id)] : []),
              ate: sessao.expiraEm! - FOLGA_DA_RENOVACAO_MS,
              guardar: (r) => r.estado === "autenticado",
              carregar: lerUsuario,
            }),
        })
      : await lerUsuario();
  const user = resultado.user;

  // Falha que NÃO é "sem sessão" fica no log (sem token nem cookie): com o
  // Sentry desligado, era o único rastro do 429 de 11/11/2026. Sessão ausente
  // é o visitante deslogado comum e não entra — mesmo critério de
  // `ehSessaoAusente` em `lib/auth/server.ts`, repetido aqui para o proxy não
  // carregar `next/headers` e o resto daquele módulo.
  if (resultado.erro && resultado.erro.name !== "AuthSessionMissingError") {
    logger.error("[proxy] getUser falhou", {
      estado: resultado.estado,
      name: resultado.erro.name ?? null,
      code: resultado.erro.code ?? null,
      status: resultado.erro.status ?? null,
      message: resultado.erro.message ?? null,
      path: pathname,
      request_id: requestId,
    });
  }

  if (resultado.estado === "indisponivel") {
    return respostaDeAuthIndisponivel(request, response, pathname, requestId);
  }

  if (!user) {
    // API routes must respond with JSON envelope (contract: {error:{code,message}})
    // — never redirect HTML to JSON consumers. UI routes redirect to /login as before.
    if (pathname.startsWith("/api/")) {
      return new NextResponse(
        JSON.stringify({
          error: {
            code: "unauthenticated",
            message: "Authentication required",
          },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
          },
        },
      );
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  // EPIC-11 S-11.07: validate impersonate cookie on /app/* paths. Middleware
  // runs in Edge — no DB access, only HMAC + expiry. On any failure we delete
  // the presentation cookie. The database support session remains authoritative:
  // expired/revoked support still blocks the app until explicit exit.
  if (pathname.startsWith("/app")) {
    const impCookie = request.cookies.get(IMPERSONATE_COOKIE_NAME_EDGE)?.value;
    if (impCookie) {
      const result = await verifyImpersonateCookieEdge(
        impCookie,
        env.IMPERSONATE_COOKIE_SECRET ?? "",
      );
      if (!result.valid) {
        console.warn(
          `[middleware] impersonate cookie invalid (${result.reason ?? "unknown"}) — clearing`,
        );
        response.cookies.delete(IMPERSONATE_COOKIE_NAME_EDGE);
      }
    }
  }

  // /admin/* additionally requires platform_admin (early gate — authoritative
  // check is server-side in `requirePlatformAdmin`). Skip the RPC for
  // `/admin/forbidden` (rendered to non-admins, would otherwise loop).
  if (isAdminSurface && pathname.startsWith("/admin") && pathname !== "/admin/forbidden") {
    // Acerto de cache não criou cliente: cria agora, com os mesmos cookies.
    const cliente = validou.cliente ?? criarCliente({ antes: [], escritas: [], fechada: true });
    const { data: isAdmin, error } = await cliente.rpc("fn_is_platform_admin");
    if (error || !isAdmin) {
      return NextResponse.redirect(new URL("/admin/forbidden", request.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    // Run on all paths except static assets / Next internals.
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)",
  ],
};
