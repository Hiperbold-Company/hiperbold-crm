import { describe, expect, it } from "vitest";

import { ACTIVITY_LABELS } from "@/lib/leads/activity-vocabulary";
import {
  estaNoFuturo,
  eventoManualDaAtividade,
  eventoManualSchema,
  FOLGA_DE_RELOGIO_MS,
  foiRetroativo,
  PISO_DO_EVENTO,
  ORIGEM_DO_EVENTO_MANUAL,
  ROTULO_DO_SUBTIPO,
  SUBTIPOS_DE_EVENTO_MANUAL,
} from "@/lib/leads/evento-manual";
import { agrupaTimeline } from "@/lib/leads/timeline-grouping";
import type { TimelineItemView } from "@/lib/types/contacts";

describe("eventoManualSchema", () => {
  it("os seis tipos pedidos, cada um com rótulo em português", () => {
    expect(SUBTIPOS_DE_EVENTO_MANUAL).toEqual(["nota", "ligacao", "reuniao", "email", "whatsapp", "outro"]);
    expect(Object.values(ROTULO_DO_SUBTIPO)).toEqual([
      "Nota",
      "Ligação",
      "Reunião",
      "E-mail",
      "WhatsApp",
      "Outro",
    ]);
  });

  it("apara o texto e aceita data ISO com fuso", () => {
    const r = eventoManualSchema.safeParse({
      subtype: "reuniao",
      text: "  Alinhamos o escopo  ",
      occurred_at: "2026-10-01T10:00:00-03:00",
    });
    expect(r.success && r.data.text).toBe("Alinhamos o escopo");
  });

  it("texto: obrigatório, até 2000", () => {
    expect(eventoManualSchema.safeParse({ subtype: "nota", text: "" }).success).toBe(false);
    expect(eventoManualSchema.safeParse({ subtype: "nota", text: "  " }).success).toBe(false);
    expect(eventoManualSchema.safeParse({ subtype: "nota", text: "a".repeat(2000) }).success).toBe(true);
    expect(eventoManualSchema.safeParse({ subtype: "nota", text: "a".repeat(2001) }).success).toBe(false);
  });

  it("não aceita chaves fora do contrato (organização, contato, tipo da atividade)", () => {
    for (const extra of [{ organization_id: "x" }, { contact_id: "x" }, { type: "stage_changed" }]) {
      expect(eventoManualSchema.safeParse({ subtype: "nota", text: "x", ...extra }).success).toBe(false);
    }
  });
});

describe("estaNoFuturo", () => {
  const agora = Date.parse("2026-10-19T12:00:00.000Z");
  it("passado e agora valem; adiantado dentro da folga de relógio também", () => {
    expect(estaNoFuturo("2020-01-01T00:00:00.000Z", agora)).toBe(false);
    expect(estaNoFuturo("2026-10-19T12:00:00.000Z", agora)).toBe(false);
    expect(estaNoFuturo(new Date(agora + FOLGA_DE_RELOGIO_MS).toISOString(), agora)).toBe(false);
  });
  it("além da folga é futuro", () => {
    expect(estaNoFuturo(new Date(agora + FOLGA_DE_RELOGIO_MS + 1000).toISOString(), agora)).toBe(true);
    expect(estaNoFuturo("2027-01-01T00:00:00.000Z", agora)).toBe(true);
  });
});

describe("eventoManualDaAtividade", () => {
  it("reconhece só `note` com origem manual e devolve subtipo e texto", () => {
    expect(
      eventoManualDaAtividade({
        type: "note",
        source_module: ORIGEM_DO_EVENTO_MANUAL,
        payload: { subtype: "ligacao", text: "Ligou" },
      }),
    ).toEqual({ subtype: "ligacao", text: "Ligou" });
  });

  it("nota de outra origem, ou outro tipo, não é evento manual", () => {
    expect(eventoManualDaAtividade({ type: "note", source_module: "inbox", payload: { text: "x" } })).toBeNull();
    expect(
      eventoManualDaAtividade({ type: "stage_changed", source_module: "manual", payload: { text: "x" } }),
    ).toBeNull();
  });

  it("subtipo desconhecido no payload cai em 'outro' em vez de quebrar a linha", () => {
    expect(
      eventoManualDaAtividade({ type: "note", source_module: "manual", payload: { subtype: "fax", text: "x" } })
        ?.subtype,
    ).toBe("outro");
  });
});

describe("encaixe no vocabulário existente", () => {
  it("usa `note`, que já tem rótulo no vocabulário da timeline (nenhum tipo novo, nenhuma migration)", () => {
    expect(ACTIVITY_LABELS.note).toBe("Anotação");
  });

  it("evento manual NUNCA é colapsado num bloco: o texto é o conteúdo", () => {
    const mk = (id: string): TimelineItemView => ({
      id,
      organization_id: "o",
      lead_id: "l",
      contact_id: null,
      source_module: "manual",
      source_id: null,
      type: "note",
      payload: { subtype: "nota", text: id },
      metadata: {},
      performed_at: `2026-10-19T12:00:0${id}.000Z`,
      performed_by_user_id: "u",
      actor_kind: "user",
    });
    const blocos = agrupaTimeline([mk("1"), mk("2"), mk("3")]);
    expect(blocos.map((b) => b.tipo)).toEqual(["item", "item", "item"]);
  });
});

describe("piso e retroativo", () => {
  it("recusa data anterior ao piso de 2000-01-01 e aceita o próprio piso", () => {
    expect(eventoManualSchema.safeParse({ subtype: "nota", text: "x", occurred_at: "1999-12-31T23:59:59Z" }).success).toBe(false);
    expect(eventoManualSchema.safeParse({ subtype: "nota", text: "x", occurred_at: PISO_DO_EVENTO }).success).toBe(true);
  });

  it("retroativo = registrado MAIS de 1 hora depois do acontecimento", () => {
    expect(foiRetroativo("2026-10-19T10:00:00Z", "2026-10-19T10:30:00Z")).toBe(false);
    expect(foiRetroativo("2026-10-19T10:00:00Z", "2026-10-19T11:00:00Z")).toBe(false);
    expect(foiRetroativo("2026-10-19T10:00:00Z", "2026-10-19T11:00:01Z")).toBe(true);
    expect(foiRetroativo("2026-10-01T10:00:00Z", "2026-10-19T11:00:00Z")).toBe(true);
  });

  it("sem created_at (histórico antigo) não afirma nada", () => {
    expect(foiRetroativo("2026-10-01T10:00:00Z", undefined)).toBe(false);
  });
});
