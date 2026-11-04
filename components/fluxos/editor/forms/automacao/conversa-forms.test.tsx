/**
 * Os formulários dos blocos de conversa da automação (mensagem, pergunta,
 * espera): o que a pessoa preenche na tela vira uma config que o MOTOR aceita
 * (o schema de `graph-schema.ts`, o mesmo do publish) — e as saídas do card
 * saem dos ids que o formulário gravou.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  messageConfigSchema,
  nodeBranches,
  questionConfigSchema,
  waitConfigSchema,
  type MessageConfig,
  type QuestionConfig,
  type WaitConfig,
} from "@/lib/followup/graph-schema";

import { WaitForm } from "../WaitForm";
import { MessageForm } from "./MessageForm";
import { QuestionForm } from "./QuestionForm";
import { respostasAntesDe } from "./respostas";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => false,
}));

function montar(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const usuario = () => userEvent.setup({ delay: null });

function ultima<T>(fn: ReturnType<typeof vi.fn>): T {
  const chamadas = fn.mock.calls;
  expect(chamadas.length).toBeGreaterThan(0);
  return chamadas[chamadas.length - 1]![0] as T;
}

async function substituir(campo: HTMLElement, texto: string) {
  const u = usuario();
  await u.clear(campo);
  if (texto) await u.type(campo, texto);
}

describe("MessageForm", () => {
  it("botões preenchidos viram config válida, e cada opção é uma saída do bloco", async () => {
    const onChange = vi.fn();
    montar(<MessageForm config={{ body: "Para que é o imóvel?" }} onChange={onChange} />);
    const u = usuario();

    await u.click(screen.getByTestId("mensagem-tipo-buttons"));
    await u.type(screen.getByTestId("opcao-0-rotulo"), "Moradia");
    await u.type(screen.getByTestId("opcao-1-rotulo"), "Investimento");

    const config = ultima<MessageConfig>(onChange);
    expect(messageConfigSchema.safeParse(config).success).toBe(true);
    expect(config.options?.kind).toBe("buttons");
    expect(config.options?.items.map((i) => i.label)).toEqual(["Moradia", "Investimento"]);
    expect(config.reply_timeout_ms).toBe(86_400_000);

    const ids = config.options!.items.map((i) => i.id);
    const ramos = nodeBranches({ type: "message", config });
    expect(ramos.map((r) => r.id)).toEqual([...ids, "no_reply", "erro", "else"]);
    expect(ramos.map((r) => r.label)).toEqual([
      "Moradia",
      "Investimento",
      "Sem resposta",
      "Erro",
      "Resposta inválida",
    ]);

    // Os avisos fixos do canal e da latência.
    const aviso = screen.getByTestId("mensagem-aviso-canal");
    expect(aviso).toHaveTextContent("No WhatsApp oficial o contato vê botões");
    expect(aviso).toHaveTextContent("A resposta é processada em até 1 minuto.");
  });

  it("o id da opção não muda ao renomear nem ao reordenar", async () => {
    const onChange = vi.fn();
    const inicial: MessageConfig = {
      body: "Escolha",
      options: {
        kind: "buttons",
        items: [
          { id: "opcao_a", label: "Moradia" },
          { id: "opcao_b", label: "Investimento" },
        ],
      },
      reply_timeout_ms: 3_600_000,
    };
    montar(<MessageForm config={inicial} onChange={onChange} />);

    await substituir(screen.getByTestId("opcao-0-rotulo"), "Casa própria");
    let config = ultima<MessageConfig>(onChange);
    expect(config.options!.items).toEqual([
      { id: "opcao_a", label: "Casa própria" },
      { id: "opcao_b", label: "Investimento" },
    ]);

    await usuario().click(screen.getByTestId("opcao-0-descer"));
    config = ultima<MessageConfig>(onChange);
    expect(config.options!.items.map((i) => i.id)).toEqual(["opcao_b", "opcao_a"]);
    // O tempo de espera que veio do nó continua (1 hora).
    expect(config.reply_timeout_ms).toBe(3_600_000);
  });

  it("opção nova ganha id próprio, único e que não sai do rótulo; remover tira só ela", async () => {
    const onChange = vi.fn();
    const inicial: MessageConfig = {
      body: "Escolha",
      options: { kind: "buttons", items: [{ id: "opcao_a", label: "Sim" }] },
      reply_timeout_ms: 60_000,
    };
    montar(<MessageForm config={inicial} onChange={onChange} />);
    const u = usuario();

    await u.click(screen.getByTestId("adicionar-opcao"));
    await u.type(screen.getByTestId("opcao-1-rotulo"), "Não");
    const config = ultima<MessageConfig>(onChange);
    const novo = config.options!.items[1]!.id;
    expect(novo).not.toBe("opcao_a");
    expect(novo).not.toMatch(/nao/i);
    expect(messageConfigSchema.safeParse(config).success).toBe(true);

    await u.click(screen.getByTestId("opcao-0-remover"));
    expect(ultima<MessageConfig>(onChange).options!.items).toEqual([{ id: novo, label: "Não" }]);
  });

  it("lista: botão da lista e descrição; com mais de 3 itens, Botões não grava e avisa", async () => {
    const onChange = vi.fn();
    montar(<MessageForm config={{ body: "Qual unidade?" }} onChange={onChange} />);
    const u = usuario();

    await u.click(screen.getByTestId("mensagem-tipo-list"));
    await u.type(screen.getByTestId("opcao-0-rotulo"), "Centro");
    await u.type(screen.getByTestId("opcao-0-descricao"), "Rua A, 10");
    await u.type(screen.getByTestId("opcao-1-rotulo"), "Bairro");
    await u.click(screen.getByTestId("adicionar-opcao"));
    await u.type(screen.getByTestId("opcao-2-rotulo"), "Shopping");
    await u.click(screen.getByTestId("adicionar-opcao"));
    await u.type(screen.getByTestId("opcao-3-rotulo"), "Online");
    await substituir(screen.getByTestId("mensagem-botao-da-lista"), "Unidades");

    const config = ultima<MessageConfig>(onChange);
    expect(messageConfigSchema.safeParse(config).success).toBe(true);
    expect(config.options).toMatchObject({
      kind: "list",
      button_label: "Unidades",
      items: [
        { label: "Centro", description: "Rua A, 10" },
        { label: "Bairro" },
        { label: "Shopping" },
        { label: "Online" },
      ],
    });

    const chamadas = onChange.mock.calls.length;
    await u.click(screen.getByTestId("mensagem-tipo-buttons"));
    expect(onChange.mock.calls.length).toBe(chamadas);
    expect(screen.getByTestId("mensagem-erro")).toHaveTextContent("Botões aceitam até 3 opções");
  });

  it("salvar escolha e resposta inválida entram na config; Sem opções volta ao texto puro", async () => {
    const onChange = vi.fn();
    montar(<MessageForm config={{ body: "Oi" }} onChange={onChange} />);
    const u = usuario();

    await u.click(screen.getByTestId("mensagem-tipo-buttons"));
    await u.type(screen.getByTestId("opcao-0-rotulo"), "Sim");
    await u.type(screen.getByTestId("opcao-1-rotulo"), "Não");
    await u.selectOptions(screen.getByTestId("mensagem-salvar-em"), "lead:title");
    await u.selectOptions(screen.getByTestId("mensagem-invalida-tentativas"), "3");
    await u.type(screen.getByTestId("mensagem-invalida-texto"), "Toque em uma das opções.");
    await u.selectOptions(screen.getByTestId("mensagem-espera-unidade"), "horas");

    let config = ultima<MessageConfig>(onChange);
    expect(messageConfigSchema.safeParse(config).success).toBe(true);
    expect(config.save_to).toEqual({ scope: "lead", key: "title" });
    expect(config.invalid_reply).toEqual({ attempts: 3, message: "Toque em uma das opções." });
    expect(config.reply_timeout_ms).toBe(3_600_000);

    // Campo só leitura não aparece para gravar.
    const opcoes = within(screen.getByTestId("mensagem-salvar-em"))
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(opcoes).not.toContain("contact:email");
    expect(opcoes).not.toContain("contact:phone_number");

    await u.click(screen.getByTestId("mensagem-tipo-none"));
    config = ultima<MessageConfig>(onChange);
    expect(config).toEqual({ body: "Oi" });
  });

  it("contador usa o limite de 1024 com opções e oferece a resposta de um bloco anterior", async () => {
    const onChange = vi.fn();
    montar(
      <MessageForm
        config={{ body: "Oi" }}
        onChange={onChange}
        respostas={[{ variavel: "{{resposta.question_1}}", origem: "Fazer pergunta" }]}
      />,
    );
    expect(screen.getByTestId("mensagem-contador")).toHaveTextContent("2 / 4000");
    await usuario().click(screen.getByTestId("inserir-variavel-{{resposta.question_1}}"));
    expect(ultima<MessageConfig>(onChange).body).toBe("Oi {{resposta.question_1}}");
    await usuario().click(screen.getByTestId("mensagem-tipo-buttons"));
    expect(screen.getByTestId("mensagem-contador")).toHaveTextContent("/ 1024");
  });
});

describe("QuestionForm", () => {
  const base: QuestionConfig = {
    question: "Qual é o melhor horário?",
    save_to: { scope: "lead_custom", key: "horario" },
    validation: "text",
    timeout_ms: 86_400_000,
    retries: 1,
  };

  it("preenchida vira config válida e mostra a variável da resposta", async () => {
    const onChange = vi.fn();
    montar(<QuestionForm config={base} onChange={onChange} nodeId="question-3" />);
    const u = usuario();

    expect(screen.getByTestId("pergunta-variavel-nome")).toHaveTextContent(
      "{{resposta.question_3}}",
    );

    await substituir(screen.getByTestId("pergunta-texto"), "Qual é o seu telefone?");
    await u.selectOptions(screen.getByTestId("pergunta-validacao"), "phone");
    await u.selectOptions(screen.getByTestId("pergunta-tentativas"), "2");
    await u.type(screen.getByTestId("pergunta-nova-tentativa"), "Mande só os números, com DDD.");
    await u.type(screen.getByTestId("pergunta-tempo-esgotado"), "Tudo bem, falamos depois.");
    await substituir(screen.getByTestId("pergunta-tempo-limite"), "2");
    await u.selectOptions(screen.getByTestId("pergunta-tempo-limite-unidade"), "horas");

    const config = ultima<QuestionConfig>(onChange);
    expect(questionConfigSchema.safeParse(config).success).toBe(true);
    expect(config).toEqual({
      question: "Qual é o seu telefone?",
      save_to: { scope: "lead_custom", key: "horario" },
      validation: "phone",
      timeout_ms: 7_200_000,
      retries: 2,
      retry_message: "Mande só os números, com DDD.",
      timeout_message: "Tudo bem, falamos depois.",
    });
  });

  it("CPF avisa que não vira variável; tempo acima de 7 dias não grava", async () => {
    const onChange = vi.fn();
    montar(<QuestionForm config={base} onChange={onChange} nodeId="question-1" />);
    const u = usuario();

    await u.selectOptions(screen.getByTestId("pergunta-validacao"), "cpf");
    expect(screen.getByTestId("pergunta-variavel")).toHaveTextContent("não vira variável");

    const chamadas = onChange.mock.calls.length;
    await substituir(screen.getByTestId("pergunta-tempo-limite"), "8");
    await u.selectOptions(screen.getByTestId("pergunta-tempo-limite-unidade"), "dias");
    expect(onChange.mock.calls.length).toBe(chamadas);
    expect(screen.getByTestId("pergunta-erro")).toHaveTextContent("1 minuto a 7 dias");
  });
});

describe("WaitForm na automação", () => {
  it('"até responder" numa automação por comentário avisa que a IA não responde enquanto espera; fora dela, não', () => {
    const { unmount } = montar(
      <WaitForm
        config={{ mode: "until_reply", timeout_ms: 7_200_000 }}
        onChange={vi.fn()}
        surface="automacao"
        noInstagram
      />,
    );
    expect(screen.getByTestId("aviso-espera-no-direct")).toHaveTextContent(
      "Enquanto espera, o agente de IA não responde nesta conversa.",
    );
    unmount();
    montar(
      <WaitForm
        config={{ mode: "until_reply", timeout_ms: 7_200_000 }}
        onChange={vi.fn()}
        surface="automacao"
      />,
    );
    expect(screen.queryByTestId("aviso-espera-no-direct")).not.toBeInTheDocument();
  });

  it("espera em segundos abre no modo dela, com o número que estava no nó", () => {
    montar(
      <WaitForm
        config={{ mode: "delay", duration_s: 30 }}
        onChange={vi.fn()}
        surface="automacao"
      />,
    );
    expect(screen.getByTestId("wait-mode")).toHaveValue("delay");
    expect(screen.getByTestId("wait-delay")).toHaveValue(30);
    expect(screen.getByTestId("wait-delay-unidade")).toHaveValue("segundos");
  });

  it('"até responder" abre no modo dela', () => {
    montar(
      <WaitForm
        config={{ mode: "until_reply", timeout_ms: 7_200_000 }}
        onChange={vi.fn()}
        surface="automacao"
      />,
    );
    expect(screen.getByTestId("wait-mode")).toHaveValue("until_reply");
    expect(screen.getByTestId("wait-reply-timeout")).toHaveValue(2);
    expect(screen.getByTestId("wait-reply-timeout-unidade")).toHaveValue("horas");
  });

  it("trocar os modos emite configs que o motor aceita", async () => {
    const onChange = vi.fn();
    montar(
      <WaitForm
        config={{ mode: "fixed", duration_ms: 600_000 }}
        onChange={onChange}
        surface="automacao"
      />,
    );
    const u = usuario();
    expect(screen.getByTestId("wait-mode")).toHaveValue("fixed");

    await u.selectOptions(screen.getByTestId("wait-mode"), "delay");
    await substituir(screen.getByTestId("wait-delay"), "45");
    await u.selectOptions(screen.getByTestId("wait-delay-unidade"), "segundos");
    let config = ultima<WaitConfig>(onChange);
    expect(config).toEqual({ mode: "delay", duration_s: 45 });
    expect(waitConfigSchema.safeParse(config).success).toBe(true);

    await u.selectOptions(screen.getByTestId("wait-mode"), "until_reply");
    await substituir(screen.getByTestId("wait-reply-timeout"), "3");
    await u.selectOptions(screen.getByTestId("wait-reply-timeout-unidade"), "dias");
    config = ultima<WaitConfig>(onChange);
    expect(config).toEqual({ mode: "until_reply", timeout_ms: 3 * 86_400_000 });
    expect(nodeBranches({ type: "wait", config }).map((r) => r.label)).toEqual([
      "Sem resposta",
      "Respondeu",
    ]);
  });

  it("zero segundos não grava e avisa o mínimo", async () => {
    const onChange = vi.fn();
    montar(
      <WaitForm
        config={{ mode: "delay", duration_s: 5 }}
        onChange={onChange}
        surface="automacao"
      />,
    );
    await substituir(screen.getByTestId("wait-delay"), "0");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("wait-erro")).toHaveTextContent("1 segundo");
  });
});

describe("respostasAntesDe", () => {
  const no = (id: string, type: string, config: unknown = {}) => ({
    id,
    type,
    data: { label: id, config },
  });

  it("lista só pergunta (sem CPF) e mensagem com opções que vêm antes, sem o próprio bloco", () => {
    const nodes = [
      no("trigger-1", "trigger"),
      no("question-1", "question", { validation: "text" }),
      no("message-1", "message", { body: "x" }),
      no("message-2", "message", { body: "x", options: { kind: "buttons", items: [] } }),
      no("question-2", "question", { validation: "cpf" }),
      no("message-3", "message", { body: "x" }),
      no("question-9", "question", { validation: "text" }),
    ];
    const edges = [
      { source: "trigger-1", target: "question-1" },
      { source: "question-1", target: "message-1" },
      { source: "message-1", target: "message-2" },
      { source: "message-2", target: "question-2" },
      { source: "question-2", target: "message-3" },
      { source: "message-3", target: "question-9" },
    ];
    expect(respostasAntesDe("message-3", nodes, edges).map((r) => r.variavel)).toEqual([
      "{{resposta.message_2}}",
      "{{resposta.question_1}}",
    ]);
    expect(respostasAntesDe("question-1", nodes, edges)).toEqual([]);
  });
});

describe("Mensagem e Pergunta numa automação que começa por comentário do Instagram", () => {
  const comOpcoes: MessageConfig = {
    body: "Escolha",
    options: { kind: "buttons", items: [{ id: "opcao_a", label: "Quero" }] },
    reply_timeout_ms: 86_400_000,
  } as MessageConfig;

  it("a Mensagem avisa que sai pelo Direct, que a conversa abre quando a pessoa responde e que as opções chegam numeradas", () => {
    montar(<MessageForm config={comOpcoes} onChange={vi.fn()} noInstagram />);
    const direct = screen.getByTestId("aviso-do-direct");
    expect(direct).toHaveTextContent(
      "No Instagram, esta mensagem sai pelo Direct de quem comentou.",
    );
    expect(direct).toHaveTextContent("A conversa abre quando a pessoa responde");
    const canal = screen.getByTestId("mensagem-aviso-canal");
    expect(canal).toHaveTextContent("No Instagram, as opções chegam numeradas (1, 2, 3)");
    expect(canal).not.toHaveTextContent("WhatsApp");
  });

  it("a Pergunta também avisa; fora do Instagram nenhum dos dois aviso aparece", () => {
    const pergunta: QuestionConfig = questionConfigSchema.parse({
      question: "Qual o seu e-mail?",
      save_to: { scope: "contact", key: "email" },
      validation: "email",
      timeout_ms: 86_400_000,
      retries: 1,
    });
    const { unmount } = montar(
      <QuestionForm config={pergunta} onChange={vi.fn()} nodeId="q1" noInstagram />,
    );
    expect(screen.getByTestId("aviso-do-direct")).toBeInTheDocument();
    unmount();
    montar(<MessageForm config={comOpcoes} onChange={vi.fn()} />);
    expect(screen.queryByTestId("aviso-do-direct")).toBeNull();
    expect(screen.getByTestId("mensagem-aviso-canal")).toHaveTextContent("No WhatsApp oficial");
  });
});
