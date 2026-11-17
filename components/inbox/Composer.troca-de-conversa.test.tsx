/**
 * TROCAR DE CONVERSA ZERA O PAINEL DE MENSAGENS (auditoria de 17/11/2026).
 *
 * O compositor não é remontado na troca de conversa (a `key` do `InboxLayout` é
 * fixa sem rascunho). Antes do conserto, o painel aberto, a aba, o modelo
 * escolhido e os valores preenchidos na conversa A continuavam na B, e
 * "Enviar modelo" mandava à B o modelo montado para A.
 *
 * Mede com o compositor REAL, o painel REAL e a aba de modelos REAL; dublês só
 * na rede (`apiClient`) e no envio (`useSendMessage`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { get: apiGet, post: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const RESPOSTAS = vi.hoisted(() => [
  { id: "r-1", title: "Saudação", body: "Oi {{primeiro_nome}}, tudo bem?", shortcut: "oi", owner_user_id: null },
  { id: "r-2", title: "Prazo de entrega", body: "Entregamos em 3 dias.", shortcut: "prazo", owner_user_id: null },
]);

const formDialog = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/app/app/templates/_components/TemplateFormDialog", () => ({
  TemplateFormDialog: (props: { open: boolean; canShare: boolean }) => {
    formDialog(props);
    return props.open ? <div data-testid="form-da-resposta-rapida" /> : null;
  },
}));

const { sendMutate, noteMutate, toastWarning } = vi.hoisted(() => ({
  sendMutate: vi.fn(),
  noteMutate: vi.fn(),
  toastWarning: vi.fn(),
}));



// Mensagem agendada (migration 1017): o compositor agenda pelo hook próprio; aqui só o envio na hora importa.
vi.mock("@/hooks/inbox/useMensagensAgendadas", () => ({ useAgendarMensagem: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMutate, isPending: false }),
}));

vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: noteMutate, isPending: false }),
}));

vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// A consulta do rascunho assistido (issue #3027) mora num hook próprio, e este
// arquivo não monta `QueryClientProvider`: mockar aqui é o mesmo tratamento que
// outros hooks do compositor recebem. O bloco passa a ser decidido por
// `sugestao` (o mesmo sinal do painel), e quem prova a decisão é
// `Composer.sugestao.test.tsx`, com o painel REAL montado sobre uma consulta
// de verdade.
vi.mock("@/hooks/inbox/useRascunhoAssistido", () => ({
  useRascunhoAssistido: () => ({ sugestao: undefined, invalidar: () => {} }),
}));

vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));

vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: RESPOSTAS, isLoading: false }),
  // Sem grupo (#3245): a barra e o slash-menu são os de antes dos grupos, que é
  // o caminho que estes casos medem.
  useGruposDeRespostas: () => ({ data: [] }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: toastWarning },
}));

vi.mock("@/lib/inbox/clipboard-image", () => ({
  imagemDoClipboard: vi.fn(() => null),
}));

vi.mock("@/lib/notifications/mentions", () => ({
  embutirMencoes: vi.fn((body: string) => body),
  podarMencoesDaEdicao: vi.fn((_antes: string, _depois: string, m: unknown) => m),
  podarMencoes: vi.fn((_texto: string, m: unknown) => m),
  resolverMencao: vi.fn(() => null),
}));

vi.mock("@/lib/messaging/contact-card", () => ({
  resolveSharedContact: vi.fn(),
}));

// Os filhos do compositor são render de tela: o que este teste mede é o corpo que
// SAI do `handleSubmit`, então cada um vira um placeholder sem comportamento.
vi.mock("@/components/inbox/composer/ReplyReviewPanel", () => ({
  ReplyReviewPanel: () => null,
}));
// Os dois lados da assistência viram placeholders aqui: este arquivo mede o
// corpo que SAI do `handleSubmit`, e o `DraftReplyButton` real traria uma
// `useMutation` (e o `QueryClient` que este arquivo não monta) para dentro da
// medição. A decisão de qual dos dois aparece — com o painel e o botão REAIS —
// é medida em `Composer.sugestao.test.tsx`.
vi.mock("@/components/inbox/composer/DraftReplyButton", () => ({
  DraftReplyButton: () => null,
}));
vi.mock("@/components/inbox/composer/MentionMenu", () => ({
  resolverMencao: () => null,
  opcoesDeMencao: () => [],
  MentionMenu: () => null,
}));
vi.mock("@/components/inbox/composer/AttachMenu", () => ({
  AttachMenu: () => null,
}));
vi.mock("@/components/inbox/composer/AttachmentPreviewDialog", () => ({
  AttachmentPreviewDialog: () => null,
}));
vi.mock("@/components/inbox/composer/ContactPickerDialog", () => ({
  ContactPickerDialog: () => null,
}));
vi.mock("@/components/inbox/composer/AudioRecorder", () => ({
  AudioRecorder: () => null,
}));
vi.mock("@/components/inbox/composer/EmojiButton", () => ({
  EmojiButton: () => null,
}));

import { Composer } from "./Composer";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function composerDa(conversationId: string) {
  return (
    <QueryClientProvider client={qc}>
      <Composer
        conversationId={conversationId}
        contactName="Rafael Melgaço"
        provider={CHANNEL_PROVIDER_META}
        channelSessionId="sess-1"
      />
    </QueryClientProvider>
  );
}

const botao = () => screen.getByRole("button", { name: "Mensagens rápidas e modelos" });
const painel = () => screen.queryByRole("dialog", { name: "Painel de mensagens" });

async function abrirAbaDeModelos() {
  await userEvent.click(botao());
  const abas = within(painel()!).getAllByRole("tab");
  await userEvent.click(abas.find((a) => a.textContent === "Templates do WhatsApp")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  qc.clear();
  apiGet.mockResolvedValue({
    data: {
      waba: "WABA-1",
      templates: [
        {
          name: "boas_vindas",
          language: "pt_BR",
          status: "APPROVED",
          category: "UTILITY",
          slots: [{ key: "1", expects: "text", onde: "corpo", valueKey: "body:1" }],
          previews: [],
          components: [{ type: "BODY", text: "Oi {{1}}" }],
          savedValues: {},
          daConexao: true,
        },
      ],
    },
  });
});

describe("trocar de conversa zera o painel de mensagens", () => {
  it("o painel aberto em A não aparece aberto em B", async () => {
    const { rerender } = render(composerDa("conv-a"));
    await userEvent.click(botao());
    expect(painel()).not.toBeNull();

    rerender(composerDa("conv-b"));
    expect(painel()).toBeNull();
    expect(botao().getAttribute("aria-expanded")).toBe("false");
  });

  it("o modelo escolhido e preenchido em A não é enviado à B", async () => {
    const { rerender } = render(composerDa("conv-a"));
    await abrirAbaDeModelos();
    await userEvent.click(await screen.findByText(/boas_vindas/));
    fireEvent.change(screen.getByRole("textbox", { name: /\{\{1\}\}/ }), { target: { value: "Ana" } });
    expect(screen.getByRole("button", { name: "Enviar modelo" })).toBeTruthy();

    rerender(composerDa("conv-b"));
    await abrirAbaDeModelos();
    await screen.findByText(/boas_vindas/);
    // Nada escolhido na B: sem botão de enviar e sem o valor preenchido em A.
    expect(screen.queryByRole("button", { name: "Enviar modelo" })).toBeNull();
    expect(screen.queryByDisplayValue("Ana")).toBeNull();

    // Escolhendo de novo na B, o envio é da B, com o valor preenchido na B.
    await userEvent.click(screen.getByText(/boas_vindas/));
    fireEvent.change(screen.getByRole("textbox", { name: /\{\{1\}\}/ }), { target: { value: "Beto" } });
    await userEvent.click(screen.getByRole("button", { name: "Enviar modelo" }));
    expect(sendMutate).toHaveBeenCalledTimes(1);
    expect(sendMutate).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "conv-b", template_values: { "body:1": "Beto" } }),
      expect.anything(),
    );
  });
});
