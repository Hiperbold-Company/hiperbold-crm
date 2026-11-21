/**
 * O MENU DO ADMIN ROLA ATÉ O ITEM DA TELA ABERTA — só com o redesign.
 *
 * Com o redesign os itens têm 40px e a lista passa da dobra: em Credenciais,
 * Recursos opcionais e Extensões o item aceso ficava escondido abaixo. Ligado,
 * a lista rola até ele; desligado, nada muda (o painel de sempre).
 *
 * jsdom não faz layout: as caixas são dubladas por `getBoundingClientRect`.
 */
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { destinosDoAdmin } from "@/lib/admin/navegacao";

const ultimo = destinosDoAdmin([]).at(-1)!.href;

vi.mock("next/navigation", () => ({
  usePathname: () => ultimo,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

function ligado({ children }: { children: ReactNode }) {
  return <ProvedorDoRedesign ligado>{children}</ProvedorDoRedesign>;
}

const caixa = (top: number, height: number) =>
  ({ top, bottom: top + height, height, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.tagName === "NAV") return caixa(100, 400);
    if (this.getAttribute("aria-current") === "page") return caixa(800, 40);
    return caixa(0, 0);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("redesign: menu do admin rola até o item aceso", () => {
  it("ligado, com o item abaixo da dobra, a lista rola e o item fica no meio", () => {
    const { container } = render(<AdminSidebar userEmail="a@b.c" />, { wrapper: ligado });
    const nav = container.querySelector("nav")!;
    expect(nav.querySelector('[aria-current="page"]')?.getAttribute("href")).toBe(ultimo);
    // 800 - 100 - (400 - 40) / 2 = 520
    expect(nav.scrollTop).toBe(520);
  });

  it("desligado, a lista não rola", () => {
    const { container } = render(<AdminSidebar userEmail="a@b.c" />);
    expect(container.querySelector("nav")!.scrollTop).toBe(0);
  });
});
