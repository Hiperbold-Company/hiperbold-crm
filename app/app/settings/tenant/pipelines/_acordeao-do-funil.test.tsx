/**
 * O acordeão da página Etapas do funil: fechado por padrão, aberto pelo hash (na abertura e quando muda),
 * aberto quando há um funil só, e "Abrir todos / Fechar todos".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AcordeaoDoFunil, AcordeaoDosFunis, funilDoHash } from "./_acordeao-do-funil";

const A = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "PMA 2027", slug: "pma-2027", is_default: true };
const B = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "PMA 2028", slug: "pma-2028" };

function Tela({ funis = [A, B] }: { funis?: Array<typeof A | typeof B> }) {
  return (
    <AcordeaoDosFunis pipelines={funis} podeDuplicar>
      {funis.map((p) => (
        <AcordeaoDoFunil key={p.id} pipeline={p} numeroDeEtapas={4}>
          <div id={`etapas-${p.id}`}>conteúdo de {p.name}</div>
          {/* O link que `_stages.tsx` e `_mapping.tsx` desenham para a âncora do outro funil. */}
          {/* `preventDefault` só para o jsdom: a navegação de fragmento dele é ASSÍNCRONA e regravaria o hash
              depois do `afterEach`, abrindo o funil no teste seguinte. O ouvinte do acordeão não depende dela. */}
          <a href={`#etapas-${p.id === A.id ? B.id : A.id}`} onClick={(e) => e.preventDefault()}>
            ir para o outro funil
          </a>
        </AcordeaoDoFunil>
      ))}
    </AcordeaoDosFunis>
  );
}

const alternador = (id: string) => screen.getByTestId(`alternar-funil-${id}`);
const corpo = (id: string) => document.getElementById(`corpo-do-funil-${id}`)!;

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("acordeão dos funis", () => {
  it("com vários funis, todos nascem fechados — o cabeçalho continua à vista", () => {
    render(<Tela />);
    for (const p of [A, B]) {
      expect(alternador(p.id)).toHaveAttribute("aria-expanded", "false");
      expect(alternador(p.id)).toHaveAttribute("aria-controls", `corpo-do-funil-${p.id}`);
      expect(corpo(p.id)).not.toBeVisible();
    }
    expect(screen.getByText("PMA 2027")).toBeVisible();
    expect(screen.getByText("Padrão")).toBeVisible();
    expect(screen.getAllByText("4 etapas")).toHaveLength(2);
  });

  it("com um funil só, ele nasce aberto, sem seta nem clique de recolher, e não há 'Abrir todos'", () => {
    render(<Tela funis={[A]} />);
    expect(screen.queryByTestId(`alternar-funil-${A.id}`)).toBeNull();
    expect(screen.queryByRole("button", { expanded: true })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: /PMA 2027/ })).toBeVisible();
    expect(corpo(A.id)).toBeVisible();
    expect(screen.queryByTestId("alternar-todos-os-funis")).toBeNull();
  });

  it("o botão mora DENTRO do título (h2 > button), com o selo e a contagem; Duplicar fica fora", () => {
    render(<Tela />);
    const botao = alternador(A.id);
    expect(botao.parentElement?.tagName).toBe("H2");
    expect(botao).toHaveTextContent("PMA 2027");
    expect(botao).toHaveTextContent("Padrão");
    expect(botao).toHaveTextContent("4 etapas");
    expect(botao).not.toContainElement(screen.getByTestId(`duplicar-funil-${A.id}`));
  });

  it("clicar num link para a âncora com o MESMO hash já na URL também abre o funil", () => {
    window.history.replaceState(null, "", `/#etapas-${B.id}`);
    render(<Tela />);
    // A pessoa fecha o funil B, que o hash tinha aberto; a URL continua com o mesmo hash.
    fireEvent.click(alternador(B.id));
    expect(corpo(B.id)).not.toBeVisible();
    fireEvent.click(screen.getByText("Abrir todos"));
    fireEvent.click(screen.getByText("Fechar todos"));
    // O link do funil A aponta para B: sem `hashchange` (o hash não muda), o clique é que abre.
    fireEvent.click(alternador(A.id));
    const link = screen.getAllByText("ir para o outro funil")[0]!;
    act(() => {
      fireEvent.click(link);
    });
    expect(alternador(B.id)).toHaveAttribute("aria-expanded", "true");
  });

  it("clicar no cabeçalho abre e fecha só aquele funil", () => {
    render(<Tela />);
    fireEvent.click(alternador(B.id));
    expect(corpo(B.id)).toBeVisible();
    expect(corpo(A.id)).not.toBeVisible();
    fireEvent.click(alternador(B.id));
    expect(corpo(B.id)).not.toBeVisible();
  });

  it("abre pelo hash da URL na abertura (#etapas-<id>)", () => {
    window.history.replaceState(null, "", `/#etapas-${B.id}`);
    render(<Tela />);
    expect(alternador(B.id)).toHaveAttribute("aria-expanded", "true");
    expect(alternador(A.id)).toHaveAttribute("aria-expanded", "false");
  });

  it("abre quando o hash MUDA (#mapeamento-<id>) — os links internos da página continuam funcionando", () => {
    render(<Tela />);
    act(() => {
      window.history.replaceState(null, "", `/#mapeamento-${A.id}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(alternador(A.id)).toHaveAttribute("aria-expanded", "true");
  });

  it("Abrir todos / Fechar todos", () => {
    render(<Tela />);
    const botao = screen.getByTestId("alternar-todos-os-funis");
    expect(botao).toHaveTextContent("Abrir todos");
    fireEvent.click(botao);
    expect(corpo(A.id)).toBeVisible();
    expect(corpo(B.id)).toBeVisible();
    expect(botao).toHaveTextContent("Fechar todos");
    fireEvent.click(botao);
    expect(corpo(A.id)).not.toBeVisible();
    expect(corpo(B.id)).not.toBeVisible();
  });

  it("funilDoHash reconhece as três âncoras e ignora o resto", () => {
    const ids = [A.id, B.id];
    expect(funilDoHash(`#etapas-${A.id}`, ids)).toBe(A.id);
    expect(funilDoHash(`#mapeamento-${B.id}`, ids)).toBe(B.id);
    expect(funilDoHash(`#funil-${B.id}`, ids)).toBe(B.id);
    expect(funilDoHash("#outra-coisa", ids)).toBeNull();
    expect(funilDoHash("", ids)).toBeNull();
  });
});
