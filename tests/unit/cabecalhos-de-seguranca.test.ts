/**
 * CSP SÓ EM OBSERVAÇÃO E HSTS SEM ARRASTAR SUBDOMÍNIO (D-124).
 *
 * Ligar a CSP "de verdade" de uma vez quebraria a aplicação (o Next injeta script em
 * linha). Por isso ela sai em Report-Only; este teste impede os dois erros opostos:
 * promovê-la sem querer (quebra a tela) e perdê-la (volta a não haver nada).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CABECALHOS_DE_SEGURANCA_EXTRAS,
  CSP_REPORT_ONLY,
  HSTS,
} from "@/lib/security/cabecalhos";

const nextConfig = readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");

describe("cabeçalhos de segurança", () => {
  it("a CSP vai como Report-Only, nunca como Content-Security-Policy", () => {
    const chaves = CABECALHOS_DE_SEGURANCA_EXTRAS.map((h) => h.key);
    expect(chaves).toContain("Content-Security-Policy-Report-Only");
    expect(chaves).not.toContain("Content-Security-Policy");
  });

  it("a política fecha as saídas clássicas do XSS", () => {
    for (const diretiva of [
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "default-src 'self'",
    ]) {
      expect(CSP_REPORT_ONLY).toContain(diretiva);
    }
  });

  it("a política deixa passar o que a aplicação usa hoje (senão o relatório vira ruído)", () => {
    expect(CSP_REPORT_ONLY).toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(CSP_REPORT_ONLY).toMatch(/connect-src[^;]*https:[^;]*wss:/);
    expect(CSP_REPORT_ONLY).toMatch(/img-src[^;]*blob:/);
    expect(CSP_REPORT_ONLY).toMatch(/media-src[^;]*blob:/);
  });

  it("o widget do Turnstile (challenges.cloudflare.com) cabe em script-src, connect-src e frame-src (D-173)", () => {
    for (const diretiva of ["script-src", "connect-src", "frame-src"]) {
      expect(CSP_REPORT_ONLY).toMatch(new RegExp(`${diretiva}[^;]*https://challenges\\.cloudflare\\.com`));
    }
    // O frame-src explícito não pode apagar o 'self' que o default-src já dava aos iframes.
    expect(CSP_REPORT_ONLY).toMatch(/frame-src 'self'/);
  });

  it("o JS SDK da Meta e a janela do Cadastro Incorporado cabem em script-src e frame-src (1014)", () => {
    expect(CSP_REPORT_ONLY).toMatch(/script-src[^;]*https:\/\/connect\.facebook\.net/);
    for (const origem of ["https://www.facebook.com", "https://web.facebook.com", "https://*.facebook.com"]) {
      expect(CSP_REPORT_ONLY).toMatch(new RegExp(`frame-src[^;]*${origem.replace(/[.*]/g, "\\$&")}`));
    }
    // Só onde precisa: o Facebook não ganha script fora do SDK nem moldura em outra diretiva.
    expect(CSP_REPORT_ONLY).not.toMatch(/script-src[^;]*\*\.facebook\.com/);
    expect(CSP_REPORT_ONLY).toMatch(/frame-ancestors 'none'/);
  });

  it("HSTS de 1 ano, sem includeSubDomains nem preload", () => {
    expect(HSTS).toBe("max-age=31536000");
    expect(HSTS).not.toMatch(/includeSubDomains|preload/i);
    expect(CABECALHOS_DE_SEGURANCA_EXTRAS.map((h) => h.key)).toContain("Strict-Transport-Security");
  });

  it("o next.config.ts aplica os cabeçalhos a todas as rotas", () => {
    expect(nextConfig).toContain("...CABECALHOS_DE_SEGURANCA_EXTRAS");
    const bloco = nextConfig.slice(nextConfig.indexOf('source: "/(.*)"'));
    expect(bloco.indexOf("...CABECALHOS_DE_SEGURANCA_EXTRAS")).toBeGreaterThan(-1);
  });
});
