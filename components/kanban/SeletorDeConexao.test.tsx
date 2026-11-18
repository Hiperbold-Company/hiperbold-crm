import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O seletor de conexão do painel do negócio (18/11/2026): nasce marcado com a conexão de que
 * quem está logado é o membro responsável, e o clique em "Abrir conversa no Chat do CRM" leva o
 * `channel_session_id` dela ao POST (que reaproveita a conversa do contato naquela conexão). Em
 * "Automático", o caminho de antes.
 */
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { ConversaNoDossie } from "./ConversaNoDossie";

const postMock = vi.fn();
let opcoes: Record<string, unknown>;

const BASE = {
  modo: "choose",
  restrito: false,
  minha_conexao: null,
  minhas_conexoes_ids: [],
  conexao_geral: null,
  conexoes_com_responsavel_ids: [],
  conversas: [],
  contato_em_conexao_de_outro: false,
  transferido_para_mim: false,
};
const SELETOR = {
  conexoes_do_seletor: [
    { id: "geral", nome: "Número geral", conectada: true },
    { id: "ingrid-1", nome: "Ingrid 1", conectada: false },
    { id: "ingrid-2", nome: "Ingrid 2", conectada: true },
  ],
  vinculadas_a_mim_ids: ["ingrid-1", "ingrid-2"],
};

function montar(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  push.mockReset();
  postMock.mockReset();
  postMock.mockResolvedValue({ ok: true, json: async () => ({ data: { conversation_id: "conv-nova" } }) });
  opcoes = { ...BASE, ...SELETOR };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) =>
      String(url).includes("/open-with-contact/opcoes")
        ? Promise.resolve({ ok: true, json: async () => ({ data: opcoes }) })
        : postMock(url, init),
    ),
  );
});

afterEach(() => vi.unstubAllGlobals());

const corpoDoPost = () => JSON.parse(String((postMock.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;

describe("Seletor de conexão no painel do negócio", () => {
  it("lead sem conversa: nasce na primeira conexão CONECTADA vinculada a mim, e o POST vai por ela", async () => {
    montar(<ConversaNoDossie conversa={null} contactId="contato-1" phone="+5581999999999" leadId="lead-1" />);
    const seletor = await screen.findByTestId("seletor-de-conexao");
    await waitFor(() => expect(seletor).toHaveValue("ingrid-2"));
    expect(screen.getByRole("option", { name: "Ingrid 1 (desconectada)" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Abrir conversa no Chat do CRM/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/inbox?id=conv-nova"));
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(corpoDoPost()).toMatchObject({ contact_id: "contato-1", channel_session_id: "ingrid-2", lead_id: "lead-1" });
  });

  it("com conversa: a escolha manual vale, e o POST reaproveita a conversa naquela conexão", async () => {
    montar(
      <ConversaNoDossie
        conversa={{ id: "conv-1", preview: "Oi", last_message_at: "2026-10-01T12:00:00Z", unread: 0 }}
        contactId="contato-1"
        phone="+5581999999999"
      />,
    );
    const seletor = await screen.findByTestId("seletor-de-conexao");
    fireEvent.change(seletor, { target: { value: "geral" } });
    fireEvent.click(screen.getByRole("link", { name: /Abrir conversa no Chat do CRM/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/inbox?id=conv-nova"));
    expect(corpoDoPost()).toMatchObject({ channel_session_id: "geral" });
  });

  it("sem conexão vinculada: fica em Automático e segue o caminho de antes (sem channel_session_id)", async () => {
    opcoes = { ...BASE, ...SELETOR, vinculadas_a_mim_ids: [] };
    montar(<ConversaNoDossie conversa={null} contactId="contato-1" phone="+5581999999999" />);
    const seletor = await screen.findByTestId("seletor-de-conexao");
    expect(seletor).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: /Abrir conversa no Chat do CRM/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(corpoDoPost()).not.toHaveProperty("channel_session_id");
  });

  it("resposta sem os campos do seletor: nenhum seletor na tela", async () => {
    opcoes = { ...BASE };
    montar(<ConversaNoDossie conversa={null} contactId="contato-1" phone="+5581999999999" />);
    await screen.findByRole("button", { name: /Abrir conversa no Chat do CRM/ });
    expect(screen.queryByTestId("seletor-de-conexao")).toBeNull();
  });
});
