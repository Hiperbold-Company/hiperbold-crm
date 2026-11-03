/**
 * O histórico da execução mostra o NOME do campo ("Origem do contato"), não a
 * chave (`origem_do_contato`). O rótulo é gravado no evento no momento do
 * efeito (`rotuloDoCampo`); o evento antigo, só com a chave, segue legível.
 */
import { describe, expect, it } from "vitest";

import { descreveEvento } from "@/lib/followup/eventos-legiveis";

import { rotuloDoCampo } from "./index";

const defs = new Map([["origem_do_contato", { label: "Origem do contato" }]]);

describe("rotuloDoCampo", () => {
  it("campo personalizado do negócio usa o label do funil", () => {
    expect(rotuloDoCampo({ scope: "lead_custom", key: "origem_do_contato" }, defs)).toBe(
      "Origem do contato",
    );
  });
  it("campo personalizado sem definição (removido do funil) cai na chave", () => {
    expect(rotuloDoCampo({ scope: "lead_custom", key: "sumiu" }, defs)).toBe("sumiu");
  });
  it("campos padrão usam o nome da tela", () => {
    expect(rotuloDoCampo({ scope: "lead", key: "title" }, defs)).toBe("Título do negócio");
    expect(rotuloDoCampo({ scope: "contact", key: "email" }, defs)).toBe("E-mail do contato");
  });
  it("campo personalizado do contato (sem definição) mostra a chave", () => {
    expect(rotuloDoCampo({ scope: "contact_custom", key: "cpf" }, defs)).toBe("cpf");
  });
});

describe("evento legível do bloco de campos", () => {
  const ev = (payload: Record<string, unknown>) =>
    descreveEvento(
      {
        id: "x",
        node_id: null,
        event_type: "effect_done",
        payload,
        created_at: "2026-11-03T15:00:00Z",
      },
      {},
      "pt-BR",
      "automacao",
    );

  it("mostra o rótulo quando o evento o traz", () => {
    const d = ev({
      desfecho: { ok: true },
      detalhes: [
        {
          tipo: "field_op",
          campos: ["origem_do_contato"],
          rotulos: ["Origem do contato"],
          ok: true,
        },
      ],
    });
    expect(d.detalhe).toBe("Campos: Origem do contato");
  });

  it("evento antigo, só com a chave, continua legível", () => {
    const d = ev({
      desfecho: { ok: true },
      detalhes: [{ tipo: "field_op", campos: ["origem_do_contato"], ok: true }],
    });
    expect(d.detalhe).toBe("Campos: origem_do_contato");
  });
});
