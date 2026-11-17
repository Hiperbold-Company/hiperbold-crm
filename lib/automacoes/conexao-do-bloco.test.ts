/**
 * Campo "Conexão" de Mensagem e Pergunta (régua DataCrazy): o schema aceita a
 * conexão opcional, a publicação recusa a que não é desta organização ou não
 * envia mensagem, o arquivo de exportação a leva pelo nome (referência
 * "canal") e o "Substituir em todos os blocos" troca a conexão no rascunho.
 */
import { describe, expect, it } from "vitest";

import {
  flowGraphSchema,
  messageConfigSchema,
  questionConfigSchema,
  type FlowGraph,
} from "@/lib/followup/graph-schema";
import {
  MENSAGEM_CONEXAO_INEXISTENTE,
  validateFlowForPublish,
} from "@/lib/followup/validate-publish";

import {
  UUID_RX,
  exportarAutomacao,
  lerArquivoDeAutomacao,
  montarGrafoImportado,
  previaDaImportacao,
  type CatalogoDaConta,
} from "./portabilidade";
import { blocosDaConexao, substituirConexao, type NoDoCanvas } from "./substituir-conexao";

const CONEXAO_A = "aaaaaaaa-0000-4000-8000-0000000000aa";
const CONEXAO_B = "bbbbbbbb-0000-4000-8000-0000000000bb";
const CONEXAO_DE_OUTRA_CONTA = "cccccccc-0000-4000-8000-0000000000cc";
const AUTOMACAO = "dddddddd-0000-4000-8000-000000000001";

const pos = (y: number) => ({ x: 0, y });
const sempre = { type: "always" } as const;
const erro = { type: "branch", branch_id: "erro" } as const;

function grafo(conexaoDaMensagem?: string, conexaoDaPergunta?: string): FlowGraph {
  return flowGraphSchema.parse({
    nodes: [
      {
        id: "t",
        type: "trigger",
        label: "Início",
        position: pos(0),
        config: {
          triggers: [
            {
              kind: "message_received",
              match: "any",
              keywords: [],
              channel_session_ids: [CONEXAO_A],
            },
          ],
          reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
        },
      },
      {
        id: "m",
        type: "message",
        label: "Boas-vindas",
        position: pos(100),
        config: {
          ...(conexaoDaMensagem ? { channel_session_id: conexaoDaMensagem } : {}),
          body: "Olá!",
        },
      },
      {
        id: "p",
        type: "question",
        label: "E-mail",
        position: pos(200),
        config: {
          ...(conexaoDaPergunta ? { channel_session_id: conexaoDaPergunta } : {}),
          question: "Qual o seu e-mail?",
          save_to: { scope: "contact", key: "email" },
          validation: "email",
          timeout_ms: 3_600_000,
          retries: 0,
        },
      },
      { id: "f", type: "end", label: "Fim", position: pos(300), config: { outcome: "converted" } },
    ],
    edges: [
      { id: "e1", source: "t", target: "m", priority: 0, condition: sempre },
      { id: "e2", source: "m", target: "p", priority: 0, condition: sempre },
      { id: "e3", source: "m", target: "f", priority: 1, condition: erro },
      { id: "e4", source: "p", target: "f", priority: 0, condition: sempre },
    ],
  });
}

describe("schema: a conexão do bloco é opcional e é um uuid", () => {
  it("ausente continua valendo (automação existente não muda)", () => {
    expect(messageConfigSchema.safeParse({ body: "oi" }).success).toBe(true);
    expect(
      messageConfigSchema.safeParse({ body: "oi", channel_session_id: CONEXAO_A }).success,
    ).toBe(true);
    expect(
      messageConfigSchema.safeParse({ body: "oi", channel_session_id: "numero-1" }).success,
    ).toBe(false);
    const pergunta = {
      question: "?",
      save_to: { scope: "contact", key: "email" },
      validation: "email",
      timeout_ms: 3_600_000,
      retries: 0,
    };
    expect(
      questionConfigSchema.safeParse({ ...pergunta, channel_session_id: CONEXAO_B }).success,
    ).toBe(true);
  });
});

describe("publicação: a conexão escolhida tem de ser desta conta e enviar mensagem", () => {
  const publicar = (g: FlowGraph, conexoes?: string[]) =>
    validateFlowForPublish(g, {
      surface: "automacao",
      automacao: {
        pointerId: AUTOMACAO,
        ...(conexoes ? { conexoesDeMensagem: new Set(conexoes) } : {}),
      },
    });
  const daConexao = (r: ReturnType<typeof publicar>) =>
    r.ok ? [] : r.errors.filter((e) => e.code === "conexao_inexistente");

  it("conexão da organização passa; em branco passa", () => {
    expect(daConexao(publicar(grafo(CONEXAO_A, CONEXAO_B), [CONEXAO_A, CONEXAO_B]))).toEqual([]);
    expect(daConexao(publicar(grafo(), [CONEXAO_A]))).toEqual([]);
  });

  it("conexão de outra conta (ou apagada, ou que não envia mensagem) recusa, no bloco que a cita", () => {
    const erros = daConexao(publicar(grafo(CONEXAO_A, CONEXAO_DE_OUTRA_CONTA), [CONEXAO_A]));
    expect(erros).toEqual([
      { node_id: "p", code: "conexao_inexistente", message: MENSAGEM_CONEXAO_INEXISTENTE },
    ]);
  });

  it("sem a lista de conexões (contexto ausente), não confere", () => {
    expect(daConexao(publicar(grafo(CONEXAO_DE_OUTRA_CONTA)))).toEqual([]);
  });
});

