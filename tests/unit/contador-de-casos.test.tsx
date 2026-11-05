/**
 * O número ao lado de "Casos" no menu: quantos casos esperam uma PESSOA.
 *
 * Medido numa loja que vende pelo WhatsApp: a IA abriu um caso e ele só
 * existia atrás de "Ver tudo em IA" — ninguém viu. Caso esperando o CLIENTE
 * não conta: não pede nada de quem opera.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const casos: { status: string }[] = [];
vi.mock("@/hooks/ai/useCases", () => ({ useCases: () => ({ data: { cases: casos, open_count: casos.length } }) }));

import { ContadorDeCasos } from "@/components/shell/ContadorDeCasos";
import { NAV_DESTINATIONS, sidebarGroups } from "@/lib/navigation/registry";

describe("contador de casos no menu", () => {
  it("conta só os que esperam uma pessoa", () => {
    casos.splice(0, casos.length, { status: "awaiting_human" }, { status: "awaiting_lead" }, { status: "awaiting_human" });
    render(<ContadorDeCasos compacto={false} />);
    expect(screen.getByTestId("contador-de-casos").textContent).toBe("2");
  });

  it("sem pendência, não desenha nada — número zero treina a ignorar o número", () => {
    casos.splice(0, casos.length, { status: "awaiting_lead" });
    const { container } = render(<ContadorDeCasos compacto={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("Casos declara o contador e, na Hiperbold, fica fora do menu lateral", () => {
    // Hiperbold: sidebar só com o essencial (decisão do dono, 15/10/2026). A porta
    // de Casos é o hub do Agente de IA; o contador segue declarado no destino e
    // anda com o item (ver `sidebar-grupos.test.tsx`).
    expect(NAV_DESTINATIONS.find((d) => d.href === "/app/ai/cases")?.contador).toBe("casos");
    const ia = sidebarGroups(true, null).find((g) => g.group.id === "ia");
    expect(ia?.items.find((i) => i.href === "/app/ai/cases")).toBeUndefined();
  });
});
