/**
 * O SELETOR DE MODO (padrão x coexistência) do botão "Conectar com a Meta".
 *
 * Quem escolhe "Já uso no WhatsApp Business (coexistência)" abre o popup da Meta com
 * `featureType: whatsapp_business_app_onboarding`; quem fica no "Número novo (conexão padrão)" abre exatamente o
 * fluxo de sempre. O que se prova é o que o `FB.login` RECEBE, no mesmo tique do clique.
 *
 * Roda com: npx vitest run tests/unit/conectar-com-a-meta-coexistencia.test.tsx
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pedirInicio, finalizar, sincronizar } = vi.hoisted(() => ({
  pedirInicio: vi.fn(),
  finalizar: vi.fn(),
  sincronizar: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/channels/useCadastroIncorporado", () => ({
  pedirInicioDoCadastroIncorporado: pedirInicio,
  useFinalizarCadastroIncorporado: () => ({ mutateAsync: finalizar }),
  useSincronizarContatosDoApp: () => ({ mutateAsync: sincronizar, isPending: false }),
}));
vi.mock("@/components/connections/AvisoDeLimiteDeConexoes", () => ({ AvisoDeLimiteDeConexoes: () => null }));

import { ConectarComAMeta } from "@/components/connections/ConectarComAMeta";

const login = vi.fn();
const init = vi.fn();

beforeEach(() => {
  login.mockReset();
  init.mockReset();
  pedirInicio.mockReset();
  finalizar.mockReset();
  sincronizar.mockReset();
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

/** Na coexistência o botão só destrava com a caixa de ciência dos contatos marcada (LGPD). */
function marcarCienciaDosContatos() {
  fireEvent.click(screen.getByTestId("cadastro-meta-confirma-contatos"));
}

async function clicarQuandoPronto() {
  await waitFor(() => expect(init).toHaveBeenCalled());
  const caixa = screen.queryByTestId("cadastro-meta-confirma-contatos") as HTMLInputElement | null;
  if (caixa && !caixa.checked) marcarCienciaDosContatos();
  fireEvent.click(screen.getByTestId("btn-conectar-meta"));
  await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  return login.mock.calls[0]![1] as {
    config_id: string;
    extras: { setup: unknown; sessionInfoVersion: string; featureType?: string };
  };
}

