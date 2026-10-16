/**
 * O SELETOR DE MODELO DO AGENTE E O FREIO DE CUSTO (decisão do dono, 16/10/2026).
 *
 * Sem chave própria do provedor, o agente roda na chave da instalação e o seletor
 * só oferece os modelos de `MODELOS_DA_INSTALACAO` (nome amigável, padrão
 * pré-selecionado). Com chave própria, o catálogo inteiro. Agente salvo com
 * modelo não liberado mostra o aviso. O servidor aplica a mesma regra de verdade;
 * aqui se prova o que a pessoa vê.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

// O Select do Radix pede estas APIs do navegador, que o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("@/lib/api/client", () => ({ apiClient: { get: getMock } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { ModelPicker } from "@/app/app/ai/agents/[id]/_components/ModelPicker";

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

const CATALOGO = [
  { provider: "openrouter", model_id: "openai/gpt-6-luna", display_name: "OpenAI: GPT-6 Luna", context_window: 400000, is_default_for_provider: false },
  { provider: "openrouter", model_id: "anthropic/claude-opus-5", display_name: "Claude Opus 5", context_window: 200000, is_default_for_provider: false },
  { provider: "openrouter", model_id: "google/gemini-x", display_name: "Gemini X", context_window: 1000000, is_default_for_provider: false },
];

function montar(props: Partial<React.ComponentProps<typeof ModelPicker>> & { value: string; onChange?: (v: string) => void }) {
  getMock.mockResolvedValue({ data: { models: CATALOGO, modelos_da_instalacao: ["openai/gpt-6-luna"] } });
  const { onChange = vi.fn(), ...resto } = props;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ModelPicker provider="openrouter" onChange={onChange} id="model" {...resto} />
    </QueryClientProvider>,
  );
  return { onChange };
}

async function abrir() {
  const user = userEvent.setup();
  const gatilho = await screen.findByRole("combobox");
  await waitFor(() => expect(gatilho).not.toBeDisabled());
  await user.click(gatilho);
}

describe("sem chave própria (restrito ao plano)", () => {
  it("lista só o modelo liberado, com o nome amigável", async () => {
    montar({ value: "openai/gpt-6-luna", restritoAoPlano: true });
    await abrir();
    const opcoes = await screen.findAllByRole("option");
    expect(opcoes.map((o) => o.textContent)).toEqual(["Luna (OpenAI) · default"]);
    expect(screen.queryByText("Claude Opus 5")).toBeNull();
  });

  it("agente novo (vazio) já vem com o padrão liberado escolhido", async () => {
    const { onChange } = montar({ value: "", restritoAoPlano: true, preselecionarPadrao: true });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("openai/gpt-6-luna", { contextWindow: 400000 }));
  });

  it("sem preselecionar (papel Operador, onde vazio é 'herdar'), o vazio fica vazio", async () => {
    const { onChange } = montar({ value: "", restritoAoPlano: true });
    await screen.findByRole("combobox");
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("modelo salvo fora da lista continua visível e mostra o aviso", async () => {
    montar({ value: "anthropic/claude-opus-5", restritoAoPlano: true });
    expect(await screen.findByTestId("modelo-so-com-chave-propria")).toHaveTextContent(
      "Este modelo só funciona com a sua própria chave. Sem ela, o agente usa o Luna.",
    );
  });

  it("modelo salvo liberado não mostra aviso", async () => {
    montar({ value: "openai/gpt-6-luna", restritoAoPlano: true });
    await screen.findByRole("combobox");
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.queryByTestId("modelo-so-com-chave-propria")).toBeNull();
  });
});

describe("com chave própria", () => {
  it("mostra o catálogo inteiro, sem aviso e sem trocar o vazio", async () => {
    const { onChange } = montar({ value: "", restritoAoPlano: false, preselecionarPadrao: true });
    await abrir();
    const opcoes = await screen.findAllByRole("option");
    expect(opcoes.map((o) => o.textContent)).toEqual(["OpenAI: GPT-6 Luna", "Claude Opus 5", "Gemini X"]);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("modelo-so-com-chave-propria")).toBeNull();
  });
});
