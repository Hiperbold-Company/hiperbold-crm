import type { ComponentType } from "react";

import { Bell, Play, Clock, GitBranch, Brain, ChatCircle, ChatsCircle, ArrowsClockwise, PaperPlaneTilt, Flag, Question, PuzzlePiece, Funnel, Tag, Kanban, PencilSimple, InstagramLogo, Users, Globe } from "@/lib/ui/icons";
import { fraseDaAcao, fraseDaOperacao, GATILHOS_DA_AUTOMACAO, type NomesDaAutomacao } from "@/lib/automacoes/vocabulario";
import type { FollowupFlowSurface } from "@/lib/followup/api-schemas";
import { configHttpEmBranco } from "@/lib/automacoes/http";
import type { FlowNode, NodeType } from "@/lib/followup/graph-schema";
import { RESULTADOS_DO_FIM } from "@/lib/followup/vocabulario";
import { NOS_DA_SUPERFICIE } from "@/lib/followup/validate-publish";
import { fraseDaEsperaAteAData, fraseDaEsperaAteODia } from "@/lib/automacoes/plano-de-tempo";

const primeiraMaiuscula = (s: string) => s.charAt(0).toLocaleUpperCase("pt-BR") + s.slice(1);

/**
 * Visual identity per node type — shared by the palette (Task 6.2 increment 2)
 * and the custom node cards (increment 3). Each type gets a DISTINCT icon +
 * Sage token pairing (never a bare default React Flow box): trigger=accent
 * (start), wait=info (calm/waiting), condition=warning (branch), ai_classify=
 * solid accent (the "smart" step), action=success (send/go), end=error
 * (terminal — reads as "stop", not literally an error).
 */
export interface NodeVisual {
  type: NodeType;
  paletteLabel: string;
  icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  /** Icon chip background + text. */
  chipClassName: string;
  /** Left accent border on the node card. */
  borderClassName: string;
  defaultLabel: string;
  defaultConfig: () => FlowNode["config"];
}

type RegraDeCondicao = Extract<FlowNode, { type: "condition" }>["config"]["checks"][number];

/**
 * A regra com que o nó de condição nasce, e a que o "+ Condição" acrescenta.
 *
 * Era `passos ≥ 0` — válida no schema e VERDADEIRA PARA TODO LEAD (o contador
 * nasce em zero e só soma). No modo uma-saída-por-regra ela desviava todo mundo
 * e tornava "Nenhuma delas" inalcançável; num OU, fixava o nó em "Sim". E o card
 * a mostrava com cara de regra pronta.
 *
 * Agora nasce INCOMPLETA de propósito: o schema aceita (o rascunho salva), o
 * motor nunca a satisfaz e o publish a recusa até alguém escolher a etapa. Etapa
 * porque é a pergunta mais comum de um funil — e a que o seletor responde sem
 * digitar nada.
 */
export function regraEmBranco(): Extract<RegraDeCondicao, { field: string }> {
  return { field: "lead_stage", op: "eq", value: "" };
}

/**
 * Nó de mensagem novo: IA, salvo o gatilho de retorno — ali o padrão é texto
 * fixo, porque a saudação de quem voltou não pede o LLM (e duas vozes
 * nasceriam se o default fosse `ai_message` + o turno inbound).
 */
export function configPadraoDaAcao(triggerKind?: string): FlowNode["config"] {
  if (triggerKind === "inbound_after_silence") {
    return { mode: "text", body: "Configure esta mensagem." };
  }
  return { mode: "ai_message", prompt_hint: "Configure esta etapa." };
}