describe("ConectarComAMeta: modo de conexão", () => {
  it("coexistência: o FB.login recebe featureType whatsapp_business_app_onboarding", async () => {
    render(<ConectarComAMeta />);
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
    render(<ConectarComAMeta />);
    expect(screen.getByTestId("cadastro-meta-modo-padrao").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("cadastro-meta-modo-coexistencia").getAttribute("aria-checked")).toBe("false");
    const opts = await clicarQuandoPronto();
    expect(opts.extras).toEqual({ setup: {}, sessionInfoVersion: "3" });
    expect("featureType" in opts.extras).toBe(false);
  });

  it("coexistência e depois padrão de novo volta ao fluxo comum", async () => {
    render(<ConectarComAMeta />);
    fireEvent.click(screen.getByTestId("cadastro-meta-modo-coexistencia"));
    fireEvent.click(screen.getByTestId("cadastro-meta-modo-padrao"));
    const opts = await clicarQuandoPronto();
    expect(opts.extras).toEqual({ setup: {}, sessionInfoVersion: "3" });
  });

  it("cada cartão traz a própria explicação, e só a coexistência abre o aviso do recurso recente", () => {
    render(<ConectarComAMeta />);
    expect(screen.getByTestId("cadastro-meta-modo-padrao").textContent).toMatch(/só pela API oficial/);
    expect(screen.getByTestId("cadastro-meta-modo-coexistencia").textContent).toMatch(/QR Code/);
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByTestId("cadastro-meta-explicacao-coexistencia")).toBeNull();

    fireEvent.click(screen.getByTestId("cadastro-meta-modo-coexistencia"));
    const caixa = screen.getByTestId("cadastro-meta-explicacao-coexistencia");
    expect(caixa.textContent).toMatch(/Recurso recente da Meta: se a conexão falhar, use a conexão padrão\./);
    expect(screen.getByTestId("cadastro-meta-modo-coexistencia").getAttribute("aria-checked")).toBe("true");
  });

  it("os botões de modo ficam desabilitados enquanto o cadastro está em andamento", async () => {
    render(<ConectarComAMeta />);
    await clicarQuandoPronto();
    await waitFor(() => {
      expect((screen.getByTestId("cadastro-meta-modo-padrao") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("cadastro-meta-modo-coexistencia") as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

const botao = () => screen.getByTestId("btn-conectar-meta") as HTMLButtonElement;

describe("ConectarComAMeta: aviso e ciência dos contatos na coexistência (LGPD)", () => {
  it("só a coexistência mostra o aviso dos contatos e a caixa; a conexão padrão não", () => {
    render(<ConectarComAMeta temConexaoOficial={false} />);
    expect(screen.queryByTestId("cadastro-meta-aviso-contatos")).toBeNull();
    expect(screen.queryByTestId("cadastro-meta-confirma-contatos")).toBeNull();

    fireEvent.click(screen.getByTestId("cadastro-meta-modo-coexistencia"));
    expect(screen.getByTestId("cadastro-meta-aviso-contatos").textContent).toBe(
      "Os contatos e as conversas dos últimos 6 meses do WhatsApp Business deste número vão aparecer no CRM para a sua equipe.",
    );
    expect((screen.getByTestId("cadastro-meta-confirma-contatos") as HTMLInputElement).checked).toBe(false);
  });

  it("sem a caixa marcada o botão fica desativado e o popup NÃO abre, nem por clique forçado", async () => {
    render(<ConectarComAMeta temConexaoOficial={false} />);
    await waitFor(() => expect(init).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("cadastro-meta-modo-coexistencia"));

    expect(botao().disabled).toBe(true);
    fireEvent.click(botao());
    expect(login).not.toHaveBeenCalled();
  });

  it("marcada a caixa o botão ativa e o popup abre; desmarcar trava de novo", async () => {
    render(<ConectarComAMeta temConexaoOficial={false} />);
    await waitFor(() => expect(init).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("cadastro-meta-modo-coexistencia"));

    marcarCienciaDosContatos();
    expect(botao().disabled).toBe(false);
    marcarCienciaDosContatos();
    expect(botao().disabled).toBe(true);

    marcarCienciaDosContatos();
    fireEvent.click(botao());
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  });

  it("a conexão padrão não pede caixa nenhuma; e voltar da coexistência desmarca a ciência", async () => {
    render(<ConectarComAMeta temConexaoOficial={false} />);
    expect(botao().disabled).toBe(false);

    fireEvent.click(screen.getByTestId("cadastro-meta-modo-coexistencia"));
    marcarCienciaDosContatos();
    fireEvent.click(screen.getByTestId("cadastro-meta-modo-padrao"));
    expect(botao().disabled).toBe(false);

    fireEvent.click(screen.getByTestId("cadastro-meta-modo-coexistencia"));
    expect((screen.getByTestId("cadastro-meta-confirma-contatos") as HTMLInputElement).checked).toBe(false);
    expect(botao().disabled).toBe(true);
  });
});

describe("ConectarComAMeta: a sincronização dos contatos que falhou não fica silenciosa", () => {
  /** Conecta em coexistência até o POST final, com a Meta devolvendo o `evento` do popup. */
  async function conectarEmCoexistencia(resposta: unknown) {
    finalizar.mockResolvedValue({ data: resposta });
    login.mockImplementation((callback: (r: unknown) => void) => callback({ authResponse: { code: "codigo-1" } }));
    render(<ConectarComAMeta temConexaoOficial={false} />);
    fireEvent.click(screen.getByTestId("cadastro-meta-modo-coexistencia"));
    await waitFor(() => expect(init).toHaveBeenCalled());
    marcarCienciaDosContatos();
    fireEvent.click(botao());
    await waitFor(() => expect(login).toHaveBeenCalled());
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://www.facebook.com",
          data: JSON.stringify({
            type: "WA_EMBEDDED_SIGNUP",
            event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
            data: { phone_number_id: "111", waba_id: "222" },
          }),
        }),
      );
    });
    await waitFor(() => expect(finalizar).toHaveBeenCalledTimes(1));
  }

  const conectado = { connected: true, displayName: "Loja", phoneNumber: "+55 11", precisaRegistrar: false };

  it("sincronizacaoDoApp false: mostra o aviso e o botão Tentar de novo", async () => {
    await conectarEmCoexistencia({ ...conectado, channelSessionId: "sessao-1", sincronizacaoDoApp: false });
    const aviso = await screen.findByTestId("cadastro-meta-sincronizacao-falhou");
    expect(aviso.textContent).toContain("A conexão funcionou, mas os contatos do WhatsApp Business não foram trazidos.");
    expect(screen.getByTestId("cadastro-meta-sincronizar-de-novo")).toBeTruthy();
  });

  it("sincronizacaoDoApp true, null ou ausente: nenhum aviso", async () => {
    await conectarEmCoexistencia({ ...conectado, channelSessionId: "sessao-1", sincronizacaoDoApp: true });
    await waitFor(() => expect((screen.getByTestId("btn-conectar-meta") as HTMLButtonElement).textContent).toContain("Conectar"));
    expect(screen.queryByTestId("cadastro-meta-sincronizacao-falhou")).toBeNull();
  });

  it("Tentar de novo chama a rota com a sessão; aceita pela Meta, o aviso some", async () => {
    sincronizar.mockResolvedValue({ data: { sincronizado: true, motivo: null } });
    await conectarEmCoexistencia({ ...conectado, channelSessionId: "sessao-1", sincronizacaoDoApp: false });
    fireEvent.click(await screen.findByTestId("cadastro-meta-sincronizar-de-novo"));

    await waitFor(() => expect(sincronizar).toHaveBeenCalledWith({ channel_session_id: "sessao-1" }));
    await waitFor(() => expect(screen.queryByTestId("cadastro-meta-sincronizacao-falhou")).toBeNull());
  });

  it("a Meta recusar de novo: o aviso fica, com o motivo, e dá para tentar outra vez", async () => {
    sincronizar.mockResolvedValue({ data: { sincronizado: false, motivo: "A Meta recusou o pedido (código 100)." } });
    await conectarEmCoexistencia({ ...conectado, channelSessionId: "sessao-1", sincronizacaoDoApp: false });
    fireEvent.click(await screen.findByTestId("cadastro-meta-sincronizar-de-novo"));

    const motivo = await screen.findByTestId("cadastro-meta-sincronizacao-motivo");
    expect(motivo.textContent).toBe("A Meta recusou o pedido (código 100).");
    expect(screen.getByTestId("cadastro-meta-sincronizacao-falhou")).toBeTruthy();
    expect(screen.getByTestId("cadastro-meta-sincronizar-de-novo")).toBeTruthy();
  });
});
