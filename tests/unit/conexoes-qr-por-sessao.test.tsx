/**
 * A terceira forma de conexão por QR Code (o serviço de WhatsApp por SESSÃO da instalação), de volta
 * em Conexões (decisão do dono do produto, 18/11/2026).
 *
 * A fronteira mockada é a REDE (`apiClient`), o roteador do Next, a sessão e o toast: o Criar, os
 * cartões, o Gerenciar e os componentes de reconectar rodam de verdade, e o teste afirma QUAIS
 * rotas cada cartão chama. Só peças vizinhas sem relação com a pergunta (acesso da IA, renomear)
 * viram marcadores.
 *
 * Roda com: pnpm vitest run --project produto tests/unit/conexoes-qr-por-sessao.test.tsx
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHANNEL_PROVIDER_META, CHANNEL_PROVIDER_UAZAPI, CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import { cartaoDaLinha, pareamentoDaConexao, type CartaoDaConexao } from "@/lib/channels/conexoes-em-cartoes";
import type { BloqueioDoBotao } from "@/lib/billing/planos/estado-do-bloqueio";

const h = vi.hoisted(() => ({
  busca: "",
  admin: true,
  conexoes: [] as unknown[],
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(h.busca),
  usePathname: () => "/app/connections",
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { is_platform_admin: false, support: null } }),
  usePermission: () => h.admin,
  usePaisDaOrgAtiva: () => null,
}));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: h.get, post: h.post, delete: h.del, patch: vi.fn() },
}));
vi.mock("@/components/connections/ChannelAiAccess", () => ({ ChannelAiAccess: () => null }));
vi.mock("@/components/connections/RenomearConexao", () => ({ RenomearConexao: () => <button>Renomear</button> }));
vi.mock("@/components/connections/ConectarComAMeta", () => ({ ConectarComAMeta: () => <div>conectar-meta</div> }));
vi.mock("@/components/connections/CanalInstanciaClient", () => ({ CanalInstanciaClient: () => <div>conectar-instancia</div> }));
vi.mock("@/components/connections/RedesSociaisClient", async (original) => ({
  ...((await original()) as object),
  RedesSociaisClient: () => null,
}));
vi.mock("@/components/connections/CanalParceiroClient", () => ({ CanalParceiroClient: () => null }));
vi.mock("@/components/connections/CanalGraphParceiroClient", () => ({ CanalGraphParceiroClient: () => null }));
vi.mock("@/components/connections/CanalVozClient", () => ({ CanalVozClient: () => null }));
vi.mock("@/components/connections/TelefoniaClient", () => ({ TelefoniaClient: () => null }));

import { ConexoesShell } from "@/components/connections/ConexoesShell";

const SESSAO = "aaaaaaaa-1111-4111-8111-111111111111";
const INSTANCIA = "bbbbbbbb-2222-4222-8222-222222222222";
const NOVA = "cccccccc-3333-4333-8333-333333333333";

function cartao(linha: Record<string, unknown>): CartaoDaConexao {
  return cartaoDaLinha({ created_at: "2026-11-18T00:00:00Z", ...linha });
}

const CARTAO_SESSAO = cartao({ id: SESSAO, provider: CHANNEL_PROVIDER_WAHA, display_name: "Loja", phone_number: "5511900000001", status: "STOPPED" });
const CARTAO_INSTANCIA = cartao({ id: INSTANCIA, provider: CHANNEL_PROVIDER_UAZAPI, display_name: "Suporte", phone_number: "5511900000002", status: "STOPPED" });

function responder(path: string): unknown {
  if (path === "/api/v1/channels/conexoes") return { data: h.conexoes };
  if (path === "/api/v1/channels/instancia") {
    return {
      data: {
        label: "Instância",
        conexoes: [
          { id: INSTANCIA, display_name: "Suporte", label_color: null, phone_number: "5511900000002", status: "STOPPED", webhook_registrado: true },
        ],
      },
    };
  }
  if (path.startsWith("/api/v1/channel-sessions/")) return { data: { status: "SCAN_QR_CODE" } };
  if (path.startsWith("/api/v1/ai/pacing")) return { data: { items: [] } };
  throw new Error(`rota inesperada no teste: ${path}`);
}

function montar(props: { wahaConfigured: boolean; bloqueio?: BloqueioDoBotao }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConexoesShell wacallsConfigured={false} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.busca = "";
  h.admin = true;
  h.conexoes = [CARTAO_SESSAO, CARTAO_INSTANCIA];
  h.get.mockReset();
  h.get.mockImplementation(async (path: string) => responder(path));
  h.post.mockReset();
  h.post.mockImplementation(async (path: string) => {
    if (path === "/api/v1/channel-sessions") return { data: { id: NOVA, status: "STARTING" } };
    if (path.endsWith("/reconectar")) return { data: { id: INSTANCIA, estado: "aguardando", qr: null, codigo: null } };
    return { data: {} };
  });
  h.del.mockReset();
  h.del.mockResolvedValue({ data: { id: "x", archived: false } });
  Object.values(h.toast).forEach((f) => f.mockReset());
});

afterEach(() => cleanup());

describe("o cartão diz por onde a conexão se pareia (lib)", () => {
  it("sessão, instância ou nada", () => {
    expect(pareamentoDaConexao(CHANNEL_PROVIDER_WAHA)).toBe("sessao");
    expect(pareamentoDaConexao(CHANNEL_PROVIDER_UAZAPI)).toBe("instancia");
    expect(pareamentoDaConexao(CHANNEL_PROVIDER_META)).toBeNull();
    expect(CARTAO_SESSAO).toMatchObject({ tipo: "whatsapp_qr", pareamento: "sessao", status: "desconectado" });
    expect(CARTAO_INSTANCIA).toMatchObject({ tipo: "whatsapp_qr", pareamento: "instancia" });
  });
});

describe("Criar", () => {
  it("com o serviço configurado: o tipo aparece com o nome do serviço", async () => {
    montar({ wahaConfigured: true });
    fireEvent.click(screen.getByTestId("btn-criar-conexao"));
    const tipo = await screen.findByTestId("criar-tipo-whatsapp_qr_sessao");
    expect(tipo.textContent).toContain("WAHA (API não oficial)");
    // A forma por instância continua lá, ao lado.
    expect(screen.getByTestId("criar-tipo-whatsapp_qr")).toBeInTheDocument();
  });

  it("sem o serviço configurado: o tipo não aparece", async () => {
    montar({ wahaConfigured: false });
    fireEvent.click(screen.getByTestId("btn-criar-conexao"));
    await screen.findByTestId("criar-conexao");
    expect(screen.queryByTestId("criar-tipo-whatsapp_qr_sessao")).toBeNull();
    expect(screen.getByTestId("criar-tipo-whatsapp_qr")).toBeInTheDocument();
  });

  it("conectar cria a sessão com chave de idempotência e passa a perguntar o status dela", async () => {
    montar({ wahaConfigured: true });
    fireEvent.click(screen.getByTestId("btn-criar-conexao"));
    fireEvent.click(await screen.findByTestId("criar-tipo-whatsapp_qr_sessao"));
    fireEvent.click(screen.getByTestId("criar-por-sessao-conectar"));
    await screen.findByTestId("pareamento-por-sessao");
    expect(h.post).toHaveBeenCalledWith(
      "/api/v1/channel-sessions",
      {},
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    await waitFor(() => expect(h.get).toHaveBeenCalledWith(`/api/v1/channel-sessions/${NOVA}`));
    // Nunca pelas rotas da instância.
    expect(h.post.mock.calls.some(([p]) => String(p).includes("/channels/instancia"))).toBe(false);
  });

  it("no teto do plano: o botão fica desabilitado, com o motivo, e nada é criado", async () => {
    montar({
      wahaConfigured: true,
      bloqueio: { desabilitado: true, motivo: "Sua conta atingiu o limite de 2 conexões do plano Pro.", suspensa: false },
    });
    fireEvent.click(screen.getByTestId("btn-criar-conexao"));
    fireEvent.click(await screen.findByTestId("criar-tipo-whatsapp_qr_sessao"));
    const botao = screen.getByTestId("criar-por-sessao-conectar") as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    expect(screen.getByTestId("aviso-limite-de-conexoes").textContent).toContain("limite de 2 conexões");
    fireEvent.click(botao);
    expect(h.post).not.toHaveBeenCalled();
  });

  it("quem não é administrador não recebe o botão (as rotas de sessão exigem administrador)", async () => {
    h.admin = false;
    montar({ wahaConfigured: true });
    fireEvent.click(screen.getByTestId("btn-criar-conexao"));
    fireEvent.click(await screen.findByTestId("criar-tipo-whatsapp_qr_sessao"));
    expect(screen.queryByTestId("criar-por-sessao-conectar")).toBeNull();
    expect(screen.getByTestId("criar-por-sessao-so-admin")).toBeInTheDocument();
  });
});

describe("cartões", () => {
  it("o título distingue a conexão por sessão da conexão por instância", async () => {
    montar({ wahaConfigured: true });
    const sessao = await screen.findByTestId(`cartao-conexao-${SESSAO}`);
    expect(within(sessao).getByTestId("tipo-da-conexao").textContent).toBe("WAHA (API não oficial)");
    const instancia = screen.getByTestId(`cartao-conexao-${INSTANCIA}`);
    expect(within(instancia).getByTestId("tipo-da-conexao").textContent).toBe("UAZAPI (API não oficial)");
  });

  it("sessão: reconectar e remover chamam as rotas de channel-sessions, nunca as da instância", async () => {
    montar({ wahaConfigured: true });
    fireEvent.click(await screen.findByTestId(`gerenciar-${SESSAO}`));
    const dialogo = await screen.findByTestId("gerenciar-conexao");

    fireEvent.click(await within(dialogo).findByTestId("reconectar-por-sessao-botao"));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`/api/v1/channel-sessions/${SESSAO}/reconnect`, {}));
    await within(dialogo).findByTestId("pareamento-por-sessao");

    const remover = within(dialogo).getByTestId("btn-remover-conexao");
    fireEvent.click(remover);
    fireEvent.click(remover);
    await waitFor(() => expect(h.del).toHaveBeenCalledWith(`/api/v1/channel-sessions/${SESSAO}`));

    expect(h.get).not.toHaveBeenCalledWith("/api/v1/channels/instancia");
    expect(h.post.mock.calls.some(([p]) => String(p).includes("/channels/instancia"))).toBe(false);
  });

  it("instância: segue chamando as rotas da instância", async () => {
    montar({ wahaConfigured: true });
    fireEvent.click(await screen.findByTestId(`gerenciar-${INSTANCIA}`));
    const dialogo = await screen.findByTestId("gerenciar-conexao");

    fireEvent.click(await within(dialogo).findByTestId("reconectar-botao"));
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith(`/api/v1/channels/instancia/${INSTANCIA}/reconectar`, { telefone: null }),
    );

    const remover = within(dialogo).getByTestId("btn-remover-conexao");
    fireEvent.click(remover);
    fireEvent.click(remover);
    await waitFor(() => expect(h.del).toHaveBeenCalledWith(`/api/v1/channels/instancia?id=${INSTANCIA}`));
    expect(h.post.mock.calls.some(([p]) => String(p).includes("/channel-sessions/"))).toBe(false);
  });

  it("?reconectar=<id> de uma conexão por sessão já pede a reconexão pela rota dela", async () => {
    h.busca = `reconectar=${SESSAO}`;
    montar({ wahaConfigured: true });
    await screen.findByTestId("gerenciar-conexao");
    await waitFor(() => expect(h.post).toHaveBeenCalledWith(`/api/v1/channel-sessions/${SESSAO}/reconnect`, {}));
  });
});
