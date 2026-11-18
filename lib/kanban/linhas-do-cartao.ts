/**
 * AS LINHAS DO CARTÃO DO FUNIL ("Editar cartão").
 *
 * A área de contato do card (abaixo da faixa do agente) mostra ATÉ 5 linhas,
 * escolhidas por funil e iguais para toda a equipe. Cada linha é UM campo de um
 * vocabulário fechado — campo personalizado não entra, decisão do dono do produto.
 *
 * ─── Onde mora ───────────────────────────────────────────────────────────────
 *
 * `crm_pipelines.settings.card_lines`: um array de strings deste vocabulário.
 * Doutrina DIRC: é REFERÊNCIA (o nome do campo), nunca cópia do valor. A tela
 * não lê o caminho do jsonb: quem lê é `linhasDoCartao`, e quem grava é a rota
 * `PATCH /api/v1/pipelines/[id]/card-lines` (anti-pattern 6 do CLAUDE.md).
 *
 * ─── Ausente ≠ vazio ─────────────────────────────────────────────────────────
 *
 * Chave AUSENTE (funil nunca configurado) ou valor inválido → o padrão, que é o
 * card de sempre: última mensagem e telefone, nessa ordem. Nenhum funil muda de
 * aparência sem alguém salvar. `[]` é escolha válida ("não quero linha
 * nenhuma") e é respeitada. "Voltar ao padrão" APAGA a chave, para o funil
 * voltar a "nunca configurado" e o padrão morar num lugar só (aqui).
 *
 * ─── De onde vem cada valor ──────────────────────────────────────────────────
 *
 *  - `email`           → `contacts.email`            (`lead.contact_email`)
 *  - `telefone`        → `contacts.phone_number`     (`lead.contact_phone`)
 *  - `empresa`/`cargo` → `contacts.custom_fields` (empresa/company/company_name,
 *                        cargo/job_title), com queda em `crm_leads.custom_fields`
 *                        — a mesma regra do dossiê (`cargoEEmpresa`). Não há
 *                        coluna nativa para nenhum dos dois.
 *  - `ultima_mensagem` → `conversations.last_message_preview` da conversa mais
 *                        recente do contato (`lead.conversa.preview`)
 *  - `origem`          → `crm_leads.source`
 *  - `utm_*`           → `crm_leads.custom_fields->>utm_*` (onde a captação grava;
 *                        mesma fonte da coluna de UTM da lista de Contatos)
 *
 * PURO: sem banco, sem React.
 */
import { z } from "zod";

import { cargoEEmpresa } from "@/lib/contacts/cargo-e-empresa";
import type { Lead } from "@/lib/types/leads";

/** O vocabulário fechado. A ordem é a do Select do modal. */
export const CAMPOS_DO_CARTAO = [
  "ultima_mensagem",
  "telefone",
  "email",
  "empresa",
  "cargo",
  "origem",
  "utm_source",
  "utm_medium",
  "utm_campaign",
] as const;

export type CampoDoCartao = (typeof CAMPOS_DO_CARTAO)[number];

export const MAXIMO_DE_LINHAS = 5;

/** A chave em `crm_pipelines.settings`. */
export const CHAVE_DAS_LINHAS = "card_lines";

/** O card de sempre: a última mensagem e o telefone, nessa ordem. */
export const LINHAS_PADRAO: readonly CampoDoCartao[] = Object.freeze(["ultima_mensagem", "telefone"]);

/**
 * O schema central. Duplicado é RECUSADO (não deduplicado em silêncio): duas
 * linhas com o mesmo campo seriam o mesmo dado escrito duas vezes no card, e
 * quem mandou isso mandou errado.
 */
export const linhasDoCartaoSchema = z
  .array(z.enum(CAMPOS_DO_CARTAO))
  .max(MAXIMO_DE_LINHAS)
  .refine((linhas) => new Set(linhas).size === linhas.length, {
    message: "Cada campo só pode aparecer em uma linha.",
  });

/** O corpo do PATCH: a lista, ou `null` para voltar ao padrão (apaga a chave). */
export const patchDasLinhasSchema = z
  .object({ card_lines: linhasDoCartaoSchema.nullable() })
  .strict();

export function ehCampoDoCartao(valor: unknown): valor is CampoDoCartao {
  return typeof valor === "string" && (CAMPOS_DO_CARTAO as readonly string[]).includes(valor);
}

/**
 * As linhas configuradas do funil. Chave ausente ou valor inválido → o padrão
 * (cópia, para ninguém mutar a constante).
 */
export function linhasDoCartao(settings: unknown): CampoDoCartao[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [...LINHAS_PADRAO];
  if (!(CHAVE_DAS_LINHAS in settings)) return [...LINHAS_PADRAO];
  const lido = linhasDoCartaoSchema.safeParse((settings as Record<string, unknown>)[CHAVE_DAS_LINHAS]);
  return lido.success ? [...lido.data] : [...LINHAS_PADRAO];
}

/** O `settings` com as linhas gravadas (merge) ou sem a chave (`null`). As outras chaves ficam. */
export function settingsComLinhas(
  settings: Record<string, unknown> | null | undefined,
  linhas: CampoDoCartao[] | null,
): Record<string, unknown> {
  const proximo: Record<string, unknown> = { ...(settings ?? {}) };
  if (linhas === null) delete proximo[CHAVE_DAS_LINHAS];
  else proximo[CHAVE_DAS_LINHAS] = [...linhas];
  return proximo;
}

/** O que o card precisa do lead para escrever as linhas. */
export type LeadDoCartao = Pick<
  Lead,
  "contact_phone" | "contact_email" | "contact_cargo" | "contact_empresa" | "conversa" | "source" | "custom_fields"
>;

function texto(valor: unknown): string | null {
  if (typeof valor === "number") return String(valor);
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  return limpo === "" ? null : limpo;
}

/**
 * O valor CRU de uma linha neste lead, ou `null` quando não há — e `null` faz
 * a linha sumir do card (sem "—"). O rótulo e a formatação são da tela.
 */
export function valorDaLinha(lead: Partial<LeadDoCartao>, campo: CampoDoCartao): string | null {
  switch (campo) {
    case "telefone":
      return texto(lead.contact_phone);
    case "email":
      return texto(lead.contact_email);
    case "ultima_mensagem":
      return texto(lead.conversa?.preview);
    case "origem":
      return texto(lead.source);
    case "empresa":
      return cargoEEmpresa({ empresa: lead.contact_empresa ?? null }, lead.custom_fields ?? null).empresa;
    case "cargo":
      return cargoEEmpresa({ cargo: lead.contact_cargo ?? null }, lead.custom_fields ?? null).cargo;
    case "utm_source":
    case "utm_medium":
    case "utm_campaign":
      return texto((lead.custom_fields as Record<string, unknown> | null | undefined)?.[campo]);
  }
}
