/**
 * Funções ocultas da Hiperbold (16/10/2026, hiperbold/FUNCOES.md): o registro único decide o que o
 * cliente vê, e é ele que alimenta menu, hubs, ⌘K e o redirecionamento do endereço.
 */
import { describe, expect, it } from "vitest";

import {
  DESTINO_DAS_FUNCOES_OCULTAS,
  FUNCOES,
  FUNCOES_OCULTAS,
  funcaoOculta,
  hrefOculto,
  redirecionamentosDasFuncoesOcultas,
} from "@/lib/hiperbold/funcoes-ocultas";
import { NAV_CATALOG } from "@/lib/navigation/catalogo";
import { hubSections, searchable, sidebarGroups } from "@/lib/navigation/registry";

const hrefsDe = (itens: Array<{ href: string }>) => itens.map((i) => i.href);

describe("registro de funções ocultas", () => {
  it("todo id oculto existe no catálogo de funções", () => {
    for (const id of FUNCOES_OCULTAS) expect(FUNCOES[id], id).toBeDefined();
    expect(new Set(FUNCOES_OCULTAS).size).toBe(FUNCOES_OCULTAS.length);
  });

  it("funcaoOculta responde pela lista", () => {
    expect(funcaoOculta("prospeccao")).toBe(true);
    expect(funcaoOculta("voz-whatsapp")).toBe(true);
    expect(funcaoOculta("conexao-telefone")).toBe(true);
    // O Jev voltou a aparecer em 16/10/2026 (chave da instalação).
    expect(funcaoOculta("jev")).toBe(false);
  });

  it("hrefOculto: caminho exato, filhos, consulta e âncora; nunca irmão de nome parecido", () => {
    expect(hrefOculto("/app/prospecting")).toBe(true);
    expect(hrefOculto("/app/extensions/abc?card=1")).toBe(true);
    expect(hrefOculto("/app/settings/tenant/financeiro#x")).toBe(true);
    expect(hrefOculto("/app/ai/providers/")).toBe(true);
    expect(hrefOculto("/app/ai/providers-x")).toBe(false);
    expect(hrefOculto("/app/settings/tenant")).toBe(false);
  });

  it("telas visíveis não são tocadas", () => {
    for (const href of [
      "/app/inicio",
      "/app/inbox",
      "/app/kanban",
      "/app/connections",
      "/app/webhooks",
      "/app/team",
      "/app/settings/plano",
      "/app/settings/security",
      "/app/settings/tenant/agenda",
      "/app/settings/tags",
      "/app/ai/agents",
      "/app/ai/credentials", // avançado, ativo (decisão de 16/10/2026)
      "/app/ai/cases/avisos",
    ]) {
      expect(hrefOculto(href), href).toBe(false);
    }
  });

  it("o redirecionamento do endereço cobre toda rota oculta e manda para o Início", () => {
    const regras = redirecionamentosDasFuncoesOcultas();
    const origens = regras.map((r) => r.source);
    expect(origens).toContain("/app/prospecting/:path*");
    expect(origens).toContain("/app/ads/meta/:path*");
    expect(origens).toContain("/app/settings/voip-trunk/:path*");
    expect(origens).not.toContain("/app/ai/credentials/:path*");
    for (const r of regras) {
      expect(r.destination).toBe(DESTINO_DAS_FUNCOES_OCULTAS);
      expect(r.destination).toBe("/app/inicio");
      expect(r.permanent).toBe(false);
    }
  });
});

describe("menu, hubs e ⌘K seguem o registro", () => {
  const todosOsOcultos = NAV_CATALOG.map((d) => d.href).filter(hrefOculto);

  it("o catálogo tem as telas que a decisão manda esconder", () => {
    expect(todosOsOcultos).toEqual(
      expect.arrayContaining([
        "/app/prospecting",
        "/app/calls",
        "/app/comandas",
        "/app/ads/meta",
        "/app/settings/voip-trunk",
        "/app/settings/conversoes",
        "/app/settings/meta-ads",
        "/app/extensions",
        "/app/settings/tenant/financeiro",
        "/app/ai/providers",
      ]),
    );
  });

  it("nenhuma tela oculta aparece no sidebar, em hub nenhum nem no ⌘K", () => {
    const grupos = ["atendimento", "crm", "ia", "canais", "analise", "organizacao"] as const;
    const visiveis = new Set<string>([
      ...sidebarGroups(true, "admin").flatMap((g) => hrefsDe(g.items)),
      ...grupos.flatMap((g) => hubSections(g, true, "admin").flatMap((s) => hrefsDe(s.items))),
      ...hrefsDe(searchable(true, "admin")),
    ]);
    for (const href of todosOsOcultos) expect(visiveis.has(href), href).toBe(false);
    expect(visiveis.has("/app/ai/agents")).toBe(true);
  });

  it("Credenciais sai do hub de IA e fica em Configurações, seção IA, com o texto novo", () => {
    const ia = hubSections("ia", true, "admin").flatMap((s) => hrefsDe(s.items));
    expect(ia).not.toContain("/app/ai/credentials");
    const ajustes = hubSections("organizacao", true, "admin");
    const secaoIa = ajustes.find((s) => s.section === "IA");
    const item = secaoIa?.items.find((i) => i.href === "/app/ai/credentials");
    expect(item?.label).toBe("Usar minha própria chave de IA (avançado)");
    expect(item?.minRole).toBe("manager");
  });
});

describe("next.config", () => {
  it("publica o redirecionamento das telas ocultas", async () => {
    const cfg = (await import("../../next.config")).default as unknown as {
      redirects?: () => Promise<Array<{ source: string; destination: string }>>;
    };
    const regras = (await cfg.redirects?.()) ?? [];
    expect(regras).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "/app/calls/:path*", destination: "/app/inicio" }),
      ]),
    );
  });
});