export const NODE_VISUALS: Record<NodeType, NodeVisual> = {
  trigger: {
    type: "trigger",
    paletteLabel: "Gatilho",
    icon: Play,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Início do fluxo",
    defaultConfig: () => ({}),
  },
  wait: {
    type: "wait",
    paletteLabel: "Aguardar",
    icon: Clock,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Aguardar",
    defaultConfig: () => ({ mode: "fixed", duration_ms: 300_000 }),
  },
  condition: {
    type: "condition",
    paletteLabel: "Condição",
    icon: GitBranch,
    chipClassName: "bg-warning-bg text-warning-fg",
    borderClassName: "border-l-warning",
    defaultLabel: "Verificar condição",
    defaultConfig: () => ({ combinator: "and", checks: [regraEmBranco()] }),
  },
  ai_classify: {
    type: "ai_classify",
    paletteLabel: "Classificar (IA)",
    icon: Brain,
    chipClassName: "bg-accent text-accent-foreground",
    borderClassName: "border-l-accent-700",
    defaultLabel: "Classificar resposta",
    defaultConfig: () => ({
      // Em português, e dizendo o CRITÉRIO: estes nomes são a definição inteira
      // que o modelo recebe para classificar a resposta (`followup-flow-classify`),
      // e aparecem crus na saída do card, na aresta e no dossiê. "hot"/"cold"
      // pedia ao dono da loja que adivinhasse o critério — e ao modelo também.
      // Fora do dicionário de propósito: são DADO do usuário, e uma chave faria
      // o card traduzir o que o motor compara ao pé da letra.
      classes: ["Interessado", "Sem interesse"],
      grace_timeout_ms: 900_000,
      target: "last_reply",
    }),
  },
  match_reply: {
    type: "match_reply",
    paletteLabel: "Resposta (texto)",
    icon: ChatCircle,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Casar resposta",
    defaultConfig: () => ({
      branches: [{ id: "br_sim", label: "Sim", op: "contains", pattern: "sim" }],
      grace_timeout_ms: 900_000,
    }),
  },
  repeat: {
    type: "repeat",
    paletteLabel: "Repetir",
    icon: ArrowsClockwise,
    chipClassName: "bg-warning-bg text-warning-fg",
    borderClassName: "border-l-warning",
    defaultLabel: "Repetir pela resposta",
    defaultConfig: () => ({ max_count: 12 }),
  },
  collect: {
    type: "collect",
    paletteLabel: "Pergunta",
    icon: Question,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Nova pergunta",
    defaultConfig: () => ({ key: "novo_campo", label: "Nova pergunta", type: "text", required: true, permite_correcao: true }),
  },
  skill: {
    type: "skill",
    paletteLabel: "Skill",
    icon: PuzzlePiece,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Puxar skill",
    defaultConfig: () => ({ skill_name: "nome-da-skill" }),
  },
  action: {
    type: "action",
    paletteLabel: "Ação",
    icon: PaperPlaneTilt,
    chipClassName: "bg-success-bg text-success-fg",
    borderClassName: "border-l-success",
    defaultLabel: "Enviar mensagem",
    defaultConfig: () => configPadraoDaAcao(),
  },
  internal_task: {
    type: "internal_task",
    paletteLabel: "Lembrete interno",
    icon: Bell,
    chipClassName: "bg-warning-bg text-warning-fg",
    borderClassName: "border-l-warning",
    defaultLabel: "Criar tarefa (só interno)",
    defaultConfig: () => ({
      titulo: "Ligar para {{contact.name}}",
      vence_em_dias: 1,
      atribuir_a: "dono_do_lead",
      prioridade: "medium",
    }),
  },
  // #2065 — os dois tipos de ação que a issue pede e que NÃO falam com o
  // cliente: mover o card no funil e gravar tag. O `defaultConfig` nasce vazio
  // de propósito (rascunho salva trabalho pela metade); o publish é quem exige
  // a escolha (`etapa_destino_ausente`, `tag_ausente`).
  move_lead: {
    type: "move_lead",
    paletteLabel: "Mover negócio no funil",
    icon: Funnel,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Mover card de etapa",
    defaultConfig: () => ({ stage_id: "" }),
  },
  edit_lead_tag: {
    type: "edit_lead_tag",
    paletteLabel: "Editar tag do negócio",
    icon: Tag,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Gravar tag no negócio",
    defaultConfig: () => ({ tags: [] }),
  },
  end: {
    type: "end",
    paletteLabel: "Fim",
    icon: Flag,
    chipClassName: "bg-error-bg text-error-fg",
    borderClassName: "border-l-error",
    defaultLabel: "Fim do fluxo",
    defaultConfig: () => ({ outcome: "exhausted" }),
  },
  crm_action: {
    type: "crm_action",
    paletteLabel: "Ações de CRM",
    icon: Kanban,
    chipClassName: "bg-success-bg text-success-fg",
    borderClassName: "border-l-success",
    defaultLabel: "Ações de CRM",
    defaultConfig: () => ({ actions: [{ type: "add_tags", target: "contact", tags: ["Nova tag"] }], on_error: "route" }),
  },
  field_op: {
    type: "field_op",
    paletteLabel: "Operação de campo",
    icon: PencilSimple,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Definir campo",
    defaultConfig: () => ({ ops: [{ target: { scope: "lead_custom", key: "campo" }, op: "set", value: "valor" }] }),
  },
  // Blocos de conversa (lote 2): o visual e a config com que o bloco nasce
  // (válida no schema; o formulário mora em forms/automacao/).
  message: {
    type: "message",
    paletteLabel: "Mensagem",
    icon: ChatsCircle,
    chipClassName: "bg-success-bg text-success-fg",
    borderClassName: "border-l-success",
    defaultLabel: "Enviar mensagem",
    defaultConfig: () => ({ body: "Olá, {{contact.name}}!" }),
  },
  question: {
    type: "question",
    paletteLabel: "Pergunta",
    icon: Question,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Fazer pergunta",
    defaultConfig: () => ({
      // E-mail e telefone do contato são só leitura para a automação (o publish
      // recusaria): o bloco nasce gravando num campo personalizado do negócio.
      question: "Qual é o melhor horário para falarmos?",
      save_to: { scope: "lead_custom", key: "resposta" },
      validation: "text",
      timeout_ms: 86_400_000,
      retries: 1,
    }),
  },
  // Blocos do Instagram (só automação de comentário): o formulário mora em forms/automacao/.
  instagram_private_reply: {
    type: "instagram_private_reply",
    paletteLabel: "Responder em privado",
    icon: InstagramLogo,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Responder em privado",
    defaultConfig: () => ({ text: "Oi, @{{gatilho.autor_usuario}}! Te mandei aqui o que você pediu." }),
  },
  instagram_public_reply: {
    type: "instagram_public_reply",
    paletteLabel: "Responder no comentário",
    icon: ChatCircle,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Responder no comentário",
    defaultConfig: () => ({ text: "Te chamei no Direct!" }),
  },
  instagram_check_follow: {
    type: "instagram_check_follow",
    paletteLabel: "Confere se segue",
    icon: Users,
    chipClassName: "bg-warning-bg text-warning-fg",
    borderClassName: "border-l-warning",
    defaultLabel: "Confere se segue",
    defaultConfig: () => ({}),
  },
  // Requisição HTTP (lote 4): o formulário mora em forms/automacao/HttpForm.tsx.
  http_request: {
    type: "http_request",
    paletteLabel: "Requisição HTTP",
    icon: Globe,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Requisição HTTP",
    defaultConfig: () => configHttpEmBranco(),
  },
};

