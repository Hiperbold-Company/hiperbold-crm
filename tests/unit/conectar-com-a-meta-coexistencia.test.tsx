/**
 * O SELETOR DE MODO (padrão x coexistência) do botão "Conectar com a Meta".
 *
 * Quem escolhe "Conexão em coexistência" abre o popup da Meta com
 * `featureType: whatsapp_business_app_onboarding`; quem fica no "Conexão padrão" abre exatamente o
 * fluxo de sempre. O que se prova é o que o `FB.login` RECEBE, no mesmo tique do clique.
 *
 * Roda com: npx vitest run tests/unit/conectar-com-a-meta-coexistencia.test.tsx
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pedirInicio } = vi.hoisted(() => ({ pedirInicio: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/channels/useCadastroIncorporado", () => ({
  pedirInicioDoCadastroIncorporado: pedirInicio,
  useFinalizarCadastroIncorporado: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/components/connections/AvisoDeLimiteDeConexoes", () => ({ AvisoDeLimiteDeConexoes: () => null }));

import { ConectarComAMeta } from "@/components/connections/ConectarComAMeta";

const login = vi.fn();
const init = vi.fn();

beforeEach(() => {
  login.mockReset();
  init.mockReset();
  pedirInicio.mockReset();
  pedirInicio.mockResolvedValue({
    disponivel: true,
    appId: "123456",
    configId: "cfg-1",
    versaoDaGraph: "v26.0",
    state: "state-1",
  });
  (window as unknown as { FB: unknown }).FB = { init, login };
});

afterEach(() => {
  delete (window as unknown as { FB?: unknown }).FB;
});

async function clicarQuandoPronto() {
  await waitFor(() => expect(init).toHaveBeenCalled());
  fireEvent.click(screen.getByTestId("btn-conectar-meta"));
  await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  return login.mock.calls[0]![1] as {
    config_id: string;
    extras: { setup: unknown; sessionInfoVersion: string; featureType?: string };
  };
}

describe("ConectarComAMeta: modo de conexão", () => {
  it("coexistência: o FB.login recebe featureType whatsapp_business_app_onboarding", async () => {
    render(<ConectarComAMeta jaConectado={false} />);
    fireEvent.click(screen.getByTestId("cadastro-meta-modo-coexistencia"));
    const opts = await clicarQuandoPronto();
    expect(opts.config_id).toBe("cfg-1");
    expect(opts.extras).toEqual({
      setup: {},
      sessionInfoVersion: "3",
      featureType: "whatsapp_business_app_onboarding",
    });
  });

  it("padrão (selecionado de início): o FB.login sai como sempre, sem featureType", async () => {
    render(<ConectarComAMeta jaConectado={false} />);
    expect(screen.getByTestId("cadastro-meta-modo-padrao").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("cadastro-meta-modo-coexistencia").getAttribute("aria-pressed")).toBe("false");
    const opts = await clicarQuandoPronto();
    expect(opts.extras).toEqual({ setup: {}, sessionInfoVersion: "3" });
    expect("featureType" in opts.extras).toBe(false);
  });

  it("coexistência e depois padrão de novo volta ao fluxo comum", async () => {
    render(<ConectarComAMeta jaConectado={false} />);
    fireEvent.click(screen.getByTestId("cadastro-meta-modo-coexistencia"));
    fireEvent.click(screen.getByTestId("cadastro-meta-modo-padrao"));
    const opts = await clicarQuandoPronto();
    expect(opts.extras).toEqual({ setup: {}, sessionInfoVersion: "3" });
  });

  it("a caixa explicativa muda com a escolha, e só a coexistência traz o aviso do recurso recente", () => {
    render(<ConectarComAMeta jaConectado={false} />);
    expect(screen.getByTestId("cadastro-meta-explicacao-padrao").textContent).toMatch(
      /só pela API oficial/,
    );
    expect(screen.queryByTestId("cadastro-meta-explicacao-coexistencia")).toBeNull();

    fireEvent.click(screen.getByTestId("cadastro-meta-modo-coexistencia"));
    const caixa = screen.getByTestId("cadastro-meta-explicacao-coexistencia");
    expect(caixa.textContent).toMatch(/QR Code/);
    expect(caixa.textContent).toMatch(/Recurso recente da Meta: se a conexão falhar, use a conexão padrão\./);
    expect(screen.queryByTestId("cadastro-meta-explicacao-padrao")).toBeNull();
  });

  it("os botões de modo ficam desabilitados enquanto o cadastro está em andamento", async () => {
    render(<ConectarComAMeta jaConectado={false} />);
    await clicarQuandoPronto();
    await waitFor(() => {
      expect((screen.getByTestId("cadastro-meta-modo-padrao") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("cadastro-meta-modo-coexistencia") as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
