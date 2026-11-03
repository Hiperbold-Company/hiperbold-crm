import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RedesSociaisClient, precisaReconectar, type ContaSocial } from "./RedesSociaisClient";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  delete: vi.fn(),
  busca: "aba=sociais",
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: h.get, delete: h.delete } }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(h.busca),
  usePathname: () => "/app/connections",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const AGORA = Date.now();
const DIA = 24 * 60 * 60 * 1000;

function conta(extra: Partial<ContaSocial> = {}): ContaSocial {
  return {
    id: "c1",
    plataforma: "instagram",
    nome: "Loja Exemplo",
    usuario: "lojaexemplo",
    conectado_em: "2026-10-30T12:00:00Z",
    token_expira_em: new Date(AGORA + 50 * DIA).toISOString(),
    status: "ativo",
    ...extra,
  };
}

function estado(configurado: { instagram: boolean; messenger: boolean }, contas: ContaSocial[] = []) {
  return { data: { configurado, contas } };
}

function montar() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RedesSociaisClient />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.busca = "aba=sociais";
  window.history.replaceState(null, "", "/app/connections?aba=sociais");
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Redes sociais pela conexão oficial da Meta", () => {
  it("instalação sem a conexão liberada: Conectar desabilitado e explicado", async () => {
    h.get.mockResolvedValue(estado({ instagram: false, messenger: false }));
    montar();
    const instagram = await screen.findByTestId("cartao-instagram");
    const botao = within(instagram).getByRole("button", { name: "Conectar" });
    expect(botao).toBeDisabled();
    expect(within(instagram).getByText("A conexão ainda não foi liberada nesta instalação.")).toBeInTheDocument();
    expect(within(screen.getByTestId("cartao-messenger")).getByRole("button", { name: "Conectar" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Conectar" })).toBeNull();
  });

  it("sem contas: cada cartão leva à conexão da própria plataforma", async () => {
    h.get.mockResolvedValue(estado({ instagram: true, messenger: true }));
    montar();
    const instagram = await screen.findByTestId("cartao-instagram");
    expect(within(instagram).getByRole("link", { name: "Conectar" })).toHaveAttribute(
      "href",
      "/api/v1/channels/meta-social/conectar?plataforma=instagram",
    );
    expect(
      within(screen.getByTestId("cartao-messenger")).getByRole("link", { name: "Conectar" }),
    ).toHaveAttribute("href", "/api/v1/channels/meta-social/conectar?plataforma=messenger");
    expect(screen.getAllByText("Nenhuma conta conectada.")).toHaveLength(2);
    expect(h.get).toHaveBeenCalledWith("/api/v1/channels/meta-social");
  });

  it("com conta: mostra nome e @usuário e só desconecta depois de confirmar", async () => {
    h.get.mockResolvedValue(estado({ instagram: true, messenger: true }, [conta()]));
    h.delete.mockResolvedValue({ data: { ok: true } });
    montar();
    const instagram = await screen.findByTestId("cartao-instagram");
    expect(within(instagram).getByText("Loja Exemplo")).toBeInTheDocument();
    expect(within(instagram).getByText("@lojaexemplo")).toBeInTheDocument();
    expect(within(instagram).queryByText("Reconecte para continuar recebendo mensagens.")).toBeNull();
    expect(within(screen.getByTestId("cartao-messenger")).getByText("Nenhuma conta conectada.")).toBeInTheDocument();

    fireEvent.click(within(instagram).getByRole("button", { name: "Desconectar" }));
    const dialogo = await screen.findByRole("alertdialog");
    expect(
      within(dialogo).getByText(
        "As novas mensagens deixam de chegar. As mensagens já recebidas continuam no Chat.",
      ),
    ).toBeInTheDocument();
    expect(h.delete).not.toHaveBeenCalled();
    fireEvent.click(within(dialogo).getByRole("button", { name: "Desconectar" }));
    await waitFor(() => expect(h.delete).toHaveBeenCalledWith("/api/v1/channels/meta-social/c1"));
  });

  it("token do Instagram perto de vencer: pede para reconectar", async () => {
    h.get.mockResolvedValue(
      estado({ instagram: true, messenger: true }, [
        conta({ token_expira_em: new Date(AGORA + 3 * DIA).toISOString() }),
      ]),
    );
    montar();
    const instagram = await screen.findByTestId("cartao-instagram");
    expect(within(instagram).getByText("Reconecte para continuar recebendo mensagens.")).toBeInTheDocument();
    expect(within(instagram).getByRole("link", { name: "Reconectar" })).toHaveAttribute(
      "href",
      "/api/v1/channels/meta-social/conectar?plataforma=instagram",
    );
  });

  it("precisaReconectar: status de erro ou menos de 7 dias; token sem prazo não alarma", () => {
    expect(precisaReconectar(conta({ token_expira_em: null }), AGORA)).toBe(false);
    expect(precisaReconectar(conta({ token_expira_em: new Date(AGORA + 8 * DIA).toISOString() }), AGORA)).toBe(false);
    expect(precisaReconectar(conta({ token_expira_em: new Date(AGORA + 6 * DIA).toISOString() }), AGORA)).toBe(true);
    expect(precisaReconectar(conta({ token_expira_em: new Date(AGORA - DIA).toISOString() }), AGORA)).toBe(true);
    expect(precisaReconectar(conta({ status: "erro", token_expira_em: null }), AGORA)).toBe(true);
  });

  it("volta ok do OAuth: avisa quantas contas e limpa a URL mantendo a aba", async () => {
    h.busca = "aba=sociais&meta_social=ok&n=2";
    window.history.replaceState(null, "", "/app/connections?aba=sociais&meta_social=ok&n=2");
    h.get.mockResolvedValue(estado({ instagram: true, messenger: true }));
    montar();
    expect((await screen.findByTestId("aviso-meta-social")).textContent).toContain(
      "2 contas conectadas. As novas mensagens passam a chegar no Chat.",
    );
    await waitFor(() => expect(window.location.search).toBe("?aba=sociais"));
  });

  it("volta com erro: explica o motivo em português claro", async () => {
    h.busca = "aba=sociais&meta_social=erro&motivo=conta_em_outra_organizacao";
    h.get.mockResolvedValue(estado({ instagram: true, messenger: true }));
    montar();
    const aviso = await screen.findByRole("alert");
    expect(aviso.textContent).toContain("Esta conta já está conectada em outra empresa neste sistema.");
  });

  it("motivo desconhecido cai na mensagem genérica, nunca no código cru", async () => {
    h.busca = "aba=sociais&meta_social=erro&motivo=xyz_novo";
    h.get.mockResolvedValue(estado({ instagram: true, messenger: true }));
    montar();
    const aviso = await screen.findByRole("alert");
    expect(aviso.textContent).toContain("Algo deu errado ao conectar.");
    expect(aviso.textContent).not.toContain("xyz_novo");
    expect(aviso.textContent).not.toContain("xyz_novo");
  });

  it("falha ao carregar mostra erro em vez de lista vazia", async () => {
    h.get.mockRejectedValue(new Error("boom"));
    montar();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Não foi possível carregar as redes sociais.",
    );
    expect(screen.queryByText("Nenhuma conta conectada.")).toBeNull();
  });
});

describe("volta com recusa parcial", () => {
  it("diz quantas Páginas entraram, quantas não e por quê", async () => {
    const { lerAviso } = await import("@/components/connections/RedesSociaisClient");
    const aviso = lerAviso(
      new URLSearchParams("meta_social=parcial&n=2&recusadas=1&motivo=limite_do_plano"),
      (s) => s,
    );
    expect(aviso).toMatchObject({ tipo: "parcial", limite: true });
    expect(aviso!.texto).toBe("2 contas conectadas; 1 não pôde ser conectada: Seu plano chegou ao limite de conexões.");
  });
});
