/**
 * Schemas dos blocos de AUTOMAÇÃO (superfície `automacao`, lote 1).
 *
 * O motor é o dos follow-ups (`lib/followup/engine.ts`); aqui mora só o
 * contrato dos blocos que nasceram com as automações: a referência a campo
 * (`fieldRef`), as ações de CRM, a operação de campo, as condições novas e os
 * gatilhos. `graph-schema.ts` os pendura no grafo — este arquivo NÃO importa o
 * grafo, para não fechar ciclo de import.
 *
 * Os textos aceitam `{{...}}` (ver `lib/automation/template.ts`).
 */
import { z } from "zod";

/** Texto com variáveis `{{...}}`. */
export const tpl = (max = 4000) => z.string().max(max);

const uuid = z.string().uuid();
const chaveDeCampo = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/i, "Use letras, números e underscore")
  .max(40);

/** Campos padrão do CONTATO que uma automação lê ou escreve. */
export const CAMPOS_DO_CONTATO = ["name", "email", "phone_number", "birthdate", "tags"] as const;
/** Campos padrão do NEGÓCIO que uma automação lê ou escreve. */
export const CAMPOS_DO_NEGOCIO = [
  "title",
  "value_cents",
  "stage_id",
  "pipeline_id",
  "status",
  "owner_user_id",
  "source",
  "tags",
  "expected_close_date",
] as const;

/**
 * Onde mora o valor que um bloco lê ou escreve. `var` é só leitura (o gatilho
 * e o que blocos anteriores guardaram).
 */
export const fieldRefSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("contact"), key: z.enum(CAMPOS_DO_CONTATO) }),
  z.strictObject({ scope: z.literal("contact_custom"), key: chaveDeCampo }),
  z.strictObject({ scope: z.literal("lead"), key: z.enum(CAMPOS_DO_NEGOCIO) }),
  z.strictObject({ scope: z.literal("lead_custom"), key: chaveDeCampo }),
  z.strictObject({
    scope: z.literal("var"),
    path: z
      .string()
      .regex(/^(gatilho|param|resposta|saida)\.[a-z0-9_.[\]]+$/i)
      .max(120),
  }),
]);
export type FieldRef = z.infer<typeof fieldRefSchema>;

const tags = z.array(z.string().trim().min(1).max(60)).min(1).max(10);

/** Chave de um dado passado a outra automação (`{{param.<chave>}}`). */
export const CHAVE_DE_PARAMETRO = /^[a-z0-9_]{1,40}$/;
/** Quantos dados uma ação "Iniciar automação" passa, e o tamanho de cada valor já renderizado. */
export const MAX_PARAMETROS = 10;
export const MAX_VALOR_DE_PARAMETRO = 1000;

// ---------------------------------------------------------------------------
// Ações de CRM (bloco `crm_action`)
// ---------------------------------------------------------------------------

