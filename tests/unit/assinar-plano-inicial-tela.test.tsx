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

const plano = (code: string, name: string, preco: number): PlanoParaVenda => ({
  code,
  name,
  version: 1,
  forSale: true,
  priceMonthlyCents: preco,
  priceSemiannualCents: null,
  priceYearlyCents: null,
  conexoes: 3,
});
const PLANOS = [plano("pro", "Pro", 19900), plano("max", "Max", 39900), plano("escale", "Scale", 79900)];

function tela(planoInicial: string | null | undefined) {
  return render(
    <IdiomaProvider locale="pt-BR">
      <AssinarPlanoPassoAPasso
        planos={PLANOS}
        opcoesDeParcelas={{}}
        taxaMensalPercentual={null}
        precisaPagador={false}
        planoAtualCode={null}
        planoInicial={planoInicial}
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
