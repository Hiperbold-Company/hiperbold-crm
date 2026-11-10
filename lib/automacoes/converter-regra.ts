/**
 * CONVERTER UMA REGRA ANTIGA (`automation_rules`, o "motor B") NUM GRAFO DE
 * AUTOMAÇÃO (superfície `automacao`) — lote 5, "tela única".
 *
 * Função PURA: recebe a linha da regra e devolve o grafo, ou a lista do que não
 * tem equivalente EXATO no motor novo. A regra é tudo ou nada: basta UM item em
 * `naoConvertido` para ela ficar como está, rodando no motor antigo. Converter
 * pela metade em silêncio é o pior desfecho — a regra "mudou de lugar" e parou
 * de fazer uma parte do que fazia, sem ninguém perceber.
 *
 * O que converte (e por que só isto):
 *   • Gatilhos: `lead.created` (com ou sem fonte de captação), `lead.stage_changed`
 *     QUANDO a regra fixa a etapa numa condição `lead.stage_id = X`,
 *     `lead.tag_added`/`contact.tag_added` QUANDO a regra fixa a tag numa
 *     condição `event.added_tags contém X`, os seis de agenda, `contact.birthday`
 *     no próprio dia. `message.received` NÃO converte: os dois motores não tratam a mesma
 *     mensagem do mesmo jeito (ver `GATILHOS_SEM_EQUIVALENTE`).
 *   • Condições: campos padrão e personalizados do negócio e do contato, a
 *     etapa e as tags, com os operadores que o motor novo compara igual.
 *   • Ações: pôr etiqueta, responsável fixo (sem levar contato e conversas),
 *     tarefa de prioridade média.
 *
 * O resto — ganho/perda/reabertura/troca de dono, telefone novo, falha de
 * envio, data do funil, silêncio, etapa parada; mensagem de WhatsApp (escolhe o
 * número; o bloco novo usa o da conversa), e-mail, IA, webhook (assina com o
 * segredo da regra, que não pode ir para o grafo em texto, e o corpo muda de
 * formato), criar/mover negócio entre funis, rodízio, plano de tarefas, data
 * do funil, aviso à equipe, iniciar fluxo — fica no motor antigo, com o motivo.
 */
import type { CrmAction, FieldRef, OperadorDeCampo } from "@/lib/automacoes/schemas";
import { CAMPOS_DO_CONTATO, CAMPOS_DO_NEGOCIO, type AutomacaoTrigger } from "@/lib/automacoes/schemas";
import type { FlowEdge, FlowGraph, FlowNode, NovaConditionCheck } from "@/lib/followup/graph-schema";

/** A linha de `automation_rules` que a conversão lê (o resto não importa). */
export interface RegraAntiga {
  id: string;
  name: string;
  trigger_event: string;
  trigger_config?: Record<string, unknown> | null;
  conditions: unknown;
  actions: unknown;
}

export interface ItemNaoConvertido {
  /** Onde: o gatilho, uma condição (índice) ou uma ação (índice). */
  parte: "gatilho" | "condicao" | "acao";
  indice?: number;
  /** O nome técnico (evento, campo ou tipo de ação), para o teste e o log. */
  item: string;
  /** Frase para quem opera, em português simples. */
  motivo: string;
}