/**
 * A paleta do editor de follow-up: só o que o motor do RELÓGIO executa. Pergunta
 * e Skill são do roteiro de atendimento (#1130) e ficam fora — a mesma lista
 * que o publish cobra (`NOS_DA_SUPERFICIE`), para a tela não oferecer caixa que
 * o publish recusa.
 */
export const NODE_VISUAL_LIST = NOS_DA_SUPERFICIE.followup.map((tipo) => NODE_VISUALS[tipo]);

type ConfigOf<T extends NodeType> = Extract<FlowNode, { type: T }>["config"];

/** "15 min", com espaço — o mesmo formato do card de espera, que dizia "5 min" enquanto este dizia "15min". */
function minutos(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

/**
 * One-line summary of a node's config — shown as the card subtitle. Takes the
 * RF node's own `type`/`data.config` pair (not a reconstructed `FlowNode`)
 * because the node components only ever see React Flow's generic shape.
 */
export function describeNodeConfig(
  type: NodeType,
  config: FlowNode["config"],
  // `t` OBRIGATÓRIO. Era opcional com padrão identidade, e foi assim que dois
  // cards que chegaram por outra branch (repetir e casar resposta) ficaram sem
  // tradução nenhuma sem o typecheck notar: em português o padrão devolve o
  // mesmo texto, então o esquecimento só aparecia para quem usa espanhol.
  t: (texto: string) => string,
  // Só o cartão Fim muda com a superfície: na automação o fim não tem "esgotado"
  // nem "convertido" para escolher, ele conclui. Ausente = follow-up.
  surface?: FollowupFlowSurface,
  // Nomes (automação, etapa, pessoa) para a frase do card de Ações de CRM;
  // ausente = a frase genérica ("escolhida").
  nomes?: NomesDaAutomacao,
): string {
  switch (type) {
    case "trigger": {
      // Na automação o Início carrega os gatilhos: o card diz quais.
      const gatilhos = (config as { triggers?: Array<{ kind: keyof typeof GATILHOS_DA_AUTOMACAO }> }).triggers;
      if (gatilhos && gatilhos.length > 0) return gatilhos.map((g) => t(GATILHOS_DA_AUTOMACAO[g.kind])).join(" · ");
      return t("Início do fluxo");
    }
    case "wait": {
      const c = config as ConfigOf<"wait">;
      const soNoHorario = (texto: string, h: unknown) => (h ? `${texto} · ${t("só em horário comercial")}` : texto);
      if (c.mode === "delay")
        return soNoHorario(c.duration_s < 60 ? `${c.duration_s} s` : minutos(c.duration_s * 1000), c.ate_o_horario);
      // Lote 6: a frase vem do plano de tempo (`Até amanhã, 09:00`).
      if (c.mode === "until_time") return soNoHorario(primeiraMaiuscula(fraseDaEsperaAteODia(c)), c.ate_o_horario);
      if (c.mode === "until_date_field")
        return soNoHorario(primeiraMaiuscula(fraseDaEsperaAteAData(c)), c.ate_o_horario);
      if (c.mode === "until_reply") return `${t("Até responder")} · ${minutos(c.timeout_ms)}`;
      // O horário da espera aparece no card: sem isto, "1440 min" prometia o
      // toque à mesma hora do dia seguinte, e o motor o segura até a próxima abertura.
      return c.mode === "fixed"
        ? c.ate_o_horario
          ? `${minutos(c.duration_ms)} · ${t("só em horário comercial")}`
          : minutos(c.duration_ms)
        : `${Math.round(c.min_ms / 60_000)}–${minutos(c.max_ms)} ${t("(adaptativo)")}`;
    }
    case "condition": {
      const c = config as ConfigOf<"condition">;
      // No modo uma-saída-por-regra o combinador NÃO é consultado (a regra não
      // vota, ela roteia). Continuar anunciando "E"/"OU" ali seria o card
      // afirmando uma coisa que o motor ignora — e o usuário acredita no card.
      if (c.branching === "per_check")
        return `${c.checks.length} ${c.checks.length === 1 ? t("regra · uma saída por regra") : t("regras · uma saída por regra")}`;
      return `${c.checks.length} ${c.checks.length === 1 ? t("condição") : t("condições")} · ${c.combinator === "and" ? t("E") : t("OU")}`;
    }
    // "grace" é o nome do CAMPO, não palavra nenhuma para quem tem uma loja — e o
    // formulário do mesmo nó já perguntava "Esperar a resposta por (minutos)".
    // O card dizia o número com dois nomes na mesma tela.
    case "ai_classify": {
      const c = config as ConfigOf<"ai_classify">;
      return `${c.classes.length} ${c.classes.length === 1 ? t("classe · espera") : t("classes · espera")} ${minutos(c.grace_timeout_ms)}`;
    }
    case "match_reply": {
      const c = config as ConfigOf<"match_reply">;
      return `${c.branches.length} ${c.branches.length === 1 ? t("regra · espera") : t("regras · espera")} ${minutos(c.grace_timeout_ms)}${
        c.save_to
          ? ` · ${t("grava resposta")}${c.if_exists === "skip" ? ` · ${t("pula se já existir")}` : c.if_exists === "confirm" ? ` · ${t("confirma se já existir")}` : ""}`
          : ""
      }`;
    }
    case "repeat": {
      const c = config as ConfigOf<"repeat">;
      return `${t("até")} ${c.max_count} ${c.max_count === 1 ? t("volta") : t("voltas")}`;
    }
    case "collect": {
      const c = config as ConfigOf<"collect">;
      return `${c.label} · ${c.required ? t("obrigatória") : t("opcional")}`;
    }
    case "skill": {
      const c = config as ConfigOf<"skill">;
      return c.skill_name;
    }
    case "action": {
      const c = config as ConfigOf<"action">;
      if (c.mode === "ai_message") return c.prompt_hint;
      if (c.mode === "text") return c.body;
      return t("Template fixo");
    }
    case "internal_task": {
      const c = config as ConfigOf<"internal_task">;
      const prazo = c.vence_em_dias === 0 ? t("hoje") : `+${c.vence_em_dias}d`;
      return `${c.titulo} · ${prazo} · ${t("sem mensagem ao cliente")}`;
    }
    // #2065 — o rótulo da etapa (nome de banco) não chega aqui: o card diz o
    // QUE faz, e o formulário diz PARA ONDE, com o nome da etapa escolhida.
    case "move_lead": {
      const c = config as ConfigOf<"move_lead">;
      return c.stage_id ? t("move o card para outra etapa do funil") : t("sem etapa de destino");
    }
    case "edit_lead_tag": {
      const c = config as ConfigOf<"edit_lead_tag">;
      return c.tags.length ? c.tags.join(", ") : t("sem tag escolhida");
    }
    case "end": {
      const c = config as ConfigOf<"end">;
      if (surface === "automacao") return t("Concluída");
      return t(RESULTADOS_DO_FIM[c.outcome]);
    }
    case "crm_action": {
      const c = config as ConfigOf<"crm_action">;
      const primeira = c.actions[0];
      const resto = c.actions.length > 1 ? ` +${c.actions.length - 1}` : "";
      return primeira ? `${fraseDaAcao(primeira, nomes)}${resto}` : "";
    }
    case "field_op": {
      const c = config as ConfigOf<"field_op">;
      const primeira = c.ops[0];
      const resto = c.ops.length > 1 ? ` +${c.ops.length - 1}` : "";
      return primeira ? `${fraseDaOperacao(primeira)}${resto}` : "";
    }
    case "message": {
      const c = config as ConfigOf<"message">;
      return c.options ? c.options.items.map((i) => i.label).join(" · ") : c.body.slice(0, 60);
    }
    case "question": {
      const c = config as ConfigOf<"question">;
      return c.question.slice(0, 60);
    }
    case "instagram_private_reply":
    case "instagram_public_reply": {
      const c = config as ConfigOf<"instagram_private_reply">;
      return c.text.slice(0, 60);
    }
    case "instagram_check_follow":
      return t("Segue o perfil?");
    case "http_request": {
      const c = config as ConfigOf<"http_request">;
      return `${c.method} ${c.url.replace(/^https:\/\//, "").slice(0, 50)}`;
    }
    default: {
      const exhaustive: never = type;
      return String(exhaustive);
    }
  }
}
