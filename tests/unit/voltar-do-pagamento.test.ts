/**
 * A volta do cartão (Asaas `callback.successUrl`): o cookie de sessão é `SameSite=Strict` e não viaja na
 * navegação vinda do Asaas. A rota pública devolve a ponte de volta (`respostaDePonte`): um documento do nosso
 * origin cujo script `window.location.replace` leva ao destino já com o cookie. Mede a rota, a lista fixa de
 * destinos, o hash do CSP e a entrada exata em PUBLIC_PATHS.
 *
 * Comando: npx vitest run tests/unit/voltar-do-pagamento.test.ts
 */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

// A marca vem do banco; aqui é fixa (sem o mock cada caso esperaria a leitura que não responde).
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: vi.fn(async () => ({ nome: "Marca <b>& Cia</b>" })),
}));


import { GET } from "@/app/voltar-do-pagamento/route";
import { isPublicPath } from "@/lib/auth/public-paths";
import { urlDeRetornoDoCartao } from "@/lib/billing/asaas/retorno-do-cartao";

async function volta(query: string) {
  const response = await GET(new Request(`http://localhost/voltar-do-pagamento${query}`));
  return { response, html: await response.text() };
}

describe("PUBLIC_PATHS", () => {
  it("libera só o caminho exato; sub-path e a tela autenticada seguem protegidos", () => {
    expect(isPublicPath("/voltar-do-pagamento")).toBe(true);
    expect(isPublicPath("/voltar-do-pagamento/x")).toBe(false);
    expect(isPublicPath("/voltar-do-pagamento/")).toBe(false);
    expect(isPublicPath("/onboarding/plano")).toBe(false);
    expect(isPublicPath("/app/settings/plano")).toBe(false);
  });

  it("o successUrl montado cai no caminho público", () => {
    const url = new URL(urlDeRetornoDoCartao("https://crm.hiperbold.com.br", true)!);
    expect(isPublicPath(url.pathname)).toBe(true);
  });
});

describe("GET /voltar-do-pagamento", () => {
  it.each([
    ["?para=onboarding", "/onboarding/plano"],
    ["?para=plano", "/app/settings/plano"],
    ["", "/onboarding/plano"],
    ["?para=https://evil.example", "/onboarding/plano"],
    ["?para=//evil.example", "/onboarding/plano"],
    ["?para=/app/admin", "/onboarding/plano"],
    ["?para=%3C/script%3E%3Cscript%3Ealert(1)%3C/script%3E", "/onboarding/plano"],
  ])("%j leva a %s pela ponte (script + hash do CSP), sem 3xx e sem refletir a query", async (query, esperado) => {
    const { response, html } = await volta(query);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    const scripts = [...html.matchAll(/<script>(.*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toBe(`window.location.replace(${JSON.stringify(esperado)});`);
    expect(response.headers.get("content-security-policy")).toContain(
      `script-src 'sha256-${createHash("sha256").update(scripts[0]!).digest("base64")}'`,
    );

    expect(html).toContain(`<a href="${esperado}">`);
    expect(html).toContain("Pagamento recebido, voltando para o CRM…");
    // Sem meta refresh: o mecanismo é o script da ponte.
    expect(html).not.toContain("http-equiv");
    // Nada da query chega ao documento, e nenhum domínio externo.
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("/app/admin");
    expect(html).not.toMatch(/https?:\/\//);
    // Os únicos destinos que a página sabe emitir.
    const alvos = [...html.matchAll(/href="(\/[^">]*)"/g)].map((m) => m[1]);
    expect(alvos.every((a) => a === esperado)).toBe(true);
  });

  it("o nome da marca entra escapado", async () => {
    const { html } = await volta("");
    expect(html).toContain("Marca &lt;b&gt;&amp; Cia&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });
});
