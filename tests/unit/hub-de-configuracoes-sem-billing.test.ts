/**
 * Hub de Configurações para leigo (feedback do dono, 15/10/2026): a tela antiga "Billing" (placeholder do
 * produto de origem) saiu da navegação mas o endereço segue vivo como redirect para "Meu plano"; "Financeiro"
 * virou "Contas e recebimentos" e mora em "Atendimento", logo depois de Comandas.
 *
 * Comando: npx vitest run tests/unit/hub-de-configuracoes-sem-billing.test.ts
 */
import { describe, expect, it } from "vitest";

import AiUsagePage from "@/app/app/ai/usage/page";
import BillingPage from "@/app/app/settings/billing/page";
import { NAV_DESTINATIONS, hubSections, searchable } from "@/lib/navigation/registry";

describe("/app/settings/billing", () => {
  it("redireciona para /app/settings/plano e não é mais destino de navegação", () => {
    let destino = "";
    try {
      BillingPage();
    } catch (e) {
      destino = String((e as { digest?: string }).digest ?? "");
    }
    expect(destino).toContain("NEXT_REDIRECT");
    expect(destino).toContain("/app/settings/plano");

    expect(NAV_DESTINATIONS.map((d) => d.href)).not.toContain("/app/settings/billing");
    expect(searchable(true, "admin").map((d) => d.href)).not.toContain("/app/settings/billing");
    const hub = hubSections("organizacao", true, "admin").flatMap((s) =>
      s.items.map((i) => i.href),
    );
    expect(hub).not.toContain("/app/settings/billing");
  });
});

// 25/11/2026 (decisão do dono do produto): o consumo de IA mora num lugar só, em tokens, em
// Meu plano e consumo de IA. A tela "Uso e orçamento" (em dólar) saiu do menu, do hub e do ⌘K;
// o endereço segue vivo só para link salvo, aviso antigo e ajuda.
describe("/app/ai/usage", () => {
  it("redireciona para /app/settings/plano e não é mais destino de navegação", () => {
    let destino = "";
    try {
      AiUsagePage();
    } catch (e) {
      destino = String((e as { digest?: string }).digest ?? "");
    }
    expect(destino).toContain("NEXT_REDIRECT");
    expect(destino).toContain("/app/settings/plano");

    expect(NAV_DESTINATIONS.map((d) => d.href)).not.toContain("/app/ai/usage");
    expect(searchable(true, "admin").map((d) => d.href)).not.toContain("/app/ai/usage");
    const hub = hubSections("ia", true, "admin").flatMap((s) => s.items.map((i) => i.href));
    expect(hub).not.toContain("/app/ai/usage");
  });

  it("quem procura pelo nome antigo no ⌘K acha Meu plano e consumo de IA", () => {
    const plano = searchable(true, "manager").find((d) => d.href === "/app/settings/plano");
    expect(plano?.termos).toEqual(expect.arrayContaining(["uso e orçamento", "tokens"]));
  });
});

describe("nomes do hub", () => {
  const por = (href: string) => NAV_DESTINATIONS.find((d) => d.href === href)!;

  it("Meu plano e consumo de IA (25/11/2026: o consumo de IA mora aqui, em tokens)", () => {
    expect(por("/app/settings/plano").label).toBe("Meu plano e consumo de IA");
    expect(por("/app/settings/plano").description).toBe(
      "Plano contratado, pagamento, consumo de tokens de IA e cancelamento.",
    );
  });

  it("Contas e recebimentos continua no catálogo em Atendimento, mas está oculto nesta instalação (16/10/2026)", () => {
    const d = por("/app/settings/tenant/financeiro");
    expect(d.label).toBe("Contas e recebimentos");
    expect(d.minRole).toBe("viewer");
    expect(d.configuracoes).toBe("Atendimento");
    // Oculto (hiperbold/FUNCOES.md): nenhum hub, busca nem seção de Sua empresa o lista.
    const secoes = hubSections("organizacao", false, "admin");
    const todos = secoes.flatMap((s) => s.items.map((x) => x.href));
    expect(todos).not.toContain("/app/settings/tenant/financeiro");
    expect(searchable(false, "admin").map((x) => x.href)).not.toContain(
      "/app/settings/tenant/financeiro",
    );
  });
});
