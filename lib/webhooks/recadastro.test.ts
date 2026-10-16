/**
 * A decisão do recadastro: quem já tem lead ABERTO no funil da fonte não ganha outro.
 *
 * A função é pura, então aqui se prova a REGRA (e não a consulta): o que conta
 * como aberto, o que fica de fora e como o desempate é estável. A consulta e a
 * rota são provadas em `tests/unit/recadastro-pela-fonte-de-captacao.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { decidirRecadastro, type LeadDoContatoNoFunil } from "./recadastro";

function lead(parcial: Partial<LeadDoContatoNoFunil> & { id: string }): LeadDoContatoNoFunil {
  return {
    status: "open",
    last_activity_at: null,
    created_at: "2026-10-01T10:00:00.000Z",
    ...parcial,
  };
}

describe("decidirRecadastro", () => {
  it("lead aberto no funil: recadastra nele, não cria outro", () => {
    expect(decidirRecadastro([lead({ id: "a" })])).toEqual({ acao: "recadastrar", leadId: "a" });
  });

  it("só ganho e perdido no funil: é uma nova oportunidade, cria lead novo", () => {
    expect(
      decidirRecadastro([lead({ id: "g", status: "won" }), lead({ id: "p", status: "lost" })]),
    ).toEqual({ acao: "criar" });
  });

  it("nenhum lead no funil: cria lead novo", () => {
    expect(decidirRecadastro([])).toEqual({ acao: "criar" });
  });

  it("ganho ou perdido não atrapalha: o aberto ao lado deles recebe o recadastro", () => {
    expect(
      decidirRecadastro([
        lead({ id: "g", status: "won", last_activity_at: "2026-10-15T00:00:00.000Z" }),
        lead({ id: "aberto", last_activity_at: "2026-10-02T00:00:00.000Z" }),
      ]),
    ).toEqual({ acao: "recadastrar", leadId: "aberto" });
  });

  it("vários abertos: vai para o mais recentemente mexido", () => {
    expect(
      decidirRecadastro([
        lead({ id: "velho", last_activity_at: "2026-10-01T00:00:00.000Z" }),
        lead({ id: "novo", last_activity_at: "2026-10-10T00:00:00.000Z" }),
      ]),
    ).toEqual({ acao: "recadastrar", leadId: "novo" });
  });

  it("lead que nunca teve atividade perde para o que teve, qualquer que seja a data de criação", () => {
    expect(
      decidirRecadastro([
        lead({ id: "sem-atividade", created_at: "2026-10-12T00:00:00.000Z", last_activity_at: null }),
        lead({ id: "com-atividade", created_at: "2026-10-01T00:00:00.000Z", last_activity_at: "2026-10-03T00:00:00.000Z" }),
      ]),
    ).toEqual({ acao: "recadastrar", leadId: "com-atividade" });
  });

  it("empate de atividade: o criado por último; empate total: o menor id, e a ordem de entrada não muda o resultado", () => {
    const a = lead({ id: "b", created_at: "2026-10-05T00:00:00.000Z" });
    const b = lead({ id: "a", created_at: "2026-10-05T00:00:00.000Z" });
    const maisNovo = lead({ id: "z", created_at: "2026-10-06T00:00:00.000Z" });
    expect(decidirRecadastro([a, b])).toEqual({ acao: "recadastrar", leadId: "a" });
    expect(decidirRecadastro([b, a])).toEqual({ acao: "recadastrar", leadId: "a" });
    expect(decidirRecadastro([a, b, maisNovo])).toEqual({ acao: "recadastrar", leadId: "z" });
  });
});
