/**
 * O campo "Conexão" dos blocos Mensagem e Pergunta: escolher a conexão grava
 * `channel_session_id` na config (em branco tira), e "Substituir em todos os
 * blocos" mostra quantos blocos mudam e pede a troca ao canvas.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type * as ModuloDasConexoes from "@/hooks/channels/useChannelSessions";
import { PROVIDERS_DE_MENSAGEM, PROVIDERS_SEM_MENSAGEM } from "@/lib/channels/capabilities";

import { MessageForm } from "./MessageForm";
import { QuestionForm } from "./QuestionForm";

type UseChannelSessions = typeof ModuloDasConexoes;

const CONEXAO_A = "aaaaaaaa-0000-4000-8000-0000000000aa";
const CONEXAO_B = "bbbbbbbb-0000-4000-8000-0000000000bb";
const CONEXAO_VOZ = "cccccccc-0000-4000-8000-0000000000cc";
// Derivados de capabilities: nome de provider literal aqui reprovaria o lint:channels.
const PROVIDER_DE_MENSAGEM = PROVIDERS_DE_MENSAGEM[0];
const PROVIDER_SEM_MENSAGEM = PROVIDERS_SEM_MENSAGEM[0];

vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => false }));
vi.mock("@/hooks/channels/useChannelSessions", async (importOriginal) => {
  const real = await importOriginal<UseChannelSessions>();
  return {
    ...real,
    useChannelSessions: () => ({
      // Só o nome dado à conexão: é o que o rótulo usa primeiro.
      data: [
        {
          id: CONEXAO_A,
          provider: PROVIDER_DE_MENSAGEM,
          display_name: "Comercial",
          phone_number: null,
        },
        {
          id: CONEXAO_B,
          provider: PROVIDER_DE_MENSAGEM,
          display_name: "Suporte",
          phone_number: null,
        },
        {
          id: CONEXAO_VOZ,
          provider: PROVIDER_SEM_MENSAGEM,
          display_name: "Ligações",
          phone_number: null,
        },
      ],
      isLoading: false,
      isError: false,
    }),
  };
});

function montar(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
const usuario = () => userEvent.setup({ delay: null });

describe("campo Conexão", () => {
  it("Mensagem: escolher a conexão grava channel_session_id; voltar ao vazio tira", async () => {
    const onChange = vi.fn();
    const { rerender } = montar(<MessageForm config={{ body: "Olá" }} onChange={onChange} />);
    const u = usuario();
    expect(
      screen.getByText("Deixe em branco para usar a conexão dos blocos anteriores."),
    ).toBeInTheDocument();
    await u.selectOptions(screen.getByTestId("mensagem-conexao"), CONEXAO_B);
    expect(onChange).toHaveBeenLastCalledWith({ body: "Olá", channel_session_id: CONEXAO_B });

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MessageForm config={{ body: "Olá", channel_session_id: CONEXAO_B }} onChange={onChange} />
      </QueryClientProvider>,
    );
    await u.selectOptions(screen.getByTestId("mensagem-conexao"), "");
    expect(onChange).toHaveBeenLastCalledWith({ body: "Olá" });
  });

  it("a lista oferece só conexões que transportam mensagem", () => {
    montar(<MessageForm config={{ body: "Olá" }} onChange={vi.fn()} />);
    const campo = screen.getByTestId("mensagem-conexao");
    expect(within(campo).getByRole("option", { name: "Comercial" })).toBeInTheDocument();
    expect(within(campo).getByRole("option", { name: "Suporte" })).toBeInTheDocument();
    expect(within(campo).queryByRole("option", { name: "Ligações" })).toBeNull();
  });

  it("Mensagem: editar o texto mantém a conexão escolhida", async () => {
    const onChange = vi.fn();
    montar(
      <MessageForm config={{ body: "Olá", channel_session_id: CONEXAO_A }} onChange={onChange} />,
    );
    await usuario().type(screen.getByTestId("mensagem-texto"), "!");
    expect(onChange).toHaveBeenLastCalledWith({ body: "Olá!", channel_session_id: CONEXAO_A });
  });

  it("Pergunta também tem o campo, e sem o canvas não oferece o Substituir", () => {
    montar(
      <QuestionForm
        config={{
          question: "Qual o seu e-mail?",
          save_to: { scope: "contact", key: "email" },
          validation: "email",
          timeout_ms: 3_600_000,
          retries: 0,
        }}
        onChange={vi.fn()}
        nodeId="question-1"
      />,
    );
    expect(screen.getByTestId("pergunta-conexao")).toBeInTheDocument();
    expect(screen.queryByTestId("pergunta-conexao-substituir")).toBeNull();
  });

  it("Substituir em todos os blocos: mostra a atual, quantos mudam e pede a troca", async () => {
    const contar = vi.fn((atual: string | null) => (atual === CONEXAO_A ? 3 : 0));
    const aplicar = vi.fn();
    montar(
      <MessageForm
        config={{ body: "Olá", channel_session_id: CONEXAO_A }}
        onChange={vi.fn()}
        substituirConexao={{ contar, aplicar }}
      />,
    );
    const u = usuario();
    await u.click(screen.getByTestId("mensagem-conexao-substituir"));
    expect(screen.getByTestId("mensagem-conexao-atual")).toHaveTextContent("Comercial");
    expect(screen.getByTestId("mensagem-conexao-quantos")).toHaveTextContent(
      "3 blocos serão atualizados",
    );
    const botao = screen.getByTestId("mensagem-conexao-substituir-todas");
    expect(botao).toBeDisabled();
    await u.selectOptions(screen.getByTestId("mensagem-conexao-nova"), CONEXAO_B);
    await u.click(botao);
    expect(aplicar).toHaveBeenCalledWith(CONEXAO_A, CONEXAO_B);
  });

  it('bloco em branco: a atual é "Conexões dos blocos anteriores"', async () => {
    const contar = vi.fn(() => 1);
    const aplicar = vi.fn();
    montar(
      <MessageForm
        config={{ body: "Olá" }}
        onChange={vi.fn()}
        substituirConexao={{ contar, aplicar }}
      />,
    );
    const u = usuario();
    await u.click(screen.getByTestId("mensagem-conexao-substituir"));
    expect(screen.getByTestId("mensagem-conexao-atual")).toHaveTextContent(
      "Conexões dos blocos anteriores",
    );
    expect(screen.getByTestId("mensagem-conexao-quantos")).toHaveTextContent(
      "1 bloco será atualizado",
    );
    await u.selectOptions(screen.getByTestId("mensagem-conexao-nova"), CONEXAO_A);
    await u.click(screen.getByTestId("mensagem-conexao-substituir-todas"));
    expect(aplicar).toHaveBeenCalledWith(null, CONEXAO_A);
  });
});
