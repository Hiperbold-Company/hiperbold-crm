/**
 * MODELOS PRONTOS DE AUTOMAÇÃO (lote 5) — o mesmo padrão dos modelos de
 * follow-up (`lib/followup/modelos/`): o modelo é DADO, um grafo que o
 * `flowGraphSchema` valida e o publish aprova, e nasce como RASCUNHO. Quem
 * publica é uma pessoa, depois de ler os textos. Criar não manda mensagem para
 * ninguém.
 *
 * Cada modelo pede só o indispensável (`pede`): funil e etapa de destino, ou o
 * campo de data do negócio. A rota confere a entrada contra a organização.
 */
import type { FlowGraph } from "@/lib/followup/graph-schema";

export type EntradaDoModeloDeAutomacao = {
  pipelineId?: string;
  stageId?: string;
  /** Chave de um campo de DATA do negócio (`pipelines.settings.fields`). */
  campoDeData?: string;
};

export interface ModeloDeAutomacao {
  /** Id estável: vai para o audit log. */
  id: string;
  nome: string;
  resumo: string;
  /** O que a tela pergunta antes de criar. */
  pede: "nada" | "etapa" | "campo_de_data";
  grafo(entrada: EntradaDoModeloDeAutomacao): FlowGraph;
}

const UM_DIA_MS = 24 * 60 * 60_000;
const REENTRADA = { policy: "skip_if_running", cooldown_minutes: 0 } as const;
const pos = (y: number) => ({ x: 0, y });
const sempre = { type: "always" } as const;

export const MODELOS_DE_AUTOMACAO: readonly ModeloDeAutomacao[] = [
  {
    id: "boas_vindas",
    nome: "Boas-vindas ao novo contato",
    resumo: "Quando um negócio novo entra, manda uma mensagem de boas-vindas.",
    pede: "nada",
    grafo: () => ({
      nodes: [
        {
          id: "n1",
          type: "trigger",
          label: "Início",
          position: pos(0),
          config: { triggers: [{ kind: "lead_created" }], reentry: REENTRADA },
        },
        {
          id: "n2",
          type: "message",
          label: "Boas-vindas",
          position: pos(200),
          config: { body: "Olá, {{contact.name}}! Obrigado pelo contato. Em que podemos ajudar?" },
        },
        {
          id: "n3",
          type: "end",
          label: "Fim",
          position: pos(400),
          config: { outcome: "converted" },
        },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", priority: 0, condition: sempre },
        { id: "e2", source: "n2", target: "n3", priority: 0, condition: sempre },
      ],
    }),
  },
  {
    id: "qualificar",
    nome: "Qualificar com perguntas",
    resumo:
      "Pergunta o nome, pergunta o interesse com botões, guarda a resposta e move o negócio para a etapa escolhida.",
    pede: "etapa",
    grafo: (e) => ({
      nodes: [
        {
          id: "n1",
          type: "trigger",
          label: "Início",
          position: pos(0),
          config: { triggers: [{ kind: "lead_created" }], reentry: REENTRADA },
        },
        {
          id: "n2",
          type: "question",
          label: "Nome",
          position: pos(200),
          config: {
            question: "Olá! Para começar, qual é o seu nome?",
            save_to: { scope: "contact", key: "name" },
            validation: "text",
            timeout_ms: UM_DIA_MS,
            retries: 1,
          },
        },
        {
          id: "n3",
          type: "message",
          label: "Interesse",
          position: pos(400),
          config: {
            body: "Obrigado, {{contact.name}}! O que você procura?",
            options: {
              kind: "buttons",
              items: [
                { id: "orcamento", label: "Orçamento" },
                { id: "informacao", label: "Informação" },
              ],
            },
            reply_timeout_ms: UM_DIA_MS,
            save_to: { scope: "lead_custom", key: "interesse" },
          },
        },
        {
          id: "n4",
          type: "crm_action",
          label: "Mover negócio",
          position: pos(600),
          config: {
            actions: [
              { type: "move_deal", pipeline_id: e.pipelineId ?? "", stage_id: e.stageId ?? "" },
            ],
            on_error: "continue",
          },
        },
        {
          id: "n5",
          type: "end",
          label: "Fim",
          position: pos(800),
          config: { outcome: "converted" },
        },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", priority: 0, condition: sempre },
        { id: "e2", source: "n2", target: "n3", priority: 0, condition: sempre },
        {
          id: "e3",
          source: "n2",
          target: "n5",
          priority: 1,
          condition: { type: "branch", branch_id: "invalida" },
        },
        {
          id: "e4",
          source: "n2",
          target: "n5",
          priority: 2,
          condition: { type: "branch", branch_id: "no_reply" },
        },
        {
          id: "e5",
          source: "n3",
          target: "n4",
          priority: 0,
          condition: { type: "branch", branch_id: "orcamento" },
        },
        {
          id: "e6",
          source: "n3",
          target: "n4",
          priority: 1,
          condition: { type: "branch", branch_id: "informacao" },
        },
        {
          id: "e7",
          source: "n3",
          target: "n5",
          priority: 2,
          condition: { type: "branch", branch_id: "no_reply" },
        },
        { id: "e8", source: "n4", target: "n5", priority: 0, condition: sempre },
      ],
    }),
  },
  {
    id: "lembrete_antes_da_data",
    nome: "Lembrete antes da data",
    resumo: "Espera até um dia antes da data guardada no negócio, às 9h, e manda um lembrete.",
    pede: "campo_de_data",
    grafo: (e) => ({
      nodes: [
        {
          id: "n1",
          type: "trigger",
          label: "Início",
          position: pos(0),
          config: { triggers: [{ kind: "lead_created" }], reentry: REENTRADA },
        },
        {
          id: "n2",
          type: "wait",
          label: "Um dia antes, às 9h",
          position: pos(200),
          config: {
            mode: "until_date_field",
            field_key: e.campoDeData ?? "",
            offset_days: -1,
            time: "09:00",
          },
        },
        {
          id: "n3",
          type: "message",
          label: "Lembrete",
          position: pos(400),
          config: {
            body: "Olá, {{contact.name}}! Passando para lembrar: é amanhã. Qualquer dúvida, é só responder.",
          },
        },
        {
          id: "n4",
          type: "end",
          label: "Fim",
          position: pos(600),
          config: { outcome: "converted" },
        },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", priority: 0, condition: sempre },
        { id: "e2", source: "n2", target: "n3", priority: 0, condition: sempre },
        {
          id: "e3",
          source: "n2",
          target: "n4",
          priority: 1,
          condition: { type: "branch", branch_id: "sem_data" },
        },
        { id: "e4", source: "n3", target: "n4", priority: 0, condition: sempre },
      ],
    }),
  },
];

export function modeloDeAutomacaoPorId(id: string): ModeloDeAutomacao | undefined {
  return MODELOS_DE_AUTOMACAO.find((m) => m.id === id);
}