export const crmActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create_deal"),
    pipeline_id: uuid,
    stage_id: uuid,
    /** Já existe negócio ABERTO do contato neste funil: pular, mover para a etapa, ou criar outro. */
    if_open_exists: z.enum(["skip", "move", "create_new"]),
    title: tpl(200).optional(),
    value_cents: z.number().int().min(0).optional(),
  }),
  z.strictObject({ type: z.literal("move_deal"), pipeline_id: uuid, stage_id: uuid }),
  z.strictObject({ type: z.literal("win_deal"), reason: tpl(500).optional() }),
  z.strictObject({ type: z.literal("lose_deal"), reason: tpl(500).min(1) }),
  z.strictObject({ type: z.literal("add_tags"), target: z.enum(["lead", "contact"]), tags }),
  z.strictObject({ type: z.literal("remove_tags"), target: z.enum(["lead", "contact"]), tags }),
  z.strictObject({
    type: z.literal("set_owner"),
    mode: z.discriminatedUnion("m", [
      z.strictObject({ m: z.literal("user"), user_id: uuid }),
      /** Rodízio: entre os atendentes listados (ou todos os atendentes ativos, sem lista). */
      z.strictObject({ m: z.literal("round_robin"), user_ids: z.array(uuid).max(50).optional() }),
    ]),
  }),
  z.strictObject({
    type: z.literal("notify"),
    to: z.union([z.literal("owner"), z.array(uuid).min(1).max(10)]),
    message: tpl(500).min(1),
  }),
  z.strictObject({
    type: z.literal("create_task"),
    title: tpl(200).min(1),
    due_in_minutes: z.number().int().min(0).max(525_600),
    assignee: z.union([z.literal("owner"), uuid]),
  }),
  z.strictObject({ type: z.literal("add_note"), body: tpl(2000).min(1), target: z.enum(["lead", "contact"]) }),
  /**
   * Iniciar OUTRA automação para o mesmo contato, passando dados: cada
   * `params[].value` é renderizado com as variáveis desta execução e chega ao
   * destino como `{{param.<key>}}`. A cadeia, o ciclo e a profundidade (5) são
   * os do `fn_automacao_iniciar`; os eventos guardam só as CHAVES (LGPD).
   */
  z.strictObject({
    type: z.literal("start_automation"),
    pointer_id: uuid,
    params: z
      .array(
        z.strictObject({
          key: z.string().regex(CHAVE_DE_PARAMETRO, "Use letras minúsculas, números e underscore").max(40),
          value: tpl(MAX_VALOR_DE_PARAMETRO),
        }),
      )
      .max(MAX_PARAMETROS)
      .refine((ps) => new Set(ps.map((p) => p.key)).size === ps.length, { message: "chave repetida" }),
  }),
]);
export type CrmAction = z.infer<typeof crmActionSchema>;
export type CrmActionType = CrmAction["type"];

export const crmActionConfigSchema = z.strictObject({
  actions: z.array(crmActionSchema).min(1).max(10),
  /** `route`: a primeira ação que falha manda o contato pela saída "Erro". `continue`: segue as outras e sai por "Concluído". */
  on_error: z.enum(["route", "continue"]),
});
export type CrmActionConfig = z.infer<typeof crmActionConfigSchema>;

// ---------------------------------------------------------------------------
// Operação de campo (bloco `field_op`)
// ---------------------------------------------------------------------------

export const fieldOpSchema = z
  .strictObject({
    target: fieldRefSchema,
    op: z.enum(["set", "clear", "append", "increment"]),
    value: tpl(2000).optional(),
  })
  .refine((o) => o.target.scope !== "var", { message: "variável é só leitura", path: ["target"] })
  .refine((o) => o.op === "clear" || (o.value ?? "").length > 0, {
    message: "informe o valor",
    path: ["value"],
  });
export type FieldOp = z.infer<typeof fieldOpSchema>;

export const fieldOpConfigSchema = z.strictObject({
  ops: z.array(fieldOpSchema).min(1).max(20),
});
export type FieldOpConfig = z.infer<typeof fieldOpConfigSchema>;

// ---------------------------------------------------------------------------
// Condições novas (dentro do bloco `condition`, ao lado das legadas)
// ---------------------------------------------------------------------------

export const OPERADORES_DE_CAMPO = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "starts_with",
  "has_value",
  "empty",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;
export type OperadorDeCampo = (typeof OPERADORES_DE_CAMPO)[number];

/**
 * As regras novas, discriminadas por `kind`. `id`/`label` (identidade do ramo
 * em `per_check`) são acrescentados por `graph-schema.ts`, que conhece o
 * vocabulário de ramos reservados.
 */
export const regrasNovasDeCondicao = {
  field: {
    kind: z.literal("field"),
    field: fieldRefSchema,
    op: z.enum(OPERADORES_DE_CAMPO),
    value: z.union([z.string().max(500), z.number()]).optional(),
  },
  tag: {
    kind: z.literal("tag"),
    target: z.enum(["lead", "contact"]),
    op: z.enum(["has_any", "has_all", "has_none"]),
    tags,
  },
  stage: { kind: z.literal("stage"), op: z.enum(["in", "not_in"]), stage_ids: z.array(uuid).min(1).max(50) },
  open_deal_in_pipeline: { kind: z.literal("open_deal_in_pipeline"), pipeline_id: uuid },
  deal_exists: { kind: z.literal("deal_exists") },
  deal_status: { kind: z.literal("deal_status"), status: z.enum(["open", "won", "lost"]) },
} as const;

