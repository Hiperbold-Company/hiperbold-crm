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
