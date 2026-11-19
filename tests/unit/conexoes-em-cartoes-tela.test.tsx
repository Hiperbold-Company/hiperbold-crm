/**
 * Tela de Conexões em cartões (decisão do dono do produto, 17/11/2026).
 *
 * A fronteira mockada é a REDE (`apiClient`) e o roteador do Next: a grade, a busca, o Criar e o
 * Gerenciar rodam de verdade, com os hooks reais de conexões, canal oficial e modelos. Só peças
 * vizinhas que falam com outras rotas (acesso da IA, renomear, QR) viram marcadores.
 *
 * Roda com: pnpm vitest run tests/unit/conexoes-em-cartoes-tela.test.tsx
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CartaoDaConexao } from "@/lib/channels/conexoes-em-cartoes";

const h = vi.hoisted(() => ({
  busca: "",
  adminDaPlataforma: false,
  conexoes: [] as unknown[],
  get: vi.fn(),
  replace: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  falharOficial: false,
  webhookDoQr: true,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.busca),
  usePathname: () => "/app/connections",
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { is_platform_admin: h.adminDaPlataforma, support: null } }),
  usePermission: () => true,
}));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: h.get, post: vi.fn(async () => ({ data: {} })), delete: vi.fn(async () => ({})) },
}));
vi.mock("@/components/connections/ChannelAiAccess", () => ({ ChannelAiAccess: () => null }));
vi.mock("@/components/connections/RenomearConexao", () => ({ RenomearConexao: () => <button>Renomear</button> }));
vi.mock("@/components/connections/ReconectarConexao", () => ({
  ReconectarConexao: ({ conexaoId, abrirAoMontar }: { conexaoId: string; abrirAoMontar?: boolean }) => (
    <div data-testid="reconectar" data-conexao={conexaoId} data-abre-sozinho={String(Boolean(abrirAoMontar))} />
  ),
}));
// O Criar monta os componentes de conectar de cada tipo; aqui só importa QUAIS tipos ele oferece.
vi.mock("@/components/connections/ConectarComAMeta", () => ({ ConectarComAMeta: () => <div>conectar-meta</div> }));
vi.mock("@/components/connections/CanalInstanciaClient", () => ({
  CanalInstanciaClient: ({ servidorProprio }: { servidorProprio?: boolean }) => (
    <div>conectar-qr:{String(servidorProprio)}</div>
  ),
}));
vi.mock("@/components/connections/RedesSociaisClient", async (original) => ({
  ...((await original()) as object),
  RedesSociaisClient: () => <div>conectar-sociais</div>,
}));
vi.mock("@/components/connections/CanalParceiroClient", () => ({ CanalParceiroClient: () => null }));
vi.mock("@/components/connections/CanalGraphParceiroClient", () => ({ CanalGraphParceiroClient: () => null }));
vi.mock("@/components/connections/CanalVozClient", () => ({ CanalVozClient: () => null }));
vi.mock("@/components/connections/TelefoniaClient", () => ({ TelefoniaClient: () => null }));

import { ConexoesShell } from "@/components/connections/ConexoesShell";

function cartao(parcial: Partial<CartaoDaConexao> & Pick<CartaoDaConexao, "id" | "tipo">): CartaoDaConexao {
  return {
    provider: "x",
    via: null,
    nome: null,
    numero_ou_handle: null,
    status: "conectado",
    status_bruto: "WORKING",
    pareamento: null,
    created_at: "2026-11-17T00:00:00Z",
    oficial: null,
    ...parcial,
  };
}

const OFICIAL = cartao({
  id: "11111111-1111-4111-8111-111111111111",
  tipo: "whatsapp_oficial",
  via: "meta",
  nome: "Comercial",
  numero_ou_handle: "+55 11 90000-0001",
  oficial: { waba_id: "WABA1", meta_phone_number_id: "PN1", webhook_registrado: true },
});
const QR = cartao({
  id: "22222222-2222-4222-8222-222222222222",
  tipo: "whatsapp_qr",
  nome: "Suporte",
  numero_ou_handle: "+55 11 90000-0002",
  status: "desconectado",
  status_bruto: "SCAN_QR_CODE",
});
const INSTAGRAM = cartao({
  id: "33333333-3333-4333-8333-333333333333",
  tipo: "instagram",
  nome: "Loja",
  numero_ou_handle: "@loja",
  status: "precisa_atencao",
});

const ESTADO_OFICIAL = {
  channel_session_id: OFICIAL.id,
  connected: true,
  hasToken: true,
  phoneNumberId: "PN1",
  wabaId: "WABA1",
  endpoint: "https://crm.exemplo.com/api/v1",
  displayName: "Comercial",
  labelColor: null,
  phoneNumber: "+55 11 90000-0001",
  status: "WORKING",
  webhook: {
    callbackUrl: "https://crm.exemplo.com/api/v1/webhooks/meta/abc",
    verifyToken: "segredo-de-verificacao",
    fields: ["messages"],
  },
  webhookRegistro: { registrado: true, url: "https://crm.exemplo.com/x", erro: null, em: "2026-11-17T00:00:00Z" },
};

function responder(path: string): unknown {
  if (path === "/api/v1/channels/conexoes") return { data: h.conexoes };
  if (path === "/api/v1/channels/meta-social/selecao?plataforma=instagram") {
    return {
      data: {
        plataforma: "instagram",
        expira_em: "2026-11-19T12:10:00Z",
        contas: [
          { id: "17841400000000001", nome: null, usuario: "loja", ja_conectada_aqui: false, em_outra_empresa: false },
          { id: "17841400000000002", nome: null, usuario: "outra", ja_conectada_aqui: false, em_outra_empresa: false },
        ],
      },
    };
  }
  if (path === `/api/v1/channels/official?id=${OFICIAL.id}`) {
    if (h.falharOficial) throw new Error("falhou");
    return { data: ESTADO_OFICIAL };
  }
  if (path.startsWith("/api/v1/channels/official/numero")) return { data: { disponivel: false, motivo: "x" } };
  if (path === `/api/v1/channels/templates?channel_session_id=${OFICIAL.id}`) {
    return {
      data: {
        waba: "WABA1",
        templates: [
          {
            name: "boas_vindas",
            language: "pt_BR",
            status: "APPROVED",
            category: "MARKETING",
            rejectedReason: null,
            qualityScore: null,
            parameterFormat: "positional",
            contractHash: "h",
            syncedAt: "2026-11-17T00:00:00Z",
            slots: [],
            previews: [],
            components: [],
            savedValues: {},
            daConexao: true,
          },
        ],
      },
    };
  }
  if (path === "/api/v1/channels/instancia") {
    return {
      data: {
        label: "Instância",
        conexoes: [
          {
            id: QR.id,
            display_name: "Suporte",
            label_color: null,
            phone_number: "+55 11 90000-0002",
            status: "SCAN_QR_CODE",
            servidor: "srv",
            webhook_registrado: h.webhookDoQr,
          },
        ],
      },
    };
  }
  throw new Error(`rota inesperada no teste: ${path}`);
}

let qcAtual: QueryClient | null = null;
function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qcAtual = qc;
  return render(
    <QueryClientProvider client={qc}>
      <ConexoesShell wahaConfigured={false} wacallsConfigured={false} redesSociaisLiberadas />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.busca = "";
  h.adminDaPlataforma = false;
  h.conexoes = [OFICIAL, QR, INSTAGRAM];
  h.get.mockReset();
  h.get.mockImplementation(async (path: string) => responder(path));
  h.replace.mockReset();
  h.falharOficial = false;
  h.webhookDoQr = true;
  Object.values(h.toast).forEach((f) => f.mockReset());
});

afterEach(() => cleanup());

describe("grade de cartões", () => {
  it("um cartão por conexão, com status, tipo e nome", async () => {
    montar();
    const oficial = await screen.findByTestId(`cartao-conexao-${OFICIAL.id}`);
    expect(within(oficial).getByTestId("tipo-da-conexao").textContent).toBe("WhatsApp API Oficial");
    expect(within(oficial).getByTestId("nome-da-conexao").textContent).toBe("Comercial");
    expect(within(oficial).getByText("+55 11 90000-0001")).toBeInTheDocument();
    expect(within(oficial).getByTestId("status-da-conexao").textContent).toBe("Conectado");

    const qr = screen.getByTestId(`cartao-conexao-${QR.id}`);
    expect(within(qr).getByTestId("tipo-da-conexao").textContent).toBe("UAZAPI (API não oficial)");
    expect(within(qr).getByTestId("status-da-conexao").textContent).toBe("Desconectado");

    const ig = screen.getByTestId(`cartao-conexao-${INSTAGRAM.id}`);
    expect(within(ig).getByTestId("tipo-da-conexao").textContent).toBe("Instagram");
    expect(within(ig).getByTestId("status-da-conexao").textContent).toBe("Precisa de atenção");

    expect(screen.getByTestId("contador-conexoes").textContent).toBe("3 resultados");
    expect(within(oficial).getByRole("button", { name: /Gerenciar/ })).toBeInTheDocument();
  });

  it("oficial por parceiro ganha o '(parceiro)' no título", async () => {
    h.conexoes = [cartao({ id: "44444444-4444-4444-8444-444444444444", tipo: "whatsapp_oficial", via: "parceiro", nome: "Vendas" })];
    montar();
    const c = await screen.findByTestId("cartao-conexao-44444444-4444-4444-8444-444444444444");
    expect(within(c).getByTestId("tipo-da-conexao").textContent).toBe("WhatsApp oficial (parceiro)");
  });

  it("a busca filtra por nome, número e tipo, e o contador acompanha", async () => {
    montar();
    await screen.findByTestId(`cartao-conexao-${OFICIAL.id}`);
    const busca = screen.getByTestId("busca-conexoes");

    fireEvent.change(busca, { target: { value: "suporte" } });
    expect(screen.queryByTestId(`cartao-conexao-${OFICIAL.id}`)).toBeNull();
    expect(screen.getByTestId(`cartao-conexao-${QR.id}`)).toBeInTheDocument();
    expect(screen.getByTestId("contador-conexoes").textContent).toBe("1 resultado");

    fireEvent.change(busca, { target: { value: "90000-0001" } });
    expect(screen.getByTestId(`cartao-conexao-${OFICIAL.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`cartao-conexao-${QR.id}`)).toBeNull();

    fireEvent.change(busca, { target: { value: "instagram" } });
    expect(screen.getByTestId(`cartao-conexao-${INSTAGRAM.id}`)).toBeInTheDocument();
    expect(screen.getByTestId("contador-conexoes").textContent).toBe("1 resultado");

    fireEvent.change(busca, { target: { value: "nada-a-ver" } });
    expect(screen.getByTestId("conexoes-sem-resultado")).toBeInTheDocument();
    expect(screen.getByTestId("contador-conexoes").textContent).toBe("0 resultados");
  });

  it("sem conexão nenhuma: estado vazio com Criar", async () => {
    h.conexoes = [];
    montar();
    const vazio = await screen.findByTestId("conexoes-vazio");
    fireEvent.click(within(vazio).getByRole("button", { name: /Criar/ }));
    expect(await screen.findByTestId("criar-conexao")).toBeInTheDocument();
  });
});

describe("Criar", () => {
  it("abre o diálogo com os tipos e troca o conteúdo pelo tipo escolhido", async () => {
    montar();
    fireEvent.click(screen.getByTestId("btn-criar-conexao"));
    await screen.findByTestId("criar-conexao");
    for (const tipo of ["whatsapp_oficial", "whatsapp_qr", "instagram", "messenger"]) {
      expect(screen.getByTestId(`criar-tipo-${tipo}`)).toBeInTheDocument();
    }
    expect(screen.getByText("conectar-meta")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("criar-tipo-whatsapp_qr"));
    // Servidor e token da instância: só para o administrador da plataforma.
    expect(screen.getByText("conectar-qr:false")).toBeInTheDocument();
  });

  it("QR para o administrador da plataforma: oferece servidor e token", async () => {
    h.adminDaPlataforma = true;
    montar();
    fireEvent.click(screen.getByTestId("btn-criar-conexao"));
    fireEvent.click(await screen.findByTestId("criar-tipo-whatsapp_qr"));
    expect(screen.getByText("conectar-qr:true")).toBeInTheDocument();
  });

  it("credenciais à mão da oficial: só o administrador da plataforma vê", async () => {
    montar();
    fireEvent.click(screen.getByTestId("btn-criar-conexao"));
    await screen.findByTestId("criar-conexao");
    expect(screen.queryByTestId("criar-oficial-credenciais")).toBeNull();
    cleanup();

    h.adminDaPlataforma = true;
    montar();
    fireEvent.click(screen.getByTestId("btn-criar-conexao"));
    await screen.findByTestId("criar-conexao");
    expect(screen.getByTestId("criar-oficial-credenciais").textContent).toContain(
      "Conectar com credenciais (avançado)",
    );
  });
});

describe("Gerenciar da oficial", () => {
  async function abrirGerenciarDaOficial() {
    montar();
    fireEvent.click(await screen.findByTestId(`gerenciar-${OFICIAL.id}`));
    return screen.findByTestId("gerenciar-conexao");
  }

  it("cliente comum: templates da conta pelo id, e nada de webhook, callback ou endpoint", async () => {
    const dialogo = await abrirGerenciarDaOficial();
    await within(dialogo).findByTestId("gerenciar-bloco-comum");
    expect(h.get).toHaveBeenCalledWith(`/api/v1/channels/official?id=${OFICIAL.id}`);

    expect(within(dialogo).queryByTestId("gerenciar-avancado")).toBeNull();
    const texto = dialogo.textContent ?? "";
    expect(texto).not.toMatch(/webhook/i);
    expect(texto).not.toContain("URL de callback");
    expect(texto).not.toContain("Endpoint");
    expect(texto).not.toContain(ESTADO_OFICIAL.webhook.callbackUrl);

    const aba = within(dialogo).getByRole("tab", { name: "Templates da Meta" });
    fireEvent.mouseDown(aba);
    fireEvent.click(aba);
    expect(await within(dialogo).findByText("boas_vindas")).toBeInTheDocument();
    expect(h.get).toHaveBeenCalledWith(`/api/v1/channels/templates?channel_session_id=${OFICIAL.id}`);
  });

  it("administrador da plataforma: o bloco Avançado, fechado, com webhook e dados para integrar", async () => {
    h.adminDaPlataforma = true;
    const dialogo = await abrirGerenciarDaOficial();
    const avancado = await within(dialogo).findByTestId("gerenciar-avancado");
    expect(avancado.tagName).toBe("DETAILS");
    expect((avancado as HTMLDetailsElement).open).toBe(false);
    expect(within(avancado).getByText("URL de callback")).toBeInTheDocument();
    expect(within(avancado).getByText(ESTADO_OFICIAL.webhook.callbackUrl)).toBeInTheDocument();
    expect(within(avancado).getByText("Endpoint da API")).toBeInTheDocument();
  });
});

describe("?reconectar=<id>", () => {
  it("abre o Gerenciar daquela conexão, com o QR abrindo sozinho", async () => {
    h.busca = `reconectar=${QR.id}`;
    montar();
    const dialogo = await screen.findByTestId("gerenciar-conexao");
    const reconectar = await within(dialogo).findByTestId("reconectar");
    expect(reconectar.getAttribute("data-conexao")).toBe(QR.id);
    expect(reconectar.getAttribute("data-abre-sozinho")).toBe("true");
    expect(within(dialogo).getByText("Suporte", { selector: "h2" })).toBeInTheDocument();
  });

  it("id que não é desta lista não abre nada e avisa", async () => {
    h.busca = "reconectar=99999999-9999-4999-8999-999999999999";
    montar();
    await screen.findByTestId(`cartao-conexao-${OFICIAL.id}`);
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith("Conexão não encontrada."));
    expect(screen.queryByTestId("gerenciar-conexao")).toBeNull();
  });

  it("chega com a tela JÁ aberta (a faixa do topo): a URL nova abre o Gerenciar", async () => {
    const { rerender } = montar();
    await screen.findByTestId(`cartao-conexao-${QR.id}`);
    expect(screen.queryByTestId("gerenciar-conexao")).toBeNull();
    h.busca = `reconectar=${QR.id}`;
    rerender(
      <QueryClientProvider client={qcAtual!}>
        <ConexoesShell wahaConfigured={false} wacallsConfigured={false} redesSociaisLiberadas />
      </QueryClientProvider>,
    );
    const dialogo = await screen.findByTestId("gerenciar-conexao");
    expect((await within(dialogo).findByTestId("reconectar")).getAttribute("data-conexao")).toBe(QR.id);
  });
});

describe("Gerenciar da conexão por QR", () => {
  it("o aviso de endereço público do CRM é só do administrador da plataforma", async () => {
    h.webhookDoQr = false;
    montar();
    fireEvent.click(await screen.findByTestId(`gerenciar-${QR.id}`));
    const dialogo = await screen.findByTestId("gerenciar-conexao");
    await within(dialogo).findByTestId("gerenciar-bloco-comum");
    expect(dialogo.textContent).not.toContain("endereço público");
    cleanup();

    h.adminDaPlataforma = true;
    montar();
    fireEvent.click(await screen.findByTestId(`gerenciar-${QR.id}`));
    const outro = await screen.findByTestId("gerenciar-conexao");
    await within(outro).findByTestId("gerenciar-bloco-comum");
    expect(outro.textContent).toContain("endereço público");
  });
});

describe("Gerenciar da oficial com falha", () => {
  it("a leitura falhou: avisa e oferece tentar de novo", async () => {
    h.falharOficial = true;
    montar();
    fireEvent.click(await screen.findByTestId(`gerenciar-${OFICIAL.id}`));
    const erro = await screen.findByTestId("gerenciar-erro");
    expect(erro.textContent).toContain("Não foi possível carregar esta conexão. Tente de novo.");
  });
});

describe("links antigos de aba", () => {
  it("?aba=oficial (link do admin da Meta): Gerenciar da primeira oficial com o Avançado aberto", async () => {
    h.adminDaPlataforma = true;
    h.busca = "aba=oficial";
    montar();
    const dialogo = await screen.findByTestId("gerenciar-conexao");
    const avancado = (await within(dialogo).findByTestId("gerenciar-avancado")) as HTMLDetailsElement;
    expect(avancado.open).toBe(true);
  });

  it("volta do OAuth: sem Criar, aviso em toast e o cartão novo em destaque", async () => {
    const MESSENGER = cartao({ id: "55555555-5555-4555-8555-555555555555", tipo: "messenger", nome: "Página" });
    h.conexoes = [OFICIAL, INSTAGRAM, MESSENGER];
    h.busca = "aba=sociais&meta_social=ok&n=1&plataforma=messenger";
    montar();
    const novo = await screen.findByTestId(`cartao-conexao-${MESSENGER.id}`);
    await waitFor(() => expect(novo.getAttribute("data-destacado")).toBe("true"));
    expect(screen.getByTestId(`cartao-conexao-${INSTAGRAM.id}`).getAttribute("data-destacado")).toBeNull();
    expect(screen.queryByTestId("criar-conexao")).toBeNull();
    expect(h.toast.success).toHaveBeenCalledTimes(1);
  });

  it("volta do OAuth com várias contas: abre a escolha das páginas, sem Criar e sem toast", async () => {
    // D-242: a escolha abre pela tela em cartões (a entrada real da volta), não só pelo Criar.
    h.busca = "aba=sociais&meta_social=escolher&plataforma=instagram";
    montar();
    const dialogo = await screen.findByTestId("escolher-contas-meta");
    expect(within(dialogo).getByText("Escolha quais páginas conectar nesta empresa")).toBeInTheDocument();
    expect(await within(dialogo).findByText("@loja")).toBeInTheDocument();
    for (const caixa of within(dialogo).getAllByRole("checkbox")) expect(caixa).not.toBeChecked();
    expect(within(dialogo).getByTestId("confirmar-contas-meta")).toBeDisabled();
    expect(screen.queryByTestId("criar-conexao")).toBeNull();
    expect(h.toast.success).not.toHaveBeenCalled();
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it("?aba=sociais sem resultado e com plataforma=messenger abre o Criar no Messenger", async () => {
    h.busca = "aba=sociais&plataforma=messenger";
    montar();
    expect(await screen.findByTestId("criar-conteudo-messenger")).toBeInTheDocument();
  });

  it("?aba=oficial&sub=templates abre os Templates da Meta da primeira conta oficial", async () => {
    h.busca = "aba=oficial&sub=templates";
    montar();
    const dialogo = await screen.findByTestId("gerenciar-conexao");
    expect(await within(dialogo).findByText("boas_vindas")).toBeInTheDocument();
  });
});