export type ResultadoDaConversao =
  | { conversivel: true; grafo: FlowGraph; naoConvertido: [] }
  | { conversivel: false; grafo: null; naoConvertido: ItemNaoConvertido[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAVE = /^[a-z][a-z0-9_]*$/i;

/** Motivo por gatilho SEM equivalente. Um mapa: o teste confere que cada um tem frase. */
export const GATILHOS_SEM_EQUIVALENTE: Record<string, string> = {
  "lead.won": "O gatilho \"negócio ganho\" ainda não existe nas automações novas.",
  "lead.lost": "O gatilho \"negócio perdido\" ainda não existe nas automações novas.",
  "lead.reopened": "O gatilho \"negócio reaberto\" ainda não existe nas automações novas.",
  "lead.assigned": "O gatilho \"responsável mudou\" ainda não existe nas automações novas.",
  "message.failed": "O gatilho \"mensagem não entregue\" ainda não existe nas automações novas.",
  "contact.phone_added": "O gatilho \"contato ganhou telefone\" ainda não existe nas automações novas.",
  "lead.date_field_due": "O gatilho de data do funil dispara num horário diferente nas automações novas.",
  "lead.silent_for": "O gatilho \"negócio em silêncio\" conta o tempo de outro jeito nas automações novas.",
  "lead.stage_stale": "O gatilho \"negócio parado na etapa\" ainda não existe nas automações novas.",
  // Prova (medida em 10/11/2026): o motor antigo dispara em TODO `message.received` (lib/automation/engine.ts não filtra
  // tipo nem idade; lib/automation/engine.handler.ts:25 só pula canal desativado), e o gatilho novo descarta reação e
  // tipo não suportado (gatilhos.ts:257), mensagem com mais de 10 min (gatilhos.handler.ts, mensagemPodeDisparar) e
  // resposta a automação da conversa, e não tem a guarda de canal desativado. Grupo e `fromMe` coincidem (nenhum dos dois dispara).
  "message.received":
    "A regra dispara em toda mensagem recebida; a automação nova ignora reações, mensagens atrasadas e respostas a outra automação, e o comportamento não é idêntico.",
};

/** Motivo por ação SEM equivalente. */
export const ACOES_SEM_EQUIVALENTE: Record<string, string> = {
  send_whatsapp_message:
    "A mensagem de WhatsApp da regra escolhe o número que envia; o bloco novo usa o número da conversa.",
  send_email: "Enviar e-mail ainda não existe nas automações novas.",
  send_ai_message: "Mensagem escrita pela IA ainda não existe nas automações novas.",
  ai_decide: "A IA escolher a ação ainda não existe nas automações novas.",
  call_webhook:
    "O aviso a outro sistema assina com o segredo da regra e manda outro formato; não dá para levar sem expor o segredo.",
  create_or_move_lead:
    "Criar ou mover o negócio tem regras próprias entre funis no motor antigo (transferir, continuar no pós-venda).",
  start_message_flow: "Iniciar um follow-up a partir da regra ainda não existe nas automações novas.",
  apply_task_plan: "Plano de tarefas ainda não existe nas automações novas.",
  set_lead_date_field: "Gravar a data do atendimento num campo ainda não existe nas automações novas.",
  notify_team: "O aviso à equipe pelo WhatsApp da empresa ainda não existe nas automações novas.",
};

const EVENTOS_DE_AGENDA = ["created", "confirmed", "rescheduled", "cancelled", "completed", "no_show"] as const;

type Condicao = { field: string; op: string; value: string };

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A lista de condições do topo e o combinador. Grupo aninhado não é forma que a API grave. */
function lerCondicoes(raw: unknown): { lista: unknown[]; combinador: "and" | "or" } | null {
  if (raw === null || raw === undefined) return { lista: [], combinador: "and" };
  if (Array.isArray(raw)) return { lista: raw, combinador: "and" };
  if (ehObjeto(raw)) {
    if (Array.isArray(raw.all) && raw.any === undefined) return { lista: raw.all, combinador: "and" };
    if (Array.isArray(raw.any) && raw.all === undefined) return { lista: raw.any, combinador: "or" };
  }
  return null;
}

function ehCondicao(v: unknown): v is Condicao {
  return ehObjeto(v) && typeof v.field === "string" && typeof v.op === "string" && typeof v.value === "string";
}

const OP_DIRETO: Record<string, OperadorDeCampo> = {
  eq: "eq",
  neq: "neq",
  contains: "contains",
  not_contains: "not_contains",
  is_empty: "empty",
  is_not_empty: "has_value",
};
const OP_DE_ORDEM = new Set(["gt", "gte", "lt", "lte"]);

/** O campo do motor antigo (`lead.title`, `contact.custom_fields.x`) como `fieldRef` do novo. */
function campoNovo(field: string): FieldRef | null {
  const [escopo, ...resto] = field.split(".");
  if (escopo !== "lead" && escopo !== "contact") return null;
  if (resto.length === 2 && resto[0] === "custom_fields" && CHAVE.test(resto[1]!) && resto[1]!.length <= 40) {
    return escopo === "lead" ? { scope: "lead_custom", key: resto[1]! } : { scope: "contact_custom", key: resto[1]! };
  }
  if (resto.length !== 1) return null;
  const chave = resto[0]!;
  if (escopo === "lead" && (CAMPOS_DO_NEGOCIO as readonly string[]).includes(chave)) {
    return { scope: "lead", key: chave as (typeof CAMPOS_DO_NEGOCIO)[number] };
  }
  if (escopo === "contact" && (CAMPOS_DO_CONTATO as readonly string[]).includes(chave)) {
    return { scope: "contact", key: chave as (typeof CAMPOS_DO_CONTATO)[number] };
  }
  return null;
}

/** Uma condição antiga como regra nova, ou o motivo de não ter equivalente. */
function converterCondicao(c: Condicao): NovaConditionCheck | string {
  const valor = c.value.trim();
  // Tags: "contém X" numa lista é pertinência nos dois motores.
  if (c.field === "lead.tags" || c.field === "contact.tags") {
    const alvo = c.field === "lead.tags" ? "lead" : "contact";
    if ((c.op === "contains" || c.op === "not_contains") && valor.length > 0 && valor.length <= 60) {
      return { kind: "tag", target: alvo, op: c.op === "contains" ? "has_any" : "has_none", tags: [valor] };
    }
  }
  if (c.field === "lead.stage_id" && (c.op === "eq" || c.op === "neq") && UUID.test(valor)) {
    return { kind: "stage", op: c.op === "eq" ? "in" : "not_in", stage_ids: [valor] };
  }
  const campo = campoNovo(c.field);
  if (!campo) return `A condição sobre «${c.field}» ainda não existe nas automações novas.`;
  if (c.field === "lead.stage_id" || c.field === "lead.pipeline_id" || c.field === "lead.owner_user_id") {
    if (c.op !== "eq" && c.op !== "neq" && c.op !== "is_empty" && c.op !== "is_not_empty") {
      return `A condição «${c.field}» com este operador compara de outro jeito nas automações novas.`;
    }
  }
  const direto = OP_DIRETO[c.op];
  if (direto) {
    if (direto === "empty" || direto === "has_value") return { kind: "field", field: campo, op: direto };
    if (valor.length === 0 || valor.length > 500) return `A condição sobre «${c.field}» não tem valor para comparar.`;
    return { kind: "field", field: campo, op: direto, value: valor };
  }
  if (OP_DE_ORDEM.has(c.op)) {
    // O motor antigo compara texto qualquer em ordem alfabética; o novo só número e data.
    const numero = Number(valor);
    if (valor !== "" && Number.isFinite(numero)) {
      return { kind: "field", field: campo, op: c.op as OperadorDeCampo, value: numero };
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(valor)) return { kind: "field", field: campo, op: c.op as OperadorDeCampo, value: valor };
    return `A comparação «maior/menor» sobre «${c.field}» com texto funciona de outro jeito nas automações novas.`;
  }
  return `O operador «${c.op}» ainda não existe nas automações novas.`;
}

/** Ação antiga → ação de CRM nova, ou o motivo. */
function converterAcao(raw: unknown): CrmAction | string {
  if (!ehObjeto(raw) || typeof raw.type !== "string") return "Ação sem tipo: não dá para ler.";
  const tipo = raw.type;
  const config = ehObjeto(raw.config) ? raw.config : {};
  if (tipo === "add_tag") {
    const tags = Array.isArray(config.tags) ? config.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "") : [];
    if (tags.length === 0 || tags.length > 10 || tags.some((t) => t.trim().length > 60)) return "A etiqueta da regra está vazia ou grande demais.";
    return { type: "add_tags", target: config.destino === "contato" ? "contact" : "lead", tags: tags.map((t) => t.trim()) };
  }
  if (tipo === "assign_owner") {
    const modo = config.modo ?? "fixo";
    if (modo !== "fixo") return "O rodízio e o destino dinâmico da regra contam a vez de outro jeito nas automações novas.";
    if (config.contato === true || config.conversas === true) {
      return "A regra leva o contato e as conversas junto com o responsável; o bloco novo troca só o responsável do negócio.";
    }
    if (typeof config.user_id !== "string" || !UUID.test(config.user_id)) return "O responsável da regra não está escolhido.";
    return { type: "set_owner", mode: { m: "user", user_id: config.user_id } };
  }
  if (tipo === "create_task") {
    if (config.prioridade !== "medium") return "A tarefa da regra tem prioridade própria; a tarefa nova nasce sempre com prioridade média.";
    const titulo = typeof config.titulo === "string" ? config.titulo.trim() : "";
    const dias = config.vence_em_dias;
    if (!titulo || titulo.length > 200 || typeof dias !== "number" || !Number.isInteger(dias) || dias < 0 || dias > 365) {
      return "A tarefa da regra está incompleta.";
    }
    const atribuir = config.atribuir_a;
    let assignee: "owner" | string;
    if (atribuir === "dono_do_lead") assignee = "owner";
    else if (ehObjeto(atribuir) && typeof atribuir.usuario_id === "string" && UUID.test(atribuir.usuario_id)) assignee = atribuir.usuario_id;
    else return "A tarefa da regra não diz para quem é.";
    return { type: "create_task", title: titulo, due_in_minutes: dias * 1440, assignee };
  }
  return ACOES_SEM_EQUIVALENTE[tipo] ?? `A ação «${tipo}» ainda não existe nas automações novas.`;
}

/**
 * O gatilho novo. `consumidas` são as condições que viraram parte do gatilho
 * (a etapa do "mudou de etapa", a tag do "tag adicionada") — elas saem da
 * condição para não serem conferidas duas vezes.
 */
function converterGatilho(
  regra: RegraAntiga,
  condicoes: { lista: unknown[]; combinador: "and" | "or" },
): { gatilho: AutomacaoTrigger; consumidas: Set<number> } | string {
  const ev = regra.trigger_event;
  const cfg = ehObjeto(regra.trigger_config) ? regra.trigger_config : {};
  if (cfg.uma_vez_por_contato === true) return "A regra roda uma vez só por contato; as automações novas ainda não têm essa trava.";
  const consumidas = new Set<number>();
  // Só uma condição E (ou a única) pode virar parte do gatilho: num OU ela não restringe tudo.
  const fixa = (teste: (c: Condicao) => boolean): { i: number; c: Condicao } | null => {
    if (condicoes.combinador === "or" && condicoes.lista.length > 1) return null;
    for (const [i, c] of condicoes.lista.entries()) if (ehCondicao(c) && teste(c)) return { i, c };
    return null;
  };

  if (ev === "lead.created") {
    const fonte = cfg.webhook_source_id;
    if (fonte !== undefined && fonte !== null) {
      if (typeof fonte !== "string" || !UUID.test(fonte)) return "A fonte de captação da regra não é válida.";
      return { gatilho: { kind: "lead_created", capture_source_ids: [fonte] }, consumidas };
    }
    return { gatilho: { kind: "lead_created" }, consumidas };
  }
  if (ev === "lead.stage_changed") {
    const achada = fixa((c) => c.field === "lead.stage_id" && c.op === "eq" && UUID.test(c.value.trim()));
    if (!achada) return "A regra dispara em qualquer troca de etapa; a automação nova precisa saber qual etapa.";
    consumidas.add(achada.i);
    return { gatilho: { kind: "stage_entered", stage_ids: [achada.c.value.trim()], via: "moved" }, consumidas };
  }
  if (ev === "lead.tag_added" || ev === "contact.tag_added") {
    const achada = fixa(
      (c) => c.field === "event.added_tags" && c.op === "contains" && c.value.trim().length > 0 && c.value.trim().length <= 60,
    );
    if (!achada) return "A regra dispara com qualquer etiqueta; a automação nova precisa saber qual etiqueta.";
    consumidas.add(achada.i);
    return {
      gatilho: { kind: "tag_added", target: ev === "lead.tag_added" ? "lead" : "contact", tags: [achada.c.value.trim()] },
      consumidas,
    };
  }
  if (ev.startsWith("appointment.")) {
    const evento = ev.slice("appointment.".length);
    if ((EVENTOS_DE_AGENDA as readonly string[]).includes(evento)) {
      return { gatilho: { kind: "appointment", events: [evento as (typeof EVENTOS_DE_AGENDA)[number]] }, consumidas };
    }
  }
  if (ev === "contact.birthday") {
    const dias = cfg.dias_antecedencia;
    if (dias !== undefined && dias !== 0) return "A regra avisa dias antes do aniversário; a automação nova dispara no dia.";
    return { gatilho: { kind: "birthday" }, consumidas };
  }
  return GATILHOS_SEM_EQUIVALENTE[ev] ?? `O gatilho «${ev}» ainda não existe nas automações novas.`;
}

const POS = (y: number) => ({ x: 0, y });
const aresta = (id: string, source: string, target: string, condition: FlowEdge["condition"], priority = 0): FlowEdge => ({
  id,
  source,
  target,
  priority,
  condition,
});

export function converterRegra(regra: RegraAntiga): ResultadoDaConversao {
  const nao: ItemNaoConvertido[] = [];
  const condicoes = lerCondicoes(regra.conditions);
  if (!condicoes) {
    return {
      conversivel: false,
      grafo: null,
      naoConvertido: [{ parte: "condicao", item: "grupo", motivo: "As condições da regra estão num formato que a tela não edita." }],
    };
  }

  const g = converterGatilho(regra, condicoes);
  if (typeof g === "string") nao.push({ parte: "gatilho", item: regra.trigger_event, motivo: g });
  const consumidas = typeof g === "string" ? new Set<number>() : g.consumidas;

  const checks: NovaConditionCheck[] = [];
  condicoes.lista.forEach((c, i) => {
    if (consumidas.has(i)) return;
    if (!ehCondicao(c)) {
      nao.push({ parte: "condicao", indice: i, item: "grupo", motivo: "Grupo de condições dentro de outro grupo não existe nas automações novas." });
      return;
    }
    const nova = converterCondicao(c);
    if (typeof nova === "string") nao.push({ parte: "condicao", indice: i, item: c.field, motivo: nova });
    else checks.push(nova);
  });

  const acoesBrutas = Array.isArray(regra.actions) ? regra.actions : [];
  const acoes: CrmAction[] = [];
  if (acoesBrutas.length === 0 || acoesBrutas.length > 10) {
    nao.push({ parte: "acao", item: "acoes", motivo: "A regra não tem ações que dê para levar." });
  }
  acoesBrutas.forEach((a, i) => {
    const nova = converterAcao(a);
    const tipo = ehObjeto(a) && typeof a.type === "string" ? a.type : "desconhecida";
    if (typeof nova === "string") nao.push({ parte: "acao", indice: i, item: tipo, motivo: nova });
    else acoes.push(nova);
  });

  if (nao.length > 0 || typeof g === "string") return { conversivel: false, grafo: null, naoConvertido: nao };

  const nodes: FlowNode[] = [
    {
      id: "n1",
      type: "trigger",
      label: "Início",
      position: POS(0),
      config: { triggers: [g.gatilho], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
    },
  ];
  const edges: FlowEdge[] = [];
  const acaoNo: FlowNode = {
    id: "n3",
    type: "crm_action",
    label: "Ações da regra",
    position: POS(checks.length > 0 ? 400 : 200),
    // `continue`: o motor antigo roda cada ação mesmo que uma anterior falhe.
    config: { actions: acoes, on_error: "continue" },
  };
  const fim: FlowNode = { id: "n4", type: "end", label: "Fim", position: POS(checks.length > 0 ? 600 : 400), config: { outcome: "converted" } };
  if (checks.length > 0) {
    nodes.push({
      id: "n2",
      type: "condition",
      label: "Condições da regra",
      position: POS(200),
      config: { combinator: condicoes.combinador, checks },
    });
    nodes.push(acaoNo, fim);
    edges.push(aresta("e1", "n1", "n2", { type: "always" }));
    edges.push(aresta("e2", "n2", "n3", { type: "cond_result", value: true }));
    edges.push(aresta("e3", "n2", "n4", { type: "cond_result", value: false }, 1));
    edges.push(aresta("e4", "n3", "n4", { type: "always" }));
  } else {
    nodes.push(acaoNo, fim);
    edges.push(aresta("e1", "n1", "n3", { type: "always" }));
    edges.push(aresta("e4", "n3", "n4", { type: "always" }));
  }
  return { conversivel: true, grafo: { nodes, edges }, naoConvertido: [] };
}
