import { describe, expect, it } from "vitest";

import {
  ABAS_DE_AUTOMACOES,
  ABA_PADRAO_DE_AUTOMACOES,
  abaInicialDeAutomacoes,
} from "@/app/app/webhooks/_components/abas";
import { traduzir } from "@/lib/i18n/dicionario";
import { NAV_DESTINATIONS, hubSections, searchable } from "@/lib/navigation/registry";

/**
 * "Webhooks" virou "Automações e Webhooks": ninguém achava as automações numa tela
 * com esse nome. A rota `/app/webhooks` NÃO mudou (links e testes externos dependem
 * dela); mudaram o rótulo, a ordem das abas e a aba que abre primeiro.
 */

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

describe("Automações e Webhooks — porta na navegação", () => {
  const porta = NAV_DESTINATIONS.find((d) => d.href === "/app/webhooks");

  it("mantém a rota e troca o rótulo", () => {
    expect(porta?.label).toBe("Automações e Webhooks");
  });

  it("aparece no hub de Configurações, em Canais, com o nome novo", () => {
    const canais = hubSections("organizacao", false, "admin").find((s) => s.section === "Canais");
    const rotulos = canais?.items.map((i) => i.label) ?? [];
    expect(rotulos).toContain("Automações e Webhooks");
    expect(rotulos).not.toContain("Webhooks");
  });

  it.each(["automação", "automações", "webhook", "log", "registro"])(
    "o ⌘K acha a tela por %s",
    (termo) => {
      // Mesmo texto que o filtro do CommandPalette compara.
      const achou = searchable(false, "manager").some(
        (d) =>
          d.href === "/app/webhooks" &&
          normalizar(`${d.label} ${d.description} ${(d.termos ?? []).join(" ")}`).includes(
            normalizar(termo),
          ),
      );
      expect(achou).toBe(true);
    },
  );
});

describe("Automações e Webhooks — abas", () => {
  it("a ordem é Automações, Receber dados, Leads recebidos, Registro de atividade", () => {
    // Os valores são os de sempre; só a ordem mudou.
    expect([...ABAS_DE_AUTOMACOES]).toEqual(["rules", "sources", "capturas", "activity"]);
  });

  it("abre em Automações por padrão", () => {
    expect(ABA_PADRAO_DE_AUTOMACOES).toBe("rules");
    expect(abaInicialDeAutomacoes(undefined)).toBe("rules");
    expect(abaInicialDeAutomacoes("")).toBe("rules");
  });

  it("?tab= com os valores de sempre abre a aba certa", () => {
    expect(abaInicialDeAutomacoes("sources")).toBe("sources");
    expect(abaInicialDeAutomacoes("capturas")).toBe("capturas");
    expect(abaInicialDeAutomacoes("rules")).toBe("rules");
    expect(abaInicialDeAutomacoes("activity")).toBe("activity");
  });

  it("valor desconhecido cai na aba padrão em vez de uma tela vazia", () => {
    expect(abaInicialDeAutomacoes("qualquer-coisa")).toBe("rules");
  });
});

describe("Automações e Webhooks — espanhol", () => {
  it.each([
    ["Automações e Webhooks", "Automatizaciones y Webhooks"],
    ["Registro de atividade", "Registro de actividad"],
    [
      "Regras que agem sozinhas, entrada de leads de sites e formulários, e o registro do que chegou e do que rodou.",
      "Reglas que actúan solas, entrada de leads desde sitios y formularios, y el registro de lo que llegó y de lo que se ejecutó.",
    ],
  ])("traduz %s", (pt, es) => {
    expect(traduzir(pt, "es")).toBe(es);
  });
});
