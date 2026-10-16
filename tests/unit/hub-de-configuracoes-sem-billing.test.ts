/**
 * Hub de Configurações para leigo (feedback do dono, 15/10/2026): a tela antiga "Billing" (placeholder do
 * produto de origem) saiu da navegação mas o endereço segue vivo como redirect para "Meu plano"; "Financeiro"
 * virou "Contas e recebimentos" e mora em "Atendimento", logo depois de Comandas.
 *
 * Comando: npx vitest run tests/unit/hub-de-configuracoes-sem-billing.test.ts
 */
import { describe, expect, it } from "vitest";

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
    const hub = hubSections("organizacao", true, "admin").flatMap((s) => s.items.map((i) => i.href));
    expect(hub).not.toContain("/app/settings/billing");
  });
});

describe("nomes do hub", () => {
  const por = (href: string) => NAV_DESTINATIONS.find((d) => d.href === href)!;

  it("Meu plano", () => {
    expect(por("/app/settings/plano").label).toBe("Meu plano");
    expect(por("/app/settings/plano").description).toBe("Plano contratado, pagamento, uso e cancelamento.");
  });

  it("Contas e recebimentos fica em Atendimento, logo depois de Comandas, e não em Sua empresa", () => {
    const d = por("/app/settings/tenant/financeiro");
    expect(d.label).toBe("Contas e recebimentos");
    expect(d.minRole).toBe("viewer");
    const secoes = hubSections("organizacao", false, "admin");
    const atendimento = secoes.find((s) => s.section === "Atendimento")!.items.map((i) => i.href);
    const i = atendimento.indexOf("/app/comandas");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(atendimento[i + 1]).toBe("/app/settings/tenant/financeiro");
    const empresa = secoes.find((s) => s.section === "Sua empresa")!.items.map((x) => x.href);
    expect(empresa).not.toContain("/app/settings/tenant/financeiro");
  });
});
