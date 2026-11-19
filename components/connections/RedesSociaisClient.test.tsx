import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RedesSociaisClient, precisaReconectar, type ContaSocial } from "./RedesSociaisClient";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  busca: "aba=sociais",
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: h.get, post: h.post, delete: h.delete } }));
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

describe("volta com várias contas: a escolha das páginas (D-242)", () => {
  const SELECAO = "/api/v1/channels/meta-social/selecao?plataforma=instagram";
  type Conta = { id: string; nome: string | null; usuario: string | null; ja_conectada_aqui: boolean; em_outra_empresa: boolean };
  const contaDaEscolha = (id: string, extra: Partial<Conta> = {}): Conta => ({
    id,
    nome: `Página ${id}`,
    usuario: null,
    ja_conectada_aqui: false,
    em_outra_empresa: false,
    ...extra,
  });

  function responder(contas: Conta[]) {
    h.get.mockImplementation(async (url: string) =>
      url === SELECAO
        ? { data: { plataforma: "instagram", expira_em: "2026-11-19T12:10:00Z", contas } }
        : estado({ instagram: true, messenger: true }),
    );
  }

  beforeEach(() => {
    h.busca = "aba=sociais&meta_social=escolher&plataforma=instagram";
    window.history.replaceState(null, "", `/app/connections?${h.busca}`);
  });

  it("abre o diálogo com nada marcado; Conectar desabilitado com 0; conta de outra empresa travada", async () => {
    responder([
      contaDaEscolha("101"),
      contaDaEscolha("102", { ja_conectada_aqui: true }),
      contaDaEscolha("103", { em_outra_empresa: true }),
    ]);
    montar();
    const dialogo = await screen.findByTestId("escolher-contas-meta");
    expect(within(dialogo).getByText("Escolha quais páginas conectar nesta empresa")).toBeInTheDocument();
    expect(
      within(dialogo).getByText(
        "Conecte só as páginas desta empresa. Páginas de outros clientes devem ser conectadas na empresa deles.",
      ),
    ).toBeInTheDocument();
    await within(dialogo).findByText("Página 101");
    const caixas = within(dialogo).getAllByRole("checkbox");
    expect(caixas).toHaveLength(3);
    for (const c of caixas) expect(c).not.toBeChecked();
    expect(within(dialogo).getByTestId("confirmar-contas-meta")).toBeDisabled();
    expect(within(dialogo).getByTestId("confirmar-contas-meta")).toHaveTextContent("Conectar 0");

    expect(within(dialogo).getByRole("checkbox", { name: "Página 103" })).toBeDisabled();
    expect(within(dialogo).getByText("Já conectada em outra empresa")).toBeInTheDocument();
    // A já conectada aqui pode ser marcada de novo (reconectar).
    expect(within(dialogo).getByRole("checkbox", { name: "Página 102" })).toBeEnabled();
    expect(within(dialogo).getByText("Já conectada aqui")).toBeInTheDocument();
    // Lista curta: sem busca.
    expect(within(dialogo).queryByRole("searchbox")).toBeNull();
    expect(h.get).toHaveBeenCalledWith(SELECAO);
  });

  it("conecta só as marcadas e mostra o mesmo aviso da volta", async () => {
    responder([contaDaEscolha("101"), contaDaEscolha("102")]);
    h.post.mockResolvedValue({ data: { conectadas: 1, recusadas: 0 } });
    montar();
    const dialogo = await screen.findByTestId("escolher-contas-meta");
    fireEvent.click(await within(dialogo).findByRole("checkbox", { name: "Página 102" }));
    const botao = within(dialogo).getByTestId("confirmar-contas-meta");
    expect(botao).toHaveTextContent("Conectar 1");
    expect(botao).toBeEnabled();
    fireEvent.click(botao);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(SELECAO, { ids: ["102"] }));
    const aviso = await screen.findByTestId("aviso-meta-social");
    expect(aviso).toHaveTextContent("Conta conectada. As novas mensagens passam a chegar no Chat.");
    await waitFor(() => expect(screen.queryByTestId("escolher-contas-meta")).toBeNull());
  });

  it("recusa parcial na confirmação vira o aviso parcial", async () => {
    responder([contaDaEscolha("101"), contaDaEscolha("102")]);
    h.post.mockResolvedValue({ data: { conectadas: 1, recusadas: 1, motivo: "limite_do_plano" } });
    montar();
    const dialogo = await screen.findByTestId("escolher-contas-meta");
    fireEvent.click(await within(dialogo).findByRole("checkbox", { name: "Página 101" }));
    fireEvent.click(within(dialogo).getByRole("checkbox", { name: "Página 102" }));
    fireEvent.click(within(dialogo).getByTestId("confirmar-contas-meta"));
    const aviso = await screen.findByTestId("aviso-meta-social");
    expect(aviso.getAttribute("data-tipo")).toBe("parcial");
    expect(aviso).toHaveTextContent("Seu plano chegou ao limite de conexões.");
  });

  it("Cancelar apaga a escolha no servidor e fecha, sem conectar", async () => {
    responder([contaDaEscolha("101"), contaDaEscolha("102")]);
    h.delete.mockResolvedValue({});
    montar();
    const dialogo = await screen.findByTestId("escolher-contas-meta");
    await within(dialogo).findByText("Página 101");
    fireEvent.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByTestId("escolher-contas-meta")).toBeNull());
    expect(h.delete).toHaveBeenCalledWith(SELECAO);
    expect(h.post).not.toHaveBeenCalled();
  });

  it("mais de 8 contas: a busca filtra pelo nome", async () => {
    responder(Array.from({ length: 10 }, (_, i) => contaDaEscolha(String(201 + i))));
    montar();
    const dialogo = await screen.findByTestId("escolher-contas-meta");
    await within(dialogo).findByText("Página 201");
    fireEvent.change(within(dialogo).getByRole("searchbox", { name: "Pesquisar páginas" }), {
      target: { value: "205" },
    });
    expect(within(dialogo).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(dialogo).getByText("Página 205")).toBeInTheDocument();
  });

  it("escolha vencida: explica e pede para conectar de novo", async () => {
    const { ApiError } = await import("@/lib/api/types");
    h.get.mockImplementation(async (url: string) => {
      if (url === SELECAO) throw new ApiError(410, "selecao_expirada", undefined, "r");
      return estado({ instagram: true, messenger: true });
    });
    montar();
    const dialogo = await screen.findByTestId("escolher-contas-meta");
    expect(
      await within(dialogo).findByText("A escolha das páginas expirou. Clique em Conectar de novo."),
    ).toBeInTheDocument();
    expect(within(dialogo).queryByTestId("confirmar-contas-meta")).toBeNull();
  });
});
