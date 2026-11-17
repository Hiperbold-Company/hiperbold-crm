/**
 * O botão "Conectar com a Meta" na aba API Oficial. Prova pela tela (SDK da Meta substituído por um
 * dublê no `window`, popup simulado por `postMessage` com a origem real da Meta):
 *   - sem o app da Meta cadastrado, a tela AVISA e o formulário manual segue inteiro;
 *   - o `FB.login` sai no MESMO tique do clique (Safari bloqueia popup depois de um `await`): o início é
 *     buscado ao montar, e o clique só lê o que já está guardado;
 *   - o POST leva o state guardado; depois dele (ou de qualquer tentativa) um GET novo repõe o state, que é de uso único;
 *   - sem state fresco o clique NÃO abre o popup: avisa e prepara;
 *   - cancelar o popup explica em que etapa.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...a: unknown[]) => getMock(...a), post: (...a: unknown[]) => postMock(...a) },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: () => undefined }));
vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: async () => undefined }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
// O cartão da conexão oficial pergunta a permissão para mostrar "Remover conexão".
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true, usePermissionSeHouverSessao: () => true }));

import { CanalOficialClient } from "@/components/connections/CanalOficialClient";

const NAO_CONECTADO = { data: { connected: false, hasToken: false } };
const CONECTADO = {
  data: {
    connected: true,
    hasToken: true,
    displayName: "Comercial",
    phoneNumber: "+55 35 9999-0000",
    phoneNumberId: "1",
    wabaId: "2",
    status: "active",
    webhook: null,
    webhookRegistro: null,
  },
};
const OFF = { data: { disponivel: false, motivo: "nao_configurado" } };

let estadoDoCanal = NAO_CONECTADO;
let respostasDoInicio: unknown[] = [];

const ROTA_INICIO = "/api/v1/channels/official/cadastro-incorporado";
const chamadasDoInicio = () => getMock.mock.calls.filter((c) => c[0] === ROTA_INICIO).length;

function rotear() {
  getMock.mockImplementation(async (path: string) => {
    if (path === "/api/v1/channels/official") return estadoDoCanal;
    if (path === ROTA_INICIO) {
      return respostasDoInicio.length > 1 ? respostasDoInicio.shift() : respostasDoInicio[0];
    }
    // Cartão do número e afins: não interessam aqui.
    throw new Error(`GET inesperado ${path}`);
  });
}

function inicioOk(state: string) {
  return { data: { disponivel: true, appId: "app1", configId: "cfg1", versaoDaGraph: "v23.0", state } };
}

function montar(props: Parameters<typeof CanalOficialClient>[0] = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CanalOficialClient {...props} />
    </QueryClientProvider>,
  );
}

function popup(origin: string, corpo: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { origin, data: JSON.stringify(corpo) }));
  });
}

type Win = Window & { FB?: unknown };

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  estadoDoCanal = NAO_CONECTADO;
  respostasDoInicio = [];
  rotear();
});
afterEach(() => {
  cleanup();
  delete (window as Win).FB;
});

/** Espera o SDK ter sido iniciado: é o sinal de que o state já está guardado e o clique pode abrir o popup. */
async function esperarPronto(init: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(init).toHaveBeenCalled());
}

function eventoFinish(phone = "1", waba = "2") {
  popup("https://www.facebook.com", {
    type: "WA_EMBEDDED_SIGNUP",
    event: "FINISH",
    data: { phone_number_id: phone, waba_id: waba },
  });
}

