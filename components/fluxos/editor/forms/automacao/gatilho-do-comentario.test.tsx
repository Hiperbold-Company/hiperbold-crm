/**
 * O gatilho "comentário no Instagram" no editor: só contas do Instagram no
 * seletor; os posts se escolhem da lista dos recentes da conta (vários) ou pelo
 * link; erro da rota em português; sem conta escolhida, a tela explica.
 *
 * A borda simulada é a rede (`apiClient.get`) e a lista de conexões; o que se
 * mede é o que sobe para o canvas (validado pelo schema do motor).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  automacaoTriggerConfigSchema,
  type AutomacaoTrigger,
  type AutomacaoTriggerConfig,
} from "@/lib/automacoes/schemas";
import { ApiError } from "@/lib/api/types";

import type * as Canais from "@/hooks/channels/useChannelSessions";

import { AutomationTriggerForm } from "./AutomationTriggerForm";

const IG = "44444444-4444-4444-8444-444444444444";
const MESSENGER = "55555555-5555-4555-8555-555555555555";
const WHATS = "66666666-6666-4666-8666-666666666666";

const { getMock, contasMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  contasMock: { atual: null as unknown[] | null },
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: getMock } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => false,
  useActiveOrg: () => ({ orgId: "org-1" }),
}));
vi.mock("@/hooks/channels/useChannelSessions", async (original) => ({
  ...(await original<typeof Canais>()),
  useChannelSessions: () => ({
    data: contasMock.atual ?? [
      { id: IG, display_name: "Loja no Instagram", phone_number: null, plataforma: "instagram" },
      {
        id: MESSENGER,
        display_name: "Página no Messenger",
        phone_number: null,
        plataforma: "messenger",
      },
      { id: WHATS, display_name: "WhatsApp vendas", phone_number: null, plataforma: "whatsapp" },
    ],
    isLoading: false,
    isError: false,
    schemaOutdated: false,
  }),
}));
vi.mock("@/hooks/contacts/useEtiquetasParaEscolher", () => ({
  useEtiquetasParaEscolher: () => ({ data: [] }),
}));
vi.mock("@/hooks/followup/useFollowupFlows", () => ({
  useFollowupFlows: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  useWebhookSources: () => ({ data: { data: [] } }),
}));

const POSTS = [
  {
    media_id: "18000000000000001",
    permalink: null,
    legenda_curta: "Promoção de novembro",
    miniatura: null,
    tipo: "IMAGE",
    publicado_em: "2026-11-01T12:00:00Z",
  },
  {
    media_id: "18000000000000002",
    permalink: null,
    legenda_curta: "Reel do lançamento",
    miniatura: null,
    tipo: "REELS",
    publicado_em: "2026-11-02T12:00:00Z",
  },
];

function montar(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function ultimoGatilho(onChange: ReturnType<typeof vi.fn>): AutomacaoTrigger {
  const config = onChange.mock.calls.at(-1)![0] as AutomacaoTriggerConfig;
  expect(automacaoTriggerConfigSchema.safeParse(config).success).toBe(true);
  return config.triggers[0]!;
}

async function abrir(config: Partial<AutomacaoTriggerConfig> = {}) {
  const onChange = vi.fn();
  montar(<AutomationTriggerForm config={config} onChange={onChange} />);
  const u = userEvent.setup({ delay: null });
  if (!config.triggers)
    await u.selectOptions(screen.getByTestId("gatilho-0-tipo"), "instagram_comment");
  return { onChange, u };
}

beforeEach(() => {
  contasMock.atual = null;
  getMock.mockReset();
  getMock.mockImplementation(async (url: string) => {
    if (url.includes("&link=")) {
      if (url.includes("naoexiste"))
        throw new ApiError(404, "post_nao_encontrado", undefined, "r", "x");
      if (url.includes("google.com")) throw new ApiError(400, "link_invalido", undefined, "r", "x");
      return { data: { media_id: "18000000000000009" } };
    }
    return { data: { posts: POSTS } };
  });
});

describe("gatilho: comentário no Instagram", () => {
  it("o seletor de contas mostra só as conexões do Instagram", async () => {
    await abrir();
    expect(screen.getByText("Loja no Instagram")).toBeInTheDocument();
    expect(screen.queryByText("Página no Messenger")).not.toBeInTheDocument();
    expect(screen.queryByText("WhatsApp vendas")).not.toBeInTheDocument();
  });

  it("sem conta marcada (qualquer conta): lista os posts da única conta do Instagram, e o campo de colar aparece", async () => {
    const { onChange, u } = await abrir();
    await screen.findByTestId("gatilho-0-post-18000000000000001");
    expect(getMock.mock.calls[0]![0]).toBe(
      `/api/v1/channels/meta-social/posts?channel_session_id=${IG}`,
    );
    expect(screen.queryByTestId("gatilho-0-posts-conta")).not.toBeInTheDocument();
    expect(screen.getByTestId("gatilho-0-post-link")).toBeInTheDocument();
    expect(screen.getByText("Nenhum escolhido = qualquer post.")).toBeInTheDocument();
    await u.click(screen.getByTestId("gatilho-0-post-18000000000000002"));
    const g = ultimoGatilho(onChange);
    expect(g).toMatchObject({ media_ids: ["18000000000000002"] });
    expect(g).not.toHaveProperty("channel_session_ids");
  });

  it("várias contas do Instagram sem nenhuma marcada: seletor de conta acima da grade", async () => {
    const OUTRA_IG = "77777777-7777-4777-8777-777777777777";
    contasMock.atual = [
      { id: IG, display_name: "Loja no Instagram", phone_number: null, plataforma: "instagram" },
      {
        id: OUTRA_IG,
        display_name: "Outlet no Instagram",
        phone_number: null,
        plataforma: "instagram",
      },
    ];
    const { u } = await abrir();
    const seletor = await screen.findByTestId("gatilho-0-posts-conta");
    await u.selectOptions(seletor, OUTRA_IG);
    await waitFor(() =>
      expect(getMock.mock.calls.at(-1)![0]).toBe(
        `/api/v1/channels/meta-social/posts?channel_session_id=${OUTRA_IG}`,
      ),
    );
  });

  it("sem conta do Instagram conectada: avisa, e o id colado ainda vale", async () => {
    contasMock.atual = [
      { id: WHATS, display_name: "WhatsApp vendas", phone_number: null, plataforma: "whatsapp" },
    ];
    const { onChange, u } = await abrir();
    expect(screen.getByTestId("gatilho-0-posts-sem-conta")).toHaveTextContent(
      "Conecte uma conta do Instagram para listar os posts.",
    );
    expect(getMock).not.toHaveBeenCalled();
    await u.type(screen.getByTestId("gatilho-0-post-link"), "17895695668004550{Enter}");
    expect(ultimoGatilho(onChange)).toMatchObject({ media_ids: ["17895695668004550"] });
  });

  it("conta já salva que não é do Instagram continua aparecendo marcada, e dá para desmarcar", async () => {
    const { onChange, u } = await abrir({
      triggers: [
        { kind: "instagram_comment", match: "any", keywords: [], channel_session_ids: [MESSENGER] },
      ],
      reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
    } as AutomacaoTriggerConfig);
    const marcada = screen.getByLabelText("Página no Messenger");
    expect(marcada).toBeChecked();
    expect(screen.queryByText("WhatsApp vendas")).not.toBeInTheDocument();
    await u.click(marcada);
    expect(ultimoGatilho(onChange)).not.toHaveProperty("channel_session_ids");
  });

  it("com a conta: lista os posts recentes e escolhe vários; desmarcar tira", async () => {
    const { onChange, u } = await abrir();
    await u.click(screen.getByLabelText("Loja no Instagram"));
    await screen.findByTestId("gatilho-0-post-18000000000000001");
    expect(getMock.mock.calls[0]![0]).toBe(
      `/api/v1/channels/meta-social/posts?channel_session_id=${IG}`,
    );
    await u.click(screen.getByTestId("gatilho-0-post-18000000000000001"));
    await u.click(screen.getByTestId("gatilho-0-post-18000000000000002"));
    expect(ultimoGatilho(onChange)).toMatchObject({
      kind: "instagram_comment",
      channel_session_ids: [IG],
      media_ids: ["18000000000000001", "18000000000000002"],
    });
    await u.click(screen.getByTestId("gatilho-0-post-18000000000000001"));
    expect(ultimoGatilho(onChange)).toMatchObject({ media_ids: ["18000000000000002"] });
  });

  it("colar o link vira o id do post; link inválido e post não encontrado dão erro legível", async () => {
    const { onChange, u } = await abrir();
    await u.click(screen.getByLabelText("Loja no Instagram"));
    const campo = await screen.findByTestId("gatilho-0-post-link");

    await u.type(campo, "https://google.com/x{Enter}");
    expect(await screen.findByTestId("gatilho-0-post-link-erro")).toHaveTextContent(
      "Esse link não é de um post ou reel do Instagram",
    );
    await u.clear(campo);
    await u.type(campo, "https://www.instagram.com/p/naoexiste/{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("gatilho-0-post-link-erro")).toHaveTextContent(
        "Não achamos esse post entre os recentes desta conta.",
      ),
    );
    await u.clear(campo);
    await u.type(campo, "https://www.instagram.com/reel/ABC123/{Enter}");
    await waitFor(() =>
      expect(ultimoGatilho(onChange)).toMatchObject({ media_ids: ["18000000000000009"] }),
    );
  });

  it("a Meta falhou ao listar: mensagem legível no lugar da grade", async () => {
    getMock.mockRejectedValue(new ApiError(502, "meta_falhou", undefined, "r", "x"));
    const { u } = await abrir();
    await u.click(screen.getByLabelText("Loja no Instagram"));
    expect(await screen.findByTestId("gatilho-0-posts-erro")).toHaveTextContent(
      "O Instagram não respondeu. Tente de novo em instantes.",
    );
  });
});