// ---------------------------------------------------------------------------
// Gatilhos (no nó `trigger` de uma automação)
// ---------------------------------------------------------------------------

/** Como a palavra-chave da mensagem recebida é comparada. */
export const MODOS_DA_PALAVRA_CHAVE = ["any", "contains", "equals", "starts_with"] as const;
export type ModoDaPalavraChave = (typeof MODOS_DA_PALAVRA_CHAVE)[number];

/** Os acontecimentos da agenda que iniciam uma automação (`appointment.<evento>`). */
export const EVENTOS_DE_AGENDAMENTO = ["created", "confirmed", "rescheduled", "cancelled", "completed", "no_show"] as const;
export type EventoDeAgendamento = (typeof EVENTOS_DE_AGENDAMENTO)[number];

/**
 * O campo de DATA do negócio que o gatilho `date_field` lê: a previsão de
 * fechamento, ou a chave de um campo personalizado do funil
 * (`pipelines.settings.fields`). O mesmo `fieldRef` dos blocos, recortado.
 */
export const campoDeDataDoNegocioSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("lead"), key: z.literal("expected_close_date") }),
  z.strictObject({ scope: z.literal("lead_custom"), key: chaveDeCampo }),
]);
export type CampoDeDataDoNegocio = z.infer<typeof campoDeDataDoNegocioSchema>;

export const automacaoTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({
    kind: z.literal("lead_created"),
    pipeline_ids: z.array(uuid).max(20).optional(),
    /** Só negócios que entraram por uma destas fontes de captação (`webhook_sources`). */
    capture_source_ids: z.array(uuid).max(20).optional(),
    /** Só negócios que entraram por QUALQUER fonte de captação. */
    only_capture: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("stage_entered"),
    stage_ids: z.array(uuid).min(1).max(20),
    via: z.enum(["any", "created", "moved"]),
  }),
  // ---- lote 3 ----
  /**
   * Mensagem recebida do contato. A palavra-chave é comparada sem acento e sem
   * maiúsculas, por PALAVRA ou FRASE inteira (`contains`): "oi" não casa "oito"
   * (ver `palavraChaveCasa` em `gatilhos.ts`). `keywords` só pode ficar vazia
   * com `match: any`.
   */
  z
    .strictObject({
      kind: z.literal("message_received"),
      match: z.enum(MODOS_DA_PALAVRA_CHAVE),
      keywords: z.array(z.string().trim().min(1).max(100)).max(20),
      /** Só mensagens que chegaram por estes números/canais (`channel_sessions.id`). */
      channel_session_ids: z.array(uuid).max(20).optional(),
      /** Só a primeira mensagem do contato naquela conversa. */
      only_first_message: z.boolean().optional(),
    })
    .refine((g) => g.match === "any" || g.keywords.length > 0, {
      message: "informe ao menos uma palavra-chave",
      path: ["keywords"],
    }),
  z.strictObject({
    kind: z.literal("tag_added"),
    target: z.enum(["lead", "contact"]),
    tags: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  }),
  z.strictObject({
    kind: z.literal("appointment"),
    events: z.array(z.enum(EVENTOS_DE_AGENDAMENTO)).min(1).max(6),
  }),
  /** No aniversário do contato (a varredura `contact-birthdays` emite `contact.birthday`). */
  z.strictObject({ kind: z.literal("birthday") }),
  /**
   * Numa data guardada no negócio. `offset_days` é ASSINADO em relação à data:
   * `-3` = três dias ANTES, `2` = dois dias DEPOIS, `0` = no dia. `time` é a
   * hora local da organização a partir da qual a execução começa.
   */
  z.strictObject({
    kind: z.literal("date_field"),
    field: campoDeDataDoNegocioSchema,
    offset_days: z.number().int().min(-365).max(365),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM"),
  }),
  /** O contato não respondeu à última mensagem enviada há `after_minutes`. */
  z.strictObject({
    kind: z.literal("no_reply"),
    after_minutes: z.number().int().min(5).max(43_200),
    only_if_last_was_outbound: z.literal(true),
  }),
  /** Caso aberto na Central (`ai.case_opened`). */
  z.strictObject({ kind: z.literal("case_opened") }),
  /**
   * Iniciada por outra automação (ação "Iniciar automação"), ou pelo "Testar".
   * Nenhum evento do log a casa. `from_pointer_ids` vazio ou ausente = qualquer
   * automação da organização; com lista, só as listadas (`aceitaIniciador`).
   */
  z.strictObject({
    kind: z.literal("started_by_automation"),
    from_pointer_ids: z.array(uuid).max(20).optional(),
  }),
]);
export type AutomacaoTrigger = z.infer<typeof automacaoTriggerSchema>;
export type AutomacaoTriggerKind = AutomacaoTrigger["kind"];

