/**
 * O plano do site (`/signup?plano=max`) chega marcado na tela de pagamento do onboarding. Só marca: quem
 * avança é o botão "Escolher", e plano que não está à venda não marca nada. Mede a TELA real
 * (`AssinarPlanoPassoAPasso`); a ação de servidor é o limite.
 * Comando: npx vitest run tests/unit/assinar-plano-inicial-tela.test.tsx
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/settings/compraDoPlano", () => ({ iniciarAssinatura: vi.fn(), simularCupom: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));

import { AssinarPlanoPassoAPasso } from "@/app/app/settings/plano/assinar/_passo-a-passo";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { PlanoParaVenda } from "@/lib/billing/asaas/leitura";

const plano = (
  code: string,
  name: string,
  preco: number,
  semestral: number | null = null,
  anual: number | null = null,
): PlanoParaVenda => ({
  code,
  name,
  version: 1,
  forSale: true,
  priceMonthlyCents: preco,
  priceSemiannualCents: semestral,
  priceYearlyCents: anual,
  conexoes: 3,
});
const PLANOS = [
  plano("pro", "Pro", 19900, 109900),
  plano("max", "Max", 39900, 219900, 399000),
  plano("escale", "Scale", 79900),
];

function tela(planoInicial: string | null | undefined, cicloInicial?: "monthly" | "semiannual" | "yearly" | null) {
  return render(
    <IdiomaProvider locale="pt-BR">
      <AssinarPlanoPassoAPasso
        planos={PLANOS}
        pixDisponivel
        opcoesDeParcelas={{}}
        taxaMensalPercentual={null}
        precisaPagador={false}
        planoAtualCode={null}
        planoInicial={planoInicial}
        cicloInicial={cicloInicial}
        depoisDePago={{ href: "/onboarding" }}
      />
    </IdiomaProvider>,
  );
}

afterEach(() => cleanup());

describe("plano pré-selecionado na tela de pagamento", () => {
  it("com ?plano=max o Max abre marcado e o passo continua sendo o da escolha", () => {
    tela("max");
    expect(screen.getByTestId("passo-plano")).toBeInTheDocument();
    expect(screen.getByTestId("plano-max").className).toContain("border-primary");
    expect(screen.getByTestId("plano-pro").className).not.toContain("border-primary");
    expect(screen.getByTestId("plano-escale").className).not.toContain("border-primary");
  });

  it("escolher o já marcado avança para o ciclo com o Max, sem pedir de novo", () => {
    tela("max");
    fireEvent.click(screen.getByTestId("escolher-max"));
    expect(screen.queryByTestId("passo-plano")).toBeNull();
    expect(screen.getByTestId("passo-ciclo").textContent).toContain("Max");
  });

  it("plano ausente, desconhecido ou fora de venda: nenhum marcado, sem erro", () => {
    for (const valor of [null, undefined, "enterprise", "../admin"]) {
      tela(valor);
      for (const p of PLANOS) {
        expect(screen.getByTestId(`plano-${p.code}`).className).not.toContain("border-primary");
      }
      cleanup();
    }
  });
});

describe("ciclo pré-selecionado na tela de pagamento (?ciclo= do site)", () => {
  const marcado = (code: string, ciclo: string) => screen.getByTestId(`ciclo-${code}-${ciclo}`).className.includes("border-primary");

  function irParaOCiclo(code: string) {
    fireEvent.click(screen.getByTestId(`escolher-${code}`));
    expect(screen.getByTestId("passo-ciclo")).toBeInTheDocument();
  }

  it("plano e ciclo válidos: o passo do ciclo abre com o ciclo do site marcado", () => {
    tela("max", "yearly");
    irParaOCiclo("max");
    expect(marcado("max", "yearly")).toBe(true);
    expect(marcado("max", "monthly")).toBe(false);
    expect(marcado("max", "semiannual")).toBe(false);
  });

  it("ciclo semestral também chega marcado", () => {
    tela("max", "semiannual");
    irParaOCiclo("max");
    expect(marcado("max", "semiannual")).toBe(true);
  });

  it("ciclo ausente: segue mensal, como antes", () => {
    for (const valor of [undefined, null]) {
      tela("max", valor);
      irParaOCiclo("max");
      expect(marcado("max", "monthly")).toBe(true);
      cleanup();
    }
  });

  it("ciclo que o plano não vende (Pro sem preço anual): ignorado, segue mensal", () => {
    tela("pro", "yearly");
    irParaOCiclo("pro");
    expect(marcado("pro", "monthly")).toBe(true);
    expect(screen.queryByTestId("ciclo-pro-yearly")).toBeNull();
  });

  it("ciclo inválido (fora da lista fechada) é ignorado, sem erro", () => {
    tela("max", "anual" as never);
    irParaOCiclo("max");
    expect(marcado("max", "monthly")).toBe(true);
  });

  it("sem plano pré-selecionado o ciclo não marca nada: escolher outro plano começa no mensal", () => {
    tela(null, "yearly");
    irParaOCiclo("max");
    expect(marcado("max", "monthly")).toBe(true);
  });

  it("escolher OUTRO plano que o do site volta ao mensal (o ciclo era dica para o plano marcado)", () => {
    tela("max", "yearly");
    irParaOCiclo("pro");
    expect(marcado("pro", "monthly")).toBe(true);
  });
});
