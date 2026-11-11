// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/v1/client-errors — o erro do navegador vira linha no log, e só isso.
 *
 * O handler é o de verdade, com o contrato (Zod e limpeza) de verdade e o rate
 * limit de verdade (contador em memória, porque o teste não tem Upstash) e o
 * cache curto de verdade. Fica de fora só o destino do log.
 */

const logs: { msg: string; ctx?: Record<string, unknown> }[] = [];

vi.mock("@/lib/logger", () => ({
  logger: {
    error: (msg: string, ctx?: Record<string, unknown>) => void logs.push({ msg, ctx }),
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
}));
vi.mock("@/lib/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://crm.exemplo.com.br" },
}));

const { POST } = await import("@/app/api/v1/client-errors/route");
const { isPublicPath } = await import("@/lib/auth/public-paths");
const { NextRequest } = await import("next/server");
const { comCacheCurto, esquecerTudo, sessaoDosCookies } = await import("@/lib/auth/cache-curto");

function cookieDeSessao(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `base64-${b64({ access_token: `${b64({ alg: "HS256" })}.${b64({ sub: "u-1", exp })}.x` })}`;
}

let ipSeq = 0;
function pedir(
  corpo: unknown,
  {
    origin = "https://crm.exemplo.com.br",
    ip,
    cookie,
  }: { origin?: string | null; ip?: string; cookie?: string } = {},
) {
  const headers: Record<string, string> = {
    host: "crm.exemplo.com.br",
    "content-type": "application/json",
    "x-forwarded-for": ip ?? `10.0.0.${++ipSeq}`,
    "x-request-id": "00000000-0000-4000-8000-000000000001",
  };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  return POST(
    new NextRequest("https://crm.exemplo.com.br/api/v1/client-errors", {
      method: "POST",
      headers,
      body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
    }),
  );
}

const BASICO = { name: "TypeError", message: "x is undefined", route: "/app/inbox" };

beforeEach(() => {
  logs.length = 0;
  esquecerTudo();
});

