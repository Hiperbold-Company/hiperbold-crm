import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ação "Abrir conversa" no card do funil (issue #1993).
 *
 * ─── O que os três casos prendem ────────────────────────────────────────────
 *
 * 1. Conversa JÁ vinculada ao contato: o clique leva para ELA — o endpoint
 *    `open-with-contact` não é chamado, porque chamá-lo reabriria (ou pior,
 *    recriaria) uma conversa que já existe. Quem decide é o `href`.
 * 2. Lead sem conversa (o caso do webhook): o clique chama a MESMA rota que a
 *    tabela de contatos já usa, navega para a conversa que ela devolve, e fica
 *    desabilitado enquanto a rota não responde — sem ele, um duplo clique
 *    abriria duas conversas.
 * 3. Lead sem telefone: nenhum pedido sai do navegador, e o motivo fica visível
 *    na própria linha. Um botão que falha em silêncio é pior que nenhum botão.
 */
const push = vi.hoisted(() => vi.fn());
// A conversa abre em NOVA aba: a aba nasce no clique e recebe o destino depois.
const abaNova = { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
const openMock = vi.fn(() => abaNova);
const toastError = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }));

import { ConversaSlot } from "./ConversaSlot";
import { ConversaNoDossie } from "./ConversaNoDossie";

