/**
 * "Reconectar" no cartão da conexão caída (API não oficial), provado pela tela.
 *
 * A faixa vermelha dizia "Escanear o QR" e o cartão só mostrava "Precisa parear o aparelho", sem botão:
 * a única saída era remover e criar de novo. Aqui: o cartão caído tem "Reconectar", o conectado não; o
 * QR abre dentro do cartão; quando o número volta, a lista recarrega, o topo é avisado e um número
 * diferente gera aviso; `reconectarId` (o link da faixa) já abre o QR do cartão certo; e fechar o painel
 * não chama nenhuma rota de apagar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getMock = vi.fn();
const postMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
    put: vi.fn(),
    delete: (...a: unknown[]) => deleteMock(...a),
  },
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { CanalInstanciaClient } from "@/components/connections/CanalInstanciaClient";
import { ApiError } from "@/lib/api/types";

const QR = "data:image/png;base64,iVBORw0KGgo=";
let conexoes: Array<Record<string, unknown>>;

function tela(props: { reconectarId?: string | null; aoReconectar?: () => void; aoConsumirReconectar?: () => void } = {}) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CanalInstanciaClient {...props} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom não implementa a rolagem.
  Element.prototype.scrollIntoView = vi.fn();
  conexoes = [
    { id: "canal-caido", display_name: "Comercial", phone_number: "+5511999990001", status: "SCAN_QR_CODE", servidor: "srv", webhook_registrado: true },
    { id: "canal-ok", display_name: "Suporte", phone_number: "+5511999990002", status: "WORKING", servidor: "srv", webhook_registrado: true },
  ];
  getMock.mockImplementation((url: string) => {
    if (url === "/api/v1/channels/instancia") return Promise.resolve({ data: { label: "API não oficial", conexoes } });
    // Acesso da IA de cada cartão: fora do que este teste mede.
    return new Promise(() => undefined);
  });
  postMock.mockImplementation((url: string) => {
    if (url.endsWith("/reconectar")) {
      return Promise.resolve({ data: { id: "canal-caido", estado: "aguardando", qr: QR, codigo: null } });
    }
    return Promise.reject(new Error(`rota não prevista: ${url}`));
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CanalInstanciaClient: Reconectar", () => {
  it("só o cartão caído tem o botão; clicar pede o QR da conexão certa e o mostra dentro do cartão", async () => {
    render(tela());
    const botoes = await screen.findAllByRole("button", { name: "Reconectar" });
    expect(botoes).toHaveLength(1);
    expect(screen.getByTestId("canal-instancia-cartao-canal-caido")).toContainElement(botoes[0]!);

    fireEvent.click(botoes[0]!);
    const img = await screen.findByTestId("reconectar-qr-imagem");
    expect(img).toHaveAttribute("src", QR);
    expect(postMock).toHaveBeenCalledWith("/api/v1/channels/instancia/canal-caido/reconectar", { telefone: null });
    expect(screen.getByTestId("canal-instancia-cartao-canal-caido")).toContainElement(img);
  });

  it("fechar o painel só para de esperar: nenhuma rota de apagar é chamada", async () => {
    render(tela());
    fireEvent.click(await screen.findByRole("button", { name: "Reconectar" }));
    await screen.findByTestId("reconectar-qr-imagem");
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.queryByTestId("reconectar-qr-imagem")).toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reconectar" })).toBeInTheDocument();
  });

  it("o link da faixa (`reconectarId`) rola até o cartão certo, já abre o QR e pede para tirar o parâmetro uma vez", async () => {
    const aoConsumirReconectar = vi.fn();
    render(tela({ reconectarId: "canal-caido", aoConsumirReconectar }));
    await screen.findByTestId("reconectar-qr-imagem");
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith("/api/v1/channels/instancia/canal-caido/reconectar", { telefone: null });
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(aoConsumirReconectar).toHaveBeenCalledTimes(1);
  });

  it("id da faixa que não está na lista não abre nada", async () => {
    render(tela({ reconectarId: "outro" }));
    await screen.findAllByRole("button", { name: "Reconectar" });
    expect(postMock).not.toHaveBeenCalled();
  });

  it("quando o número volta: recarrega a lista, avisa o topo, e número diferente gera aviso", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const aoReconectar = vi.fn();
    postMock.mockImplementation((url: string) => {
      if (url.endsWith("/reconectar")) {
        return Promise.resolve({ data: { id: "canal-caido", estado: "aguardando", qr: QR, codigo: null } });
      }
      if (url.endsWith("/reconectar/verificar")) {
        conexoes = conexoes.map((c) => (c.id === "canal-caido" ? { ...c, status: "WORKING" } : c));
        return Promise.resolve({
          data: {
            id: "canal-caido",
            estado: "conectado",
            conexao: { id: "canal-caido", display_name: "Comercial", phone_number: "+5521988887777", status: "WORKING" },
            webhook: { registrado: true, aviso: null },
            numero_mudou: true,
          },
        });
      }
      return Promise.reject(new Error(`rota não prevista: ${url}`));
    });

    render(tela({ aoReconectar }));
    fireEvent.click(await screen.findByRole("button", { name: "Reconectar" }));
    await screen.findByTestId("reconectar-qr-imagem");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    await waitFor(() => expect(aoReconectar).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith("Conectou um número diferente do anterior. Confira se é o aparelho certo.");
    // A lista recarregou: o cartão agora está conectado e sem o botão.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reconectar" })).toBeNull());
    expect(screen.getAllByText("Conectado").length).toBeGreaterThanOrEqual(2);
  });
  const verificacoes = () => postMock.mock.calls.filter(([u]) => String(u).endsWith("/verificar")).length;

  it("verificar devolve 409: mostra a mensagem no painel, para de perguntar e oferece Tentar de novo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    postMock.mockImplementation((url: string) => {
      if (url.endsWith("/reconectar")) {
        return Promise.resolve({ data: { id: "canal-caido", estado: "aguardando", qr: QR, codigo: null } });
      }
      return Promise.reject(new ApiError(409, "state_conflict", undefined, "req", "Este número já está em outra conexão desta empresa. Remova uma das duas e tente de novo."));
    });
    render(tela());
    fireEvent.click(await screen.findByRole("button", { name: "Reconectar" }));
    await screen.findByTestId("reconectar-qr-imagem");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(await screen.findByTestId("reconectar-erro")).toHaveTextContent("Este número já está em outra conexão desta empresa.");
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
    const depoisDoErro = verificacoes();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(verificacoes()).toBe(depoisDoErro);
  });

  it("429 e 502 seguem silenciosos: o polling continua", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    postMock.mockImplementation((url: string) => {
      if (url.endsWith("/reconectar")) {
        return Promise.resolve({ data: { id: "canal-caido", estado: "aguardando", qr: QR, codigo: null } });
      }
      return Promise.reject(new ApiError(verificacoes() % 2 ? 429 : 502, "x", undefined, "req", "x"));
    });
    render(tela());
    fireEvent.click(await screen.findByRole("button", { name: "Reconectar" }));
    await screen.findByTestId("reconectar-qr-imagem");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_300);
    });
    expect(verificacoes()).toBeGreaterThanOrEqual(3);
    expect(screen.queryByTestId("reconectar-erro")).toBeNull();
  });

  it("re-render do pai não reinicia o polling, e desmontar limpa o intervalo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    postMock.mockImplementation(() =>
      Promise.resolve({ data: { id: "canal-caido", estado: "aguardando", qr: QR, codigo: null } }),
    );
    const montada = render(tela({ aoReconectar: () => undefined }));
    fireEvent.click(await screen.findByRole("button", { name: "Reconectar" }));
    await screen.findByTestId("reconectar-qr-imagem");
    // O pai renderiza de novo com uma função nova: o intervalo não pode ser recriado.
    const limpar = vi.spyOn(globalThis, "clearInterval");
    montada.rerender(tela({ aoReconectar: () => undefined }));
    expect(limpar).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    const antes = verificacoes();
    expect(antes).toBeGreaterThanOrEqual(1);
    montada.unmount();
    expect(limpar).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(verificacoes()).toBe(antes);
    limpar.mockRestore();
  });

  it("volta sem webhook: o aviso vai na descrição do toast (o painel some com o cartão)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    postMock.mockImplementation((url: string) => {
      if (url.endsWith("/reconectar")) {
        return Promise.resolve({ data: { id: "canal-caido", estado: "aguardando", qr: QR, codigo: null } });
      }
      return Promise.resolve({
        data: {
          id: "canal-caido",
          estado: "conectado",
          conexao: { id: "canal-caido", display_name: "Comercial", phone_number: "+5511999990001", status: "WORKING" },
          webhook: { registrado: false, aviso: "O endereço público do CRM não está configurado." },
          numero_mudou: false,
        },
      });
    });
    render(tela());
    fireEvent.click(await screen.findByRole("button", { name: "Reconectar" }));
    await screen.findByTestId("reconectar-qr-imagem");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith("Conectado, mas as mensagens ainda não entram.", {
        description: "O endereço público do CRM não está configurado.",
      }),
    );
  });
});
