/**
 * O diálogo "Duplicar funil": abre pelo topo e pelo card, sugere o nome, chama a rota com o nome digitado e a
 * origem escolhida, mostra o erro da API em português e, ao salvar, abre o funil novo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn() } }));

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { AcordeaoDoFunil, AcordeaoDosFunis } from "./_acordeao-do-funil";

const A = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "PMA 2027", slug: "pma-2027" };
const B = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Imersão", slug: "imersao" };

function Tela({ funis = [A, B] }: { funis?: Array<typeof A> }) {
  return (
    <AcordeaoDosFunis pipelines={funis}>
      {funis.map((p) => (
        <AcordeaoDoFunil key={p.id} pipeline={p} numeroDeEtapas={3}>
          <div>corpo</div>
        </AcordeaoDoFunil>
      ))}
    </AcordeaoDosFunis>
  );
}

const post = vi.mocked(apiClient.post);
const nome = () => screen.getByTestId("duplicar-nome") as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("diálogo Duplicar funil", () => {
  it("o 'Duplicar' do card abre com a origem escolhida e o nome sugerido; diz o que não é copiado", () => {
    render(<Tela />);
    fireEvent.click(screen.getByTestId(`duplicar-funil-${B.id}`));
    expect(screen.getByTestId("dialogo-duplicar-funil")).toBeVisible();
    expect(nome().value).toBe("Imersão (cópia)");
    expect(screen.getByTestId("duplicar-origem")).toHaveTextContent("Imersão");
    expect(screen.getByText(/Negócios, automações e formulários não são copiados/)).toBeVisible();
  });

  it("trocar a origem troca o nome sugerido — enquanto a pessoa não editou", async () => {
    render(<Tela />);
    fireEvent.click(screen.getByTestId("duplicar-funil"));
    expect(nome().value).toBe("PMA 2027 (cópia)");

    const trocarPara = async (texto: string) => {
      fireEvent.pointerDown(screen.getByTestId("duplicar-origem"), { button: 0, ctrlKey: false, pointerType: "mouse" });
      fireEvent.click(await screen.findByRole("option", { name: texto }));
    };
    await trocarPara("Imersão");
    expect(nome().value).toBe("Imersão (cópia)");

    fireEvent.change(nome(), { target: { value: "Imersão 2028" } });
    await trocarPara("PMA 2027");
    expect(nome().value).toBe("Imersão 2028");
  });

  it("Salvar chama a rota da ORIGEM com o nome digitado, abre o funil novo e atualiza a lista", async () => {
    const NOVO = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "PMA 2028", slug: "pma-2028" };
    post.mockResolvedValue({ data: { id: NOVO.id, name: NOVO.name } });
    const { rerender } = render(<Tela />);
    fireEvent.click(screen.getByTestId(`duplicar-funil-${A.id}`));
    fireEvent.change(nome(), { target: { value: "  PMA 2028 " } });
    fireEvent.click(screen.getByTestId("duplicar-salvar"));

    await waitFor(() => expect(screen.queryByTestId("dialogo-duplicar-funil")).toBeNull());
    expect(post).toHaveBeenCalledWith(
      `/api/v1/pipelines/${A.id}/duplicate`,
      { name: "PMA 2028" },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(refresh).toHaveBeenCalled();

    // O refresh traz o funil novo: ele aparece ABERTO, e os outros continuam como estavam.
    rerender(<Tela funis={[A, NOVO, B]} />);
    expect(screen.getByTestId(`alternar-funil-${NOVO.id}`)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId(`alternar-funil-${B.id}`)).toHaveAttribute("aria-expanded", "false");
  });

  it("erro da API aparece no diálogo, em português, e o diálogo continua aberto", async () => {
    post.mockRejectedValue(
      new ApiError(402, "plano_limite_atingido", undefined, "r", "O plano desta organização chegou ao limite de funis."),
    );
    render(<Tela />);
    fireEvent.click(screen.getByTestId("duplicar-funil"));
    fireEvent.click(screen.getByTestId("duplicar-salvar"));
    expect(await screen.findByTestId("duplicar-erro")).toHaveTextContent("chegou ao limite de funis");
    expect(screen.getByTestId("dialogo-duplicar-funil")).toBeVisible();
  });

  it("nome vazio não deixa salvar", () => {
    render(<Tela />);
    fireEvent.click(screen.getByTestId("duplicar-funil"));
    fireEvent.change(nome(), { target: { value: "   " } });
    expect(screen.getByTestId("duplicar-salvar")).toBeDisabled();
  });
});