const fetchMock = vi.fn();
/** Só o POST de abrir conversa; a leitura das opções responde à parte. */
const postMock = vi.fn();
/** O que `GET …/opcoes` devolve — padrão: quem clica não tem conexão vinculada. */
let falharLeitura = false;
let opcoesDaVez: unknown = {
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

const conversa = {
  id: "conv-1",
  preview: "Quero saber o preço",
  last_message_at: "2026-10-01T12:00:00Z",
  unread: 0,
};

function montar(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  fetchMock.mockReset();
  postMock.mockReset();
  opcoesDaVez = {
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
  falharLeitura = false;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/open-with-contact/opcoes")) {
      // A leitura "das minhas conexões" (sem `?`) não falha; a da hora do clique, sim.
      if (falharLeitura && u.includes("?")) return Promise.resolve({ ok: false, json: async () => ({}) });
      return Promise.resolve({ ok: true, json: async () => ({ data: opcoesDaVez }) });
    }
    return postMock(url, init);
  });
  push.mockReset();
  toastError.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  openMock.mockClear();
  abaNova.location.href = "";
  abaNova.opener = {};
  abaNova.close.mockReset();
  vi.spyOn(window, "open").mockImplementation(openMock as unknown as typeof window.open);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Abrir conversa no card do funil (#1993)", () => {
  it("com conversa já vinculada e sem conexão vinculada a quem clica, o clique leva para ELA — nenhum POST", async () => {
    montar(<ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/app/inbox?id=conv-1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    // O gesto completo: nem a rota de abrir conversa nem a navegação programada
    // entram — o destino é o elo que já existia.
    fireEvent.click(link);
    await waitFor(() => expect(abaNova.location.href).toBe("/app/inbox?id=conv-1"));
    expect(postMock).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("sem conversa, o clique abre pela rota existente, espera a resposta e navega", async () => {
    const user = userEvent.setup();
    let liberar: (r: unknown) => void = () => {};
    postMock.mockReturnValue(
      new Promise((res) => {
        liberar = res;
      }),
    );

    montar(<ConversaSlot conversa={null} contactId="contato-1" phone="+5581999999999" />);

    await user.click(screen.getByRole("button", { name: /Abrir conversa/ }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith(
      "/api/v1/conversations/open-with-contact",
      expect.objectContaining({ method: "POST" }),
    );
    const init = postMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const corpo = JSON.parse(String(init?.body ?? ""));
    expect(corpo).toEqual({ contact_id: "contato-1", phone_number: "+5581999999999" });

    // Enquanto a rota não responde o botão está carregando — e DESABILITADO,
    // senão um segundo clique pediria uma segunda conversa.
    const durante = screen.getByRole("button", { name: /Abrindo/ });
    expect(durante).toBeDisabled();

    liberar({ ok: true, json: async () => ({ data: { conversation_id: "conv-nova" } }) });
    await waitFor(() => expect(abaNova.location.href).toBe("/app/inbox?id=conv-nova"));
    expect(openMock).toHaveBeenCalledWith("", "_blank");
    expect(abaNova.opener).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("sem telefone, não chama a API e explica o motivo na linha", async () => {
    montar(<ConversaSlot conversa={null} contactId="contato-1" phone={null} />);

    const botao = screen.getByRole("button", { name: /Abrir conversa/ });
    expect(botao).toBeDisabled();
    expect(screen.getByText(/sem telefone/)).toBeInTheDocument();
    expect(String(botao.getAttribute("title"))).toMatch(/telefone/i);

    // Nem o clique que o jsdom ainda entrega num botão desabilitado pode pôr a
    // mão no telefone: a guarda é do handler, não só do atributo.
    fireEvent.click(botao);
    // A leitura das "minhas conexões" da tela pode sair; a do clique e o POST, não.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("?"))).toHaveLength(0);
    expect(postMock).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("sem conversa e sem contato nenhum, a linha continua vazia (card não cresce à toa)", () => {
    const { container } = render(<ConversaSlot conversa={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Abrir conversa no painel do lead, sem conversa ainda", () => {
  const resposta = { ok: true, json: async () => ({ data: { conversation_id: "conv-nova" } }) };

  it("o botão largo abre a conversa NESTA aba", async () => {
    const user = userEvent.setup();
    postMock.mockResolvedValue(resposta);
    montar(<ConversaNoDossie conversa={null} contactId="contato-1" phone="+5581999999999" />);

    await user.click(screen.getByRole("button", { name: /Abrir conversa no Chat do CRM/ }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/inbox?id=conv-nova"));
    expect(openMock).not.toHaveBeenCalled();
  });

  it("o botão de ícone abre a MESMA conversa numa nova aba", async () => {
    const user = userEvent.setup();
    postMock.mockResolvedValue(resposta);
    montar(<ConversaNoDossie conversa={null} contactId="contato-1" phone="+5581999999999" />);

    await user.click(screen.getByRole("button", { name: "Abrir conversa em nova aba" }));

    expect(openMock).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(abaNova.location.href).toBe("/app/inbox?id=conv-nova"));
    expect(push).not.toHaveBeenCalled();
  });

  it("sem telefone, o botão de ícone nem aparece", () => {
    montar(<ConversaNoDossie conversa={null} contactId="contato-1" phone={null} />);
    expect(screen.queryByRole("button", { name: "Abrir conversa em nova aba" })).toBeNull();
  });
});

/**
 * Pela conexão de QUEM CLICA (16/11/2026): o card não leva mais direto à
 * conversa da prévia quando ela está na conexão de outra atendente.
 */
describe("Abrir conversa pela conexão de quem clica", () => {
  const MINHA = { id: "sess-rosana", nome: "Rosana Comercial", conectada: true };
  const DA_INGRID = {
    conversation_id: "conv-1",
    channel_session_id: "sess-ingrid",
    conexao_nome: "Ingrid Müller",
    conexao_de_outro: true,
    aberta_e_minha: false,
  };
  const comMinha = (extra: Record<string, unknown> = {}) => ({
    modo: "choose",
    restrito: false,
    minha_conexao: MINHA,
    minhas_conexoes_ids: [MINHA.id],
    conexao_geral: null,
    conexoes_com_responsavel_ids: [MINHA.id, "sess-ingrid"],
    conversas: [DA_INGRID],
    contato_em_conexao_de_outro: true,
    transferido_para_mim: false,
    ...extra,
  });
  const leituraDoClique = () =>
    fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/opcoes?"));
  const criada = { ok: true, json: async () => ({ data: { conversation_id: "conv-nova" } }) };

  it("conversa já na MINHA conexão → abre ela, sem janela e sem POST", async () => {
    opcoesDaVez = comMinha({
      conversas: [DA_INGRID, { ...DA_INGRID, conversation_id: "conv-minha", channel_session_id: MINHA.id, conexao_de_outro: false }],
    });
    montar(<ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" leadId="lead-1" />);
    fireEvent.click(screen.getByRole("link"));

    await waitFor(() => expect(abaNova.location.href).toBe("/app/inbox?id=conv-minha"));
    expect(screen.queryByTestId("janela-de-conexao")).toBeNull();
    expect(postMock).not.toHaveBeenCalled();
    expect(leituraDoClique()[0]).toContain("contact_id=contato-1");
    expect(leituraDoClique()[0]).toContain("lead_id=lead-1");
  });

  it("só em OUTRA conexão → janela com os NOMES das conexões, a minha já marcada; confirmar inicia por ela", async () => {
    const user = userEvent.setup();
    opcoesDaVez = comMinha();
    postMock.mockResolvedValue(criada);
    montar(<ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />);
    fireEvent.click(screen.getByRole("link"));

    await screen.findByTestId("janela-de-conexao");
    // A aba aberta no primeiro clique fecha: quem decide agora é a janela.
    expect(abaNova.close).toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Iniciar pela conexão Rosana Comercial" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Continuar na conexão Ingrid Müller" })).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "Abrir conversa" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const corpo = JSON.parse(String((postMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(corpo).toMatchObject({ contact_id: "contato-1", channel_session_id: MINHA.id });
    await waitFor(() => expect(abaNova.location.href).toBe("/app/inbox?id=conv-nova"));
  });

  it("contato com várias conversas em outras conexões → uma opção por conexão", async () => {
    opcoesDaVez = comMinha({
      conversas: [DA_INGRID, { ...DA_INGRID, conversation_id: "conv-geral", channel_session_id: "sess-geral", conexao_nome: "Número geral", conexao_de_outro: false }],
    });
    montar(<ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />);
    fireEvent.click(screen.getByRole("link"));
    await screen.findByTestId("janela-de-conexao");
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Continuar na conexão Número geral" })).toBeInTheDocument();
  });

  it("na janela, 'Continuar na conexão' abre a conversa existente, sem POST", async () => {
    const user = userEvent.setup();
    opcoesDaVez = comMinha();
    montar(<ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />);
    fireEvent.click(screen.getByRole("link"));
    await screen.findByTestId("janela-de-conexao");

    await user.click(screen.getByRole("radio", { name: "Continuar na conexão Ingrid Müller" }));
    await user.click(screen.getByRole("button", { name: "Abrir conversa" }));
    await waitFor(() => expect(abaNova.location.href).toBe("/app/inbox?id=conv-1"));
    expect(postMock).not.toHaveBeenCalled();
  });

  it("minha conexão desconectada → a janela avisa", async () => {
    opcoesDaVez = comMinha({ minha_conexao: { ...MINHA, conectada: false } });
    montar(<ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />);
    fireEvent.click(screen.getByRole("link"));
    expect(await screen.findByTestId("aviso-conexao-desconectada")).toBeInTheDocument();
  });

  it("modo 'só a conexão própria', contato da colega → não abre nada e explica (sem nome de conexão)", async () => {
    opcoesDaVez = comMinha({ modo: "own_only", restrito: true, conversas: [] });
    montar(<ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />);
    fireEvent.click(screen.getByRole("link"));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toContain("outro atendente");
    expect(abaNova.close).toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("janela-de-conexao")).toBeNull();
  });

  it("modo 'só a conexão própria', transferido para mim → inicia pela minha, sem janela", async () => {
    opcoesDaVez = comMinha({ modo: "own_only", restrito: true, transferido_para_mim: true });
    postMock.mockResolvedValue(criada);
    montar(<ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />);
    fireEvent.click(screen.getByRole("link"));

    await waitFor(() => expect(abaNova.location.href).toBe("/app/inbox?id=conv-nova"));
    const corpo = JSON.parse(String((postMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(corpo.channel_session_id).toBe(MINHA.id);
    expect(screen.queryByTestId("janela-de-conexao")).toBeNull();
  });

  it("conversa de rede social (Instagram) → elo direto, sem leitura nem POST", () => {
    opcoesDaVez = comMinha();
    montar(
      <ConversaSlot conversa={{ ...conversa, provider: "meta_social" }} contactId="contato-1" phone="+5581999999999" />,
    );
    const link = screen.getByRole("link");
    fireEvent.click(link);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
    expect(link).toHaveAttribute("href", "/app/inbox?id=conv-1");
  });

  it("falha da leitura, para quem TEM conexão vinculada → não navega e avisa", async () => {
    opcoesDaVez = comMinha();
    falharLeitura = true;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />
      </QueryClientProvider>,
    );
    // A leitura das "minhas conexões" chegou antes do clique.
    await waitFor(() => expect(qc.getQueryData(["minhas-conexoes"])).toBeDefined());
    fireEvent.click(screen.getByRole("link"));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Não foi possível conferir a conexão. Tente de novo."));
    expect(abaNova.close).toHaveBeenCalled();
    expect(abaNova.location.href).toBe("");
    expect(postMock).not.toHaveBeenCalled();
  });

  it("falha da leitura, para quem NÃO tem conexão vinculada → como antes", async () => {
    falharLeitura = true;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(qc.getQueryData(["minhas-conexoes"])).toBeDefined());
    fireEvent.click(screen.getByRole("link"));
    await waitFor(() => expect(abaNova.location.href).toBe("/app/inbox?id=conv-1"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("duplo clique rápido → UMA leitura, UMA aba", async () => {
    let liberar: (r: unknown) => void = () => {};
    opcoesDaVez = comMinha({ conversas: [] , contato_em_conexao_de_outro: false });
    postMock.mockReturnValue(new Promise((res) => (liberar = res)));
    montar(<ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />);
    const link = screen.getByRole("link");
    fireEvent.click(link);
    fireEvent.click(link);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(leituraDoClique()).toHaveLength(1);
    liberar(criada);
    await waitFor(() => expect(abaNova.location.href).toBe("/app/inbox?id=conv-nova"));
  });

  it("Ctrl-clique e clique do meio passam pelo mesmo fluxo", async () => {
    opcoesDaVez = comMinha();
    montar(<ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />);
    fireEvent.click(screen.getByRole("link"), { ctrlKey: true });
    await screen.findByTestId("janela-de-conexao");
    expect(leituraDoClique()).toHaveLength(1);
  });

  it("clique do meio também", async () => {
    opcoesDaVez = comMinha();
    montar(<ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />);
    fireEvent(screen.getByRole("link"), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await screen.findByTestId("janela-de-conexao");
  });

  it("sem conversa ainda e com conexão vinculada → nasce na MINHA conexão", async () => {
    const user = userEvent.setup();
    opcoesDaVez = comMinha({ conversas: [], contato_em_conexao_de_outro: false });
    postMock.mockResolvedValue(criada);
    montar(<ConversaSlot conversa={null} contactId="contato-1" phone="+5581999999999" />);
    await user.click(screen.getByRole("button", { name: /Abrir conversa/ }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const corpo = JSON.parse(String((postMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(corpo.channel_session_id).toBe(MINHA.id);
  });

  it("só telefone, sem contato: a leitura vai pelo telefone", async () => {
    const user = userEvent.setup();
    postMock.mockResolvedValue(criada);
    montar(<ConversaSlot conversa={null} phone="+5581999999999" />);
    await user.click(screen.getByRole("button", { name: /Abrir conversa/ }));
    await waitFor(() => expect(leituraDoClique()).toHaveLength(1));
    expect(leituraDoClique()[0]).toContain("phone=%2B5581999999999");
  });

  it("ficha do negócio: com conversa na outra conexão, o botão largo também abre a janela", async () => {
    opcoesDaVez = comMinha();
    montar(<ConversaNoDossie conversa={conversa} contactId="contato-1" phone="+5581999999999" />);
    fireEvent.click(screen.getByRole("link", { name: /Abrir conversa no Chat do CRM/ }));
    expect(await screen.findByTestId("janela-de-conexao")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("tela de contato (sem contactId): o bloco segue como elo direto, sem leitura", () => {
    montar(<ConversaNoDossie conversa={conversa} />);
    fireEvent.click(screen.getByRole("link", { name: /Abrir conversa no Chat do CRM/ }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
