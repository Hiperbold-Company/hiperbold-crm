import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { isPublicPath } from "@/lib/auth/public-paths";
import { getUserResiliente } from "@/lib/auth/get-user-resiliente";
import type { User } from "@supabase/supabase-js";
import {
  verifyImpersonateCookieEdge,
  IMPERSONATE_COOKIE_NAME_EDGE,
} from "@/lib/impersonate/cookie-edge";

const COOKIE_NAME = "sb-deskcomm-auth";

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
  // Expose pathname to Server Components via header (used by onboarding layout).
  response.headers.set("x-pathname", pathname);
  request.headers.set("x-pathname", pathname);

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
  const criarCliente = () =>
    createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
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

  // Validate JWT server-side (NEVER use getSession on backend per CLAUDE.md).
  // Falha TRANSITÓRIA (rede, 5xx — a troca de contêiner de toda publicação)
  // tenta de novo; se persistir, responde "indisponível" em vez de mandar ao
  // login. Antes, toda publicação deslogava quem estava com a sessão válida.
  const { cliente: supabase, resultado } = await getUserResiliente<
    User,
    ReturnType<typeof criarCliente>
  >(criarCliente);
  const user = resultado.user;

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
    const { data: isAdmin, error } = await supabase.rpc("fn_is_platform_admin");
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
