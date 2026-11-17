/**
 * O PAINEL DE MENSAGENS DO CHAT (17/11/2026) — o botão de aspas do compositor.
 *
 * Mede, com o compositor REAL e o painel REAL:
 *   - o botão abre o painel por cima da conversa; o X e o Esc fecham, e o foco
 *     volta para o botão;
 *   - a aba "Templates do WhatsApp" só existe no canal oficial;
 *   - a busca filtra, e o clique numa mensagem rápida põe o texto NO CAMPO com
 *     as variáveis do contato preenchidas (o mesmo `applyTemplate` do `/`), sem
 *     enviar nada;
 *   - "Nova mensagem rápida" abre o formulário da tela de Respostas rápidas, com
 *     o `canShare` de quem é gerente.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";

const RESPOSTAS = vi.hoisted(() => [
  { id: "r-1", title: "Saudação", body: "Oi {{primeiro_nome}}, tudo bem?", shortcut: "oi", owner_user_id: null },
  { id: "r-2", title: "Prazo de entrega", body: "Entregamos em 3 dias.", shortcut: "prazo", owner_user_id: null },
]);

const formDialog = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
// A aba de modelos tem teste próprio (`AbaDeModelosDoWhatsApp.test.tsx`).
vi.mock("@/components/inbox/composer/AbaDeModelosDoWhatsApp", () => ({
  AbaDeModelosDoWhatsApp: () => <div data-testid="aba-de-modelos" />,
}));
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

function renderComposer(opts?: { provider?: string | null; podeGerenciar?: boolean }) {
  return render(
    <Composer
      conversationId="conv-1"
      contactName="Rafael Melgaço"
      provider={opts?.provider ?? null}
      channelSessionId="sess-1"
      podeGerenciarMensagens={opts?.podeGerenciar ?? false}
    />,
  );
}

const botao = () => screen.getByRole("button", { name: "Mensagens rápidas e modelos" });
const painel = () => screen.queryByRole("dialog", { name: "Painel de mensagens" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("painel de mensagens no compositor", () => {
  it("abre pelo botão de aspas e fecha pelo X, devolvendo o foco", async () => {
    renderComposer();
    expect(painel()).toBeNull();
    await userEvent.click(botao());
    expect(painel()).not.toBeNull();
    expect(botao().getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Fechar painel" }));
    expect(painel()).toBeNull();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(botao());
  });

  it("Esc fecha o painel", async () => {
    renderComposer();
    await userEvent.click(botao());
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Buscar mensagem rápida" }), { key: "Escape" });
    expect(painel()).toBeNull();
  });

  it("fora do canal oficial só existe a aba de mensagens rápidas", async () => {
    renderComposer({ provider: null });
    await userEvent.click(botao());
    const abas = within(painel()!).getAllByRole("tab").map((a) => a.textContent);
    expect(abas).toEqual(["Mensagens rápidas"]);
  });

  it("no canal oficial aparece a aba de templates, e ela troca o conteúdo", async () => {
    renderComposer({ provider: CHANNEL_PROVIDER_META });
    await userEvent.click(botao());
    const abas = within(painel()!).getAllByRole("tab");
    expect(abas.map((a) => a.textContent)).toEqual(["Mensagens rápidas", "Templates do WhatsApp"]);
    await userEvent.click(abas[1]!);
    expect(abas[1]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("aba-de-modelos")).toBeTruthy();
    expect(screen.queryByRole("searchbox", { name: "Buscar mensagem rápida" })).toBeNull();
  });

  it("a busca filtra, e o clique põe o texto no campo com as variáveis do contato", async () => {
    renderComposer();
    await userEvent.click(botao());
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar mensagem rápida" }), { target: { value: "sauda" } });
    const itens = within(painel()!).getAllByRole("button").filter((b) => b.hasAttribute("data-resposta-rapida"));
    expect(itens).toHaveLength(1);
    await userEvent.click(itens[0]!);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Oi Rafael, tudo bem?");
    expect(painel()).toBeNull();
    expect(sendMutate).not.toHaveBeenCalled();
  });

  it("Nova mensagem rápida abre o formulário com o canShare de quem gerencia", async () => {
    renderComposer({ podeGerenciar: true });
    await userEvent.click(botao());
    await userEvent.click(screen.getByRole("button", { name: "Nova mensagem rápida" }));
    expect(screen.getByTestId("form-da-resposta-rapida")).toBeTruthy();
    expect(formDialog).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, canShare: true }));
  });
});
