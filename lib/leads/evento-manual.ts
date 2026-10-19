/**
 * O EVENTO MANUAL da linha do tempo: a equipe registra à mão o que aconteceu fora
 * do CRM — uma ligação, uma reunião, um e-mail, uma conversa de WhatsApp em outro
 * aparelho.
 *
 * ─── Como é gravado (e por que assim) ──────────────────────────────────────────
 *
 * UMA linha em `crm_lead_activities` com `type = 'note'` (já existe no vocabulário,
 * `lib/leads/activity-vocabulary.ts`), `source_module = 'manual'` e o detalhe no
 * `payload`: `{ subtype, text }`.
 *
 * Tipos novos por subtipo (`call_logged`, `meeting_logged`…) ficaram de fora de
 * propósito, por três razões medidas:
 *  - `fn_update_last_activity_at` (migration 0079) carimba o relógio do silêncio
 *    por LISTA POSITIVA de tipos, e `note` já está nela ("alguém registrou
 *    trabalho no negócio"). Ligação registrada à mão TEM de quebrar o silêncio do
 *    negócio; um tipo novo ficaria fora da lista e o Radar continuaria dizendo
 *    "sem contato" logo depois de a equipe ter ligado — e acrescentar na lista
 *    exige migration, que esta entrega não faz;
 *  - o subtipo é rótulo de exibição, não identidade de comportamento: nada
 *    consome "ligação" diferente de "reunião";
 *  - `note` reaproveita `NUNCA_COLAPSA`, rótulo e relatórios existentes.
 *
 * ─── A data do evento ──────────────────────────────────────────────────────────
 *
 * A data escolhida vai para `performed_at` (a coluna que ordena a linha do tempo,
 * o cursor e o relógio do silêncio). `created_at` continua sendo QUANDO o registro
 * foi feito — a diferença entre "aconteceu" e "foi anotado" não se perde. Como o
 * trigger usa `greatest(last_activity_at, performed_at)`, um evento no passado
 * nunca faz o relógio andar para trás.
 */
import { z } from "zod";

export const SUBTIPOS_DE_EVENTO_MANUAL = [
  "nota",
  "ligacao",
  "reuniao",
  "email",
  "whatsapp",
  "outro",
] as const;
export type SubtipoDeEventoManual = (typeof SUBTIPOS_DE_EVENTO_MANUAL)[number];

/** Rótulos em português; a tela passa por `t()` (a chave é o texto). */
export const ROTULO_DO_SUBTIPO: Record<SubtipoDeEventoManual, string> = {
  nota: "Nota",
  ligacao: "Ligação",
  reuniao: "Reunião",
  email: "E-mail",
  whatsapp: "WhatsApp",
  outro: "Outro",
};

/** `crm_lead_activities.source_module` dos eventos registrados à mão. */
export const ORIGEM_DO_EVENTO_MANUAL = "manual";

export const TEXTO_MAXIMO_DO_EVENTO = 2000;

/**
 * Folga entre o relógio do navegador e o do servidor. "Agora" escolhido no
 * formulário chega alguns segundos adiantado se o computador da pessoa estiver
 * um pouco à frente, e recusar isso como "data no futuro" seria o erro de quem
 * só queria registrar o que acabou de acontecer.
 */
export const FOLGA_DE_RELOGIO_MS = 5 * 60_000;

/** O evento não pode ser anterior a isto: data de ano 0001 é lixo, não histórico. */
export const PISO_DO_EVENTO = "2000-01-01T00:00:00.000Z";

/**
 * Quanto antes do REGISTRO um evento precisa estar para a linha do tempo dizer
 * também "registrado em …": um evento de ontem anotado hoje não é o mesmo que um
 * anotado na hora, e a data do evento sozinha esconderia a diferença.
 */
export const LIMIAR_DE_RETROATIVO_MS = 60 * 60_000;

export function foiRetroativo(performedAt: string, createdAt: string | null | undefined): boolean {
  if (!createdAt) return false;
  return new Date(createdAt).getTime() - new Date(performedAt).getTime() > LIMIAR_DE_RETROATIVO_MS;
}

export const eventoManualSchema = z
  .object({
    subtype: z.enum(SUBTIPOS_DE_EVENTO_MANUAL),
    text: z
      .string()
      .trim()
      .min(1, "Escreva o que aconteceu.")
      .max(TEXTO_MAXIMO_DO_EVENTO, `Use até ${TEXTO_MAXIMO_DO_EVENTO} caracteres.`),
    /** ISO-8601. Ausente é "agora". Pode ser no passado; no futuro, não. */
    occurred_at: z
      .string()
      .datetime({ offset: true, message: "Data e hora inválidas." })
      .refine((v) => new Date(v).getTime() >= Date.parse(PISO_DO_EVENTO), {
        message: "Data e hora inválidas.",
      })
      .optional(),
  })
  .strict();
export type EventoManualInput = z.infer<typeof eventoManualSchema>;

/** `true` quando o instante está além de "agora" mais a folga de relógio. */
export function estaNoFuturo(iso: string, agora: number = Date.now()): boolean {
  return new Date(iso).getTime() > agora + FOLGA_DE_RELOGIO_MS;
}

/** O que a linha do tempo precisa para desenhar um evento manual; `null` se não é um. */
export function eventoManualDaAtividade(item: {
  type: string;
  source_module?: string | null;
  payload?: Record<string, unknown> | null;
}): { subtype: SubtipoDeEventoManual; text: string } | null {
  if (item.type !== "note" || item.source_module !== ORIGEM_DO_EVENTO_MANUAL) return null;
  const p = item.payload ?? {};
  const text = typeof p.text === "string" ? p.text : "";
  const subtype = SUBTIPOS_DE_EVENTO_MANUAL.find((s) => s === p.subtype) ?? "outro";
  return { subtype, text };
}
