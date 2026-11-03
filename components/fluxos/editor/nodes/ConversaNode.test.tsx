/**
 * O card dos blocos de conversa: cada opção da mensagem é uma saída com o
 * rótulo dela, e o id da bolinha é o id do ramo — é ele que `onConnect` do
 * canvas recebe em `sourceHandle` e traduz para a condição da aresta.
 */
import { render, screen } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { conditionForBranch, type FlowNode, type MessageConfig } from "@/lib/followup/graph-schema";

import { ConversaNode } from "./ConversaNode";
import { WaitNode } from "./WaitNode";

vi.mock("../EtapasDoFluxo", () => ({
  useEtapasDoFluxo: () => ({ etapas: [], carregando: false, falhou: false, nomes: {} }),
}));
vi.mock("@xyflow/react", () => ({
  Handle: ({ id, type }: { id?: string; type: string }) => (
    <span data-testid={`handle-${type}-${id ?? "unico"}`} data-handleid={id} />
  ),
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));

function props(id: string, type: string, config: unknown): NodeProps<RFNode> {
  return {
    id,
    type,
    data: { label: "Bloco", config },
    selected: false,
  } as unknown as NodeProps<RFNode>;
}

describe("ConversaNode", () => {
  const config: MessageConfig = {
    body: "Para que é o imóvel?",
    options: {
      kind: "buttons",
      items: [
        { id: "opcao_a", label: "Moradia" },
        { id: "opcao_b", label: "Investimento" },
      ],
    },
    reply_timeout_ms: 3_600_000,
  };

  it("mensagem com opções: uma saída por opção, mais Sem resposta, Erro e Resposta inválida", () => {
    render(<ConversaNode {...props("message-1", "message", config)} />);
    const rotulos = ["opcao_a", "opcao_b", "no_reply", "erro", "else"].map(
      (r) => screen.getByTestId(`node-branch-message-1-${r}`).textContent,
    );
    expect(rotulos).toEqual([
      "Moradia",
      "Investimento",
      "Sem resposta",
      "Erro",
      "Resposta inválida",
    ]);

    // A bolinha da opção tem o id do ramo, e esse id vira a condição da aresta.
    const handle = screen.getByTestId("handle-source-opcao_b");
    const no = { id: "message-1", type: "message", label: "Bloco", config } as unknown as FlowNode;
    expect(conditionForBranch(no, handle.getAttribute("data-handleid")!)).toEqual({
      type: "branch",
      branch_id: "opcao_b",
    });
    expect(conditionForBranch(no, "else")).toEqual({ type: "always" });
  });

  it("pergunta: Sem resposta, Resposta inválida, Erro e Respondeu", () => {
    render(
      <ConversaNode
        {...props("question-1", "question", {
          question: "Qual?",
          save_to: { scope: "lead_custom", key: "x" },
          validation: "text",
          timeout_ms: 60_000,
          retries: 0,
        })}
      />,
    );
    expect(screen.getByTestId("node-branches-question-1").textContent).toBe(
      "Sem respostaResposta inválidaErroRespondeu",
    );
  });

  it("mensagem sem opções: Erro e Concluído", () => {
    render(<ConversaNode {...props("message-2", "message", { body: "Oi" })} />);
    expect(screen.getByTestId("node-branches-message-2").textContent).toBe("ErroConcluído");
  });
});

describe("WaitNode", () => {
  it('"até responder" tem as saídas Sem resposta e Respondeu', () => {
    render(<WaitNode {...props("wait-1", "wait", { mode: "until_reply", timeout_ms: 60_000 })} />);
    expect(screen.getByTestId("node-branches-wait-1").textContent).toBe("Sem respostaRespondeu");
  });

  it("espera comum continua com a bolinha única", () => {
    render(<WaitNode {...props("wait-2", "wait", { mode: "delay", duration_s: 10 })} />);
    expect(screen.queryByTestId("node-branches-wait-2")).toBeNull();
    expect(screen.getByTestId("handle-source-unico")).toBeInTheDocument();
  });
});