describe("POST /api/v1/client-errors", () => {
  it("é pública no proxy, ancorada", () => {
    expect(isPublicPath("/api/v1/client-errors")).toBe(true);
    expect(isPublicPath("/api/v1/client-errors/outra")).toBe(false);
  });

  it("aceita, responde 204 e grava [client-error] com o X-Request-Id", async () => {
    const r = await pedir(BASICO);
    expect(r.status).toBe(204);
    expect(r.headers.get("x-request-id")).toBe("00000000-0000-4000-8000-000000000001");
    const linha = logs.find((l) => l.msg === "[client-error]");
    expect(linha?.ctx).toMatchObject({
      request_id: "00000000-0000-4000-8000-000000000001",
      name: "TypeError",
      message: "x is undefined",
      route: "/app/inbox",
      user_id: null,
      org_id: null,
    });
  });

  it("apaga e-mail, telefone e sequência de 6+ dígitos da mensagem", async () => {
    await pedir({
      ...BASICO,
      message: "falhou para joao.silva@cliente.com.br, tel +55 (35) 99148-5627, CPF 12345678901 pedido 123456",
    });
    const msg = String(logs.find((l) => l.msg === "[client-error]")?.ctx?.message);
    expect(msg).not.toMatch(/joao|cliente\.com|99148|5627|12345678901|123456/);
    expect(msg).toContain("[email]");
    expect(msg).toContain("[telefone]");
  });

  it("rota vira só o caminho, com UUID e números como :id; pilha em 8 linhas, sem query", async () => {
    const pilha = Array.from({ length: 12 }, (_, i) => `at f${i} (https://crm.exemplo.com.br/_next/a.js?token=segredo:1:${i})`).join("\n");
    await pedir({
      ...BASICO,
      route: "https://crm.exemplo.com.br/app/leads/0b0e7b8e-1f4a-4c1e-9a7e-1b2c3d4e5f60/notas/42?q=joao#x",
      stack: pilha,
    });
    const ctx = logs.find((l) => l.msg === "[client-error]")?.ctx;
    expect(ctx?.route).toBe("/app/leads/:id/notas/:id");
    const linhas = String(ctx?.stack).split("\n");
    expect(linhas).toHaveLength(8);
    expect(String(ctx?.stack)).not.toContain("segredo");
  });

  it("anota usuário e organização a partir do cache da sessão, sem ir ao GoTrue nem gravar cookie", async () => {
    const valor = cookieDeSessao();
    const sessao = sessaoDosCookies([{ name: "sb-deskcomm-auth", value: valor }])!;
    await comCacheCurto({
      chave: `sessao:${sessao.chave}`,
      carregar: async () => ({ estado: "autenticado", user: { id: "u-1" }, erro: null }),
    });
    await comCacheCurto({
      chave: "permissoes:u-1",
      carregar: async () => ({ paRow: null, memberships: [{ organization_id: "o-1" }] }),
    });
    const r = await pedir(BASICO, { cookie: `sb-deskcomm-auth=${valor}` });
    expect(r.status).toBe(204);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(logs.find((l) => l.msg === "[client-error]")?.ctx).toMatchObject({ user_id: "u-1", org_id: "o-1" });
  });

  it("sessão que não está no cache fica sem anotação (e nada de cookie apagado)", async () => {
    const r = await pedir(BASICO, { cookie: `sb-deskcomm-auth=${cookieDeSessao()}` });
    expect(r.status).toBe(204);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(logs.find((l) => l.msg === "[client-error]")?.ctx).toMatchObject({ user_id: null, org_id: null });
  });

  it("mascara JWT e chave `dsk_` na mensagem e na pilha; limpa o nome; segmento opaco da rota vira :token", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJh";
    await pedir({
      name: "Erro de joao@x.com.br",
      message: `falhou com ${jwt} e dsk_AbCdEf0123456789`,
      route: "/team/accept-invite/Zx9_abcdefghIJKLmnop-q",
      stack: `Error: ${jwt}\n    at f (dsk_segredoDaChave)`,
    });
    const ctx = logs.find((l) => l.msg === "[client-error]")?.ctx;
    const tudo = JSON.stringify(ctx);
    expect(tudo).not.toContain("eyJ");
    expect(tudo).not.toContain("dsk_");
    expect(tudo).not.toContain("joao@");
    expect(ctx?.route).toBe("/team/accept-invite/:token");
    expect(String(ctx?.message)).toContain("[jwt]");
    expect(String(ctx?.message)).toContain("[chave]");
  });

  it("corpo grande é recusado pelo stream, mesmo sem Content-Length", async () => {
    const grande = new TextEncoder().encode(JSON.stringify({ ...BASICO, stack: "a".repeat(5000) }));
    const corpo = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < grande.length; i += 1000) c.enqueue(grande.slice(i, i + 1000));
        c.close();
      },
    });
    const r = await POST(
      new NextRequest("https://crm.exemplo.com.br/api/v1/client-errors", {
        method: "POST",
        headers: { host: "crm.exemplo.com.br", origin: "https://crm.exemplo.com.br", "x-forwarded-for": "10.9.9.9" },
        body: corpo,
        duplex: "half",
      } as never),
    );
    expect(r.status).toBe(413);
    expect(logs).toEqual([]);
  });

  it("recusa outra Origin e a ausência de Origin, sem gravar", async () => {
    expect((await pedir(BASICO, { origin: "https://atacante.example" })).status).toBe(403);
    expect((await pedir(BASICO, { origin: null })).status).toBe(403);
    expect(logs).toEqual([]);
  });

  it("recusa corpo acima de 4 KB", async () => {
    const r = await pedir({ ...BASICO, stack: "a".repeat(5000) });
    expect(r.status).toBe(413);
    expect(logs).toEqual([]);
  });

  it("recusa campo inválido e JSON quebrado", async () => {
    expect((await pedir({ ...BASICO, name: "" })).status).toBe(400);
    expect((await pedir({ ...BASICO, message: "m".repeat(301) })).status).toBe(400);
    expect((await pedir({ ...BASICO, digest: "não vale espaço" })).status).toBe(400);
    expect((await pedir({ ...BASICO, ua_family: "netscape" })).status).toBe(400);
    expect((await pedir("{nao é json")).status).toBe(400);
    expect(logs).toEqual([]);
  });

  it("limita por IP: a 11ª do mesmo IP no minuto leva 429", async () => {
    const ip = "192.0.2.77";
    for (let i = 0; i < 10; i++) expect((await pedir(BASICO, { ip })).status).toBe(204);
    const r = await pedir(BASICO, { ip });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
  });

  // Por último: esgota o teto global da janela.
  it("teto global de 60 por minuto, somando IPs diferentes", async () => {
    let recusou = false;
    for (let i = 0; i < 61 && !recusou; i++) {
      const r = await pedir(BASICO, { ip: `198.51.100.${i}` });
      if (r.status === 429) recusou = true;
    }
    expect(recusou).toBe(true);
  });
});