describe('exportar/importar: a conexão do bloco vira referência "canal"', () => {
  const ORIGEM: CatalogoDaConta = [
    { id: CONEXAO_A, tipo: "canal", nome: "WhatsApp Comercial", ativo: true },
  ];
  const DESTINO: CatalogoDaConta = [
    { id: CONEXAO_B, tipo: "canal", nome: "WhatsApp Comercial", ativo: true },
  ];
  const AGORA = new Date("2026-11-16T12:00:00Z");

  it("sai pelo nome, sem uuid; volta com a conexão da outra conta sugerida pelo nome", () => {
    const arquivo = exportarAutomacao(
      { id: AUTOMACAO, nome: "Boas-vindas", grafo: grafo(CONEXAO_A) },
      ORIGEM,
      AGORA,
    );
    const textos = JSON.stringify(arquivo).match(/[0-9a-f-]{36}/gi) ?? [];
    expect(textos.filter((t) => UUID_RX.test(t))).toEqual([]);
    expect(arquivo.referencias).toEqual([
      { id: "canal_1", tipo: "canal", nome: "WhatsApp Comercial" },
    ]);

    const leitura = lerArquivoDeAutomacao(JSON.parse(JSON.stringify(arquivo)));
    if (!leitura.ok) throw new Error(leitura.problemas.join("; "));
    const previa = previaDaImportacao(leitura.arquivo, leitura.usadas, DESTINO);
    expect(previa.referencias.find((r) => r.id === "canal_1")?.sugestao).toBe(CONEXAO_B);
    const m = montarGrafoImportado(
      leitura.arquivo,
      leitura.usadas,
      { canal_1: CONEXAO_B },
      DESTINO,
      AUTOMACAO,
    );
    if (!m.ok) throw new Error("deveria montar");
    const mensagem = m.grafo.nodes.find((n) => n.id === "m")!;
    expect((mensagem.config as { channel_session_id?: string }).channel_session_id).toBe(CONEXAO_B);
  });

  it("conexão apagada na origem sai com o tipo do campo (canal) e nome vazio", () => {
    const arquivo = exportarAutomacao(
      { id: AUTOMACAO, nome: "x", grafo: grafo(CONEXAO_DE_OUTRA_CONTA) },
      ORIGEM,
      AGORA,
    );
    expect(arquivo.referencias).toContainEqual({ id: "canal_2", tipo: "canal", nome: null });
  });
});

describe("substituir em todos os blocos", () => {
  const nos = (): NoDoCanvas[] =>
    grafo(CONEXAO_A).nodes.map((n) => ({
      id: n.id,
      type: n.type,
      data: { config: n.config },
    })) as NoDoCanvas[];
  const conexaoDe = (lista: NoDoCanvas[], id: string) =>
    (
      (lista.find((n) => (n as { id?: string }).id === id)!.data.config ?? {}) as {
        channel_session_id?: string;
      }
    ).channel_session_id;
  const gatilhoDe = (lista: NoDoCanvas[]) =>
    (lista[0]!.data.config as { triggers: Array<{ channel_session_ids?: string[] }> }).triggers[0]!
      .channel_session_ids;

  it('troca a conexão atual em Mensagem/Pergunta e no gatilho "Mensagem recebida"', () => {
    const antes = nos();
    // A Mensagem e o Início citam a conexão A; a Pergunta está em branco.
    expect(blocosDaConexao(antes, CONEXAO_A)).toBe(2);
    const depois = substituirConexao(antes, CONEXAO_A, CONEXAO_B);
    expect(conexaoDe(depois, "m")).toBe(CONEXAO_B);
    expect(conexaoDe(depois, "p")).toBeUndefined();
    expect(gatilhoDe(depois)).toEqual([CONEXAO_B]);
    // O rascunho de antes não muda (o canvas recebe outra lista).
    expect(conexaoDe(antes, "m")).toBe(CONEXAO_A);
  });

  it("a atual vazia troca só os blocos em branco; o gatilho (vazio = qualquer número) não muda", () => {
    const antes = nos();
    expect(blocosDaConexao(antes, null)).toBe(1);
    const depois = substituirConexao(antes, null, CONEXAO_B);
    expect(conexaoDe(depois, "p")).toBe(CONEXAO_B);
    expect(conexaoDe(depois, "m")).toBe(CONEXAO_A);
    expect(gatilhoDe(depois)).toEqual([CONEXAO_A]);
  });

  it("nó que não muda continua o mesmo objeto; a nova que o gatilho já tinha não se repete", () => {
    const antes = nos();
    (
      antes[0]!.data.config as { triggers: Array<{ channel_session_ids?: string[] }> }
    ).triggers[0]!.channel_session_ids = [CONEXAO_A, CONEXAO_B];
    const depois = substituirConexao(antes, CONEXAO_A, CONEXAO_B);
    expect(gatilhoDe(depois)).toEqual([CONEXAO_B]);
    expect(depois[3]).toBe(antes[3]);
  });
});
