/**
 * REGISTRO DE NÓS — o contrato de cada tipo de caixa do grafo, num lugar só.
 *
 * Antes, o que um tipo de nó É estava espalhado em `switch`es: as saídas em
 * `nodeBranches` (graph-schema), a decisão em `processNode` (node-handlers), as
 * superfícies em `NOS_DA_SUPERFICIE` (validate-publish). Acrescentar uma caixa
 * exigia achar todos; esquecer um era tela oferecendo caixa que o motor
 * recusava em silêncio (prova do #1130).
 *
 * Agora cada tipo tem UMA entrada aqui, e o mapa é exaustivo pelo tipo: um
 * `NodeType` novo sem entrada não compila. Os mapas de origem (`RAMOS_POR_TIPO`,
 * `DECISORES`) continuam nos arquivos que os usam — este registro os agrega
 * com o que só ele sabe (superfícies, categoria na paleta, se o bloco é efeito,
 * se o motor precisa ler os eventos para decidir).
 *
 * O comportamento dos follow-ups não muda: as decisões são as mesmas funções.
 */
import type { FollowupFlowSurface } from "./api-schemas";
import { RAMOS_POR_TIPO, type BranchableNode, type FlowBranch, type NodeType } from "./graph-schema";
import { DECISORES, type EntradaDoNo, type NodeResult } from "./node-handlers";

/** Grupo da paleta de blocos (automações). */
export type CategoriaDoNo = "inicio" | "crm" | "logica" | "mensagem" | "controle" | "atendimento" | "instagram";

export interface DefinicaoDoNo {
  tipo: NodeType;
  /** Superfícies cujo motor executa este nó (a paleta e o publish leem daqui). */
  superficies: readonly FollowupFlowSurface[];
  categoria: CategoriaDoNo;
  /** Bloco que muda o CRM: o motor o executa uma vez por passo (effect_started/effect_done). */
  efeito: boolean;
  /** O motor carrega os eventos da inscrição antes de decidir. */
  precisaEventos: boolean;
  ramos: (node: BranchableNode) => FlowBranch[];
  decidir: (input: EntradaDoNo) => NodeResult;
}

const FOLLOWUP = ["followup", "crm_automation"] as const;
const FOLLOWUP_E_AUTOMACAO = ["followup", "crm_automation", "automacao"] as const;

function definir(
  tipo: NodeType,
  resto: Omit<DefinicaoDoNo, "tipo" | "ramos" | "decidir">,
): DefinicaoDoNo {
  return {
    tipo,
    ...resto,
    ramos: RAMOS_POR_TIPO[tipo] as (node: BranchableNode) => FlowBranch[],
    decidir: DECISORES[tipo] as (input: EntradaDoNo) => NodeResult,
  };
}

export const REGISTRO_DE_NOS: { readonly [K in NodeType]: DefinicaoDoNo } = {
  trigger: definir("trigger", {
    superficies: ["followup", "crm_automation", "atendimento", "automacao"],
    categoria: "inicio",
    efeito: false,
    precisaEventos: false,
  }),
  wait: definir("wait", { superficies: FOLLOWUP_E_AUTOMACAO, categoria: "controle", efeito: false, precisaEventos: true }),
  condition: definir("condition", {
    superficies: FOLLOWUP_E_AUTOMACAO,
    categoria: "logica",
    efeito: false,
    precisaEventos: true,
  }),
  ai_classify: definir("ai_classify", { superficies: FOLLOWUP, categoria: "logica", efeito: false, precisaEventos: true }),
  match_reply: definir("match_reply", { superficies: FOLLOWUP, categoria: "logica", efeito: false, precisaEventos: true }),
  repeat: definir("repeat", { superficies: FOLLOWUP, categoria: "controle", efeito: false, precisaEventos: true }),
  action: definir("action", { superficies: FOLLOWUP, categoria: "mensagem", efeito: false, precisaEventos: true }),
  end: definir("end", {
    superficies: ["followup", "crm_automation", "atendimento", "automacao"],
    categoria: "controle",
    efeito: false,
    precisaEventos: false,
  }),
  collect: definir("collect", { superficies: ["atendimento"], categoria: "atendimento", efeito: false, precisaEventos: false }),
  skill: definir("skill", { superficies: ["atendimento"], categoria: "atendimento", efeito: false, precisaEventos: false }),
  crm_action: definir("crm_action", { superficies: ["automacao"], categoria: "crm", efeito: true, precisaEventos: true }),
  field_op: definir("field_op", { superficies: ["automacao"], categoria: "crm", efeito: true, precisaEventos: true }),
  // Blocos de conversa (lote 2). `efeito: false` de propósito: o motor não roda o
  // efeito antes de decidir — a decisão diz QUAL efeito quer (`NodeResult.effect.acao`).
  message: definir("message", { superficies: ["automacao"], categoria: "mensagem", efeito: false, precisaEventos: true }),
  question: definir("question", { superficies: ["automacao"], categoria: "mensagem", efeito: false, precisaEventos: true }),
  // Blocos do Instagram: efeito (uma vez por passo, desfecho relido num replay),
  // só em automação cujo gatilho é "Comentário no Instagram" (o publish confere).
  instagram_private_reply: definir("instagram_private_reply", {
    superficies: ["automacao"],
    categoria: "instagram",
    efeito: true,
    precisaEventos: true,
  }),
  instagram_public_reply: definir("instagram_public_reply", {
    superficies: ["automacao"],
    categoria: "instagram",
    efeito: true,
    precisaEventos: true,
  }),
  instagram_check_follow: definir("instagram_check_follow", {
    superficies: ["automacao"],
    categoria: "instagram",
    efeito: true,
    precisaEventos: true,
  }),
};

/**
 * Ordem em que a paleta oferece as caixas de cada superfície (e o conjunto que
 * o publish aceita). A ordem dos follow-ups e do atendimento é a que já existia.
 */
const ORDEM: Record<FollowupFlowSurface, readonly NodeType[]> = {
  followup: ["trigger", "wait", "condition", "ai_classify", "match_reply", "repeat", "action", "end"],
  crm_automation: ["trigger", "wait", "condition", "ai_classify", "match_reply", "repeat", "action", "end"],
  atendimento: ["trigger", "collect", "skill", "end"],
  automacao: [
    "trigger",
    "message",
    "question",
    "crm_action",
    "field_op",
    "condition",
    "wait",
    "instagram_private_reply",
    "instagram_check_follow",
    "instagram_public_reply",
    "end",
  ],
};

/** As caixas que o motor de cada superfície executa — derivado do registro. */
export const NOS_DA_SUPERFICIE: Record<FollowupFlowSurface, readonly NodeType[]> = Object.fromEntries(
  (Object.keys(ORDEM) as FollowupFlowSurface[]).map((sup) => [
    sup,
    ORDEM[sup].filter((tipo) => REGISTRO_DE_NOS[tipo].superficies.includes(sup)),
  ]),
) as unknown as Record<FollowupFlowSurface, readonly NodeType[]>;

export function definicaoDoNo(tipo: NodeType): DefinicaoDoNo {
  return REGISTRO_DE_NOS[tipo];
}