export const automacaoTriggerConfigSchema = z.strictObject({
  triggers: z.array(automacaoTriggerSchema).min(1).max(5),
  reentry: z.strictObject({
    policy: z.enum(["skip_if_running", "restart"]),
    cooldown_minutes: z.number().int().min(0).max(43_200),
  }),
});
export type AutomacaoTriggerConfig = z.infer<typeof automacaoTriggerConfigSchema>;

/**
 * O gatilho traz um CONTATO para a execução? Os blocos de mensagem e pergunta
 * precisam dele (é a quem se escreve). Hoje todos trazem — a execução nasce
 * sempre de um contato (`fn_automacao_iniciar`) —, e um gatilho novo sem
 * contato tem de se declarar aqui para o publish recusar a mensagem.
 */
export const GATILHO_TRAZ_CONTATO: Record<AutomacaoTriggerKind, boolean> = {
  manual: true,
  lead_created: true,
  stage_entered: true,
  message_received: true,
  tag_added: true,
  appointment: true,
  birthday: true,
  date_field: true,
  no_reply: true,
  case_opened: true,
  started_by_automation: true,
};

/**
 * Config inicial de CADA gatilho (o editor usa ao trocar o tipo). Os que pedem
 * escolha (etapa, tag, palavra-chave, campo) nascem incompletos de propósito:
 * o schema recusa até a pessoa escolher.
 */
export const GATILHO_EM_BRANCO: { [K in AutomacaoTriggerKind]: Extract<AutomacaoTrigger, { kind: K }> } = {
  manual: { kind: "manual" },
  lead_created: { kind: "lead_created" },
  stage_entered: { kind: "stage_entered", stage_ids: [], via: "any" },
  message_received: { kind: "message_received", match: "any", keywords: [] },
  tag_added: { kind: "tag_added", target: "lead", tags: [] },
  appointment: { kind: "appointment", events: ["created"] },
  birthday: { kind: "birthday" },
  date_field: { kind: "date_field", field: { scope: "lead", key: "expected_close_date" }, offset_days: 0, time: "09:00" },
  no_reply: { kind: "no_reply", after_minutes: 1440, only_if_last_was_outbound: true },
  case_opened: { kind: "case_opened" },
  started_by_automation: { kind: "started_by_automation" },
};

/** Config inicial do gatilho de uma automação nova. */
export const GATILHO_PADRAO: AutomacaoTriggerConfig = {
  triggers: [{ kind: "manual" }],
  reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
};

// ---------------------------------------------------------------------------
// Limites do motor na raia `automacao`
// ---------------------------------------------------------------------------

/** Passos por execução (follow-up: 80). */
export const MAX_PASSOS_DA_AUTOMACAO = 400;
/** Visitas a um mesmo bloco numa execução — trava "ir para" em laço. */
export const MAX_VISITAS_POR_NO = 20;
/** Blocos instantâneos executados em sequência num tick, antes de devolver o claim. */
export const ORCAMENTO_DE_PASSOS_POR_TICK = 25;
/** Tempo de relógio por tick dentro do lease de 120 s do claim. */
export const ORCAMENTO_DE_TEMPO_POR_TICK_MS = 20_000;
/**
 * Teto de mensagens automáticas por contato por hora (knob). O lote 1 não tem
 * bloco de mensagem; o lote 2 aplica este teto no efeito de envio.
 */
export const TETO_DE_MENSAGENS_POR_CONTATO_POR_HORA = 30;