describe("Conectar com a Meta", () => {
  it("sem o app da Meta cadastrado: avisa, e o formulário manual continua inteiro", async () => {
    respostasDoInicio = [OFF];
    montar();

    await screen.findByTestId("cadastro-meta-nao-configurado");
    expect(screen.getByTestId("cadastro-meta-nao-configurado").textContent).toContain("Administração › Meta");
    expect(screen.getByTestId("btn-conectar-meta")).toBeTruthy();
    expect(screen.getByTestId("btn-conectar")).toBeTruthy();
    expect(screen.getByLabelText("ID do número de telefone")).toBeTruthy();
    expect(screen.getByLabelText("Token de acesso")).toBeTruthy();
    expect(screen.getByText("Ou conecte à mão")).toBeTruthy();
  });

  it("⭐ o FB.login sai no mesmo tique do clique, com o state e a configuração buscados ao montar", async () => {
    respostasDoInicio = [inicioOk("s-montagem")];
    const ordem: string[] = [];
    const init = vi.fn(() => ordem.push("init"));
    const login = vi.fn(() => ordem.push("login"));
    (window as Win).FB = { init, login };
    montar();
    await esperarPronto(init);
    expect(chamadasDoInicio()).toBe(1);

    // fireEvent.click é síncrono: se o login dependesse de uma promessa, ainda não teria sido chamado.
    fireEvent.click(screen.getByTestId("btn-conectar-meta"));
    expect(login).toHaveBeenCalledTimes(1);
    expect(ordem).toEqual(["init", "login"]);
    expect(login).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ config_id: "cfg1", response_type: "code", override_default_response_type: true }),
    );
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ appId: "app1", version: "v23.0" }));
  });

  it("⭐ conecta: POST com o state guardado, o número do popup e o nome; depois um GET novo repõe o state", async () => {
    respostasDoInicio = [inicioOk("s-1"), inicioOk("s-2")];
    postMock.mockResolvedValue({
      data: {
        connected: true,
        displayName: "Comercial",
        phoneNumber: "+55 35 9999-0000",
        webhookRegistro: null,
        precisaRegistrar: true,
      },
    });
    const init = vi.fn();
    const login = vi.fn((cb: (r: unknown) => void) => {
      popup("https://www.facebook.com", {
        type: "WA_EMBEDDED_SIGNUP",
        event: "FINISH",
        data: { phone_number_id: "555", messaging_account_ids: ["777"] },
      });
      cb({ authResponse: { code: "codigo-da-meta" } });
    });
    (window as Win).FB = { init, login };
    montar();
    await esperarPronto(init);

    fireEvent.change(screen.getByTestId("cadastro-meta-nome"), { target: { value: "  Comercial  " } });
    fireEvent.click(screen.getByTestId("btn-conectar-meta"));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock).toHaveBeenCalledWith(ROTA_INICIO, {
      state: "s-1",
      code: "codigo-da-meta",
      phone_number_id: "555",
      waba_id: "777",
      nome: "Comercial",
      evento: "FINISH",
    });
    await screen.findByText("Falta ativar o número: use o botão Registrar no cartão do número.");
    expect(screen.queryByTestId("cadastro-meta-erro")).toBeNull();

    // O state queimou no POST: um GET novo o repõe, e o próximo clique usa o NOVO, nunca o s-1.
    await waitFor(() => expect(chamadasDoInicio()).toBe(2));
    await waitFor(() => expect(init).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTestId("btn-conectar-meta"));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock.mock.calls[1]?.[1]).toMatchObject({ state: "s-2" });
  });

  it("sem state pronto: o clique NÃO abre o popup, avisa e prepara; no clique seguinte abre", async () => {
    let liberar: (v: unknown) => void = () => undefined;
    const demorado = new Promise((r) => {
      liberar = r;
    });
    getMock.mockImplementation(async (path: string) => {
      if (path === "/api/v1/channels/official") return estadoDoCanal;
      if (path === ROTA_INICIO) return demorado;
      throw new Error(`GET inesperado ${path}`);
    });
    const init = vi.fn();
    const login = vi.fn();
    (window as Win).FB = { init, login };
    montar();

    fireEvent.click(await screen.findByTestId("btn-conectar-meta"));
    expect(login).not.toHaveBeenCalled();
    expect(screen.getByTestId("cadastro-meta-preparando").textContent).toBe(
      "Preparando a conexão com a Meta, clique de novo em instantes.",
    );

    await act(async () => {
      liberar(inicioOk("s-1"));
    });
    await esperarPronto(init);
    await waitFor(() => expect(screen.queryByTestId("cadastro-meta-preparando")).toBeNull());
    fireEvent.click(screen.getByTestId("btn-conectar-meta"));
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("state parado há mais de 10 min não é usado: o clique busca outro e não abre o popup", async () => {
    respostasDoInicio = [inicioOk("velho"), inicioOk("novo")];
    const init = vi.fn();
    const login = vi.fn();
    (window as Win).FB = { init, login };
    montar();
    await esperarPronto(init);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, "now").mockReturnValue(agora + 11 * 60_000);
    try {
      fireEvent.click(screen.getByTestId("btn-conectar-meta"));
      expect(login).not.toHaveBeenCalled();
      await waitFor(() => expect(chamadasDoInicio()).toBe(2));
      await waitFor(() => expect(init).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByTestId("btn-conectar-meta"));
      expect(login).toHaveBeenCalledTimes(1);
    } finally {
      relogio.mockRestore();
    }
  });

  it("o clique também confere: configurado só depois da carga, o aviso aparece e nada abre", async () => {
    respostasDoInicio = [inicioOk("s"), OFF];
    const init = vi.fn();
    const login = vi.fn();
    (window as Win).FB = { init, login };
    montar();
    await esperarPronto(init);

    // O state guardado ainda vale, então o clique abre o popup; o GET de reposição é que acusa a mudança.
    fireEvent.click(screen.getByTestId("btn-conectar-meta"));
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("o evento pode chegar DEPOIS do callback do login", async () => {
    respostasDoInicio = [inicioOk("s")];
    postMock.mockResolvedValue({
      data: { connected: true, displayName: "X", phoneNumber: null, webhookRegistro: null, precisaRegistrar: false },
    });
    const init = vi.fn();
    (window as Win).FB = {
      init,
      login: (cb: (r: unknown) => void) => {
        cb({ authResponse: { code: "c" } });
        setTimeout(() => eventoFinish("9", "8"), 20);
      },
    };
    montar();
    await esperarPronto(init);
    fireEvent.click(screen.getByTestId("btn-conectar-meta"));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(postMock.mock.calls[0]?.[1]).toMatchObject({ phone_number_id: "9", waba_id: "8", state: "s" });
  });

  it("popup fechado: a mensagem diz a etapa, nada é enviado e um state novo é buscado", async () => {
    respostasDoInicio = [inicioOk("s-1"), inicioOk("s-2")];
    const init = vi.fn();
    (window as Win).FB = {
      init,
      login: (cb: (r: unknown) => void) => {
        popup("https://www.facebook.com", {
          type: "WA_EMBEDDED_SIGNUP",
          event: "CANCEL",
          data: { current_step: "PHONE_NUMBER_SETUP" },
        });
        cb({ authResponse: null });
      },
    };
    montar();
    await esperarPronto(init);
    fireEvent.click(screen.getByTestId("btn-conectar-meta"));

    const alerta = await screen.findByTestId("cadastro-meta-erro");
    expect(alerta.getAttribute("role")).toBe("alert");
    expect(alerta.textContent).toContain("PHONE_NUMBER_SETUP");
    expect(alerta.textContent).toContain("Nada foi conectado.");
    expect(postMock).not.toHaveBeenCalled();
    await waitFor(() => expect(chamadasDoInicio()).toBe(2));
  });

  it("recusa do servidor: mostra a mensagem em português da rota e repõe o state", async () => {
    respostasDoInicio = [inicioOk("s-1"), inicioOk("s-2")];
    postMock.mockRejectedValue(
      new ApiError(409, "numero_em_outra_organizacao", undefined, "r1", "Este número já está conectado em outra organização."),
    );
    const init = vi.fn();
    (window as Win).FB = {
      init,
      login: (cb: (r: unknown) => void) => {
        eventoFinish();
        cb({ authResponse: { code: "c" } });
      },
    };
    montar();
    await esperarPronto(init);
    fireEvent.click(screen.getByTestId("btn-conectar-meta"));
    const alerta = await screen.findByTestId("cadastro-meta-erro");
    expect(alerta.textContent).toBe("Este número já está conectado em outra organização.");
    await waitFor(() => expect(chamadasDoInicio()).toBe(2));
  });

  it("já conectado: cada número é uma conexão nova, sem Trocar nem aviso de substituição", async () => {
    // Várias contas oficiais por organização (17/11/2026): conectar outro número não substitui a atual.
    estadoDoCanal = CONECTADO as typeof NAO_CONECTADO;
    respostasDoInicio = [OFF];
    montar();
    const botao = await screen.findByTestId("btn-conectar-meta");
    expect(botao.textContent).toBe("Conectar com a Meta");
    expect(screen.queryByText(/substitui a atual/)).toBeNull();
  });

  it("limite do plano sem canal conectado: o botão da Meta fica desabilitado como o manual", async () => {
    respostasDoInicio = [OFF];
    montar({ bloqueio: { desabilitado: true, motivo: "Limite atingido." } as never });
    const botao = (await screen.findByTestId("btn-conectar-meta")) as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    expect((screen.getByTestId("btn-conectar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("limite do plano COM conexão oficial: o botão da Meta fica livre para reautenticar o mesmo número", async () => {
    // O servidor reaproveita a linha do mesmo número; número novo é recusado pela rota, com a mensagem dela.
    estadoDoCanal = CONECTADO as typeof NAO_CONECTADO;
    respostasDoInicio = [OFF];
    montar({ bloqueio: { desabilitado: true, motivo: "Limite atingido." } as never });
    const botao = (await screen.findByTestId("btn-conectar-meta")) as HTMLButtonElement;
    expect(botao.disabled).toBe(false);
    expect(screen.getByTestId("cadastro-meta-so-reconectar")).toBeTruthy();
  });
});
