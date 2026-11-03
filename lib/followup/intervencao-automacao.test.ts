import { describe, expect, it } from "vitest";

import { adiaEnrollment, MENSAGEM_DE_AUTOMACAO, pausaEnrollment, pulaPassoDoEnrollment, retomaEnrollment, type DepsDaIntervencao } from "./intervencao";

/** Banco mínimo: a leitura devolve a linha dada e qualquer escrita é registrada. */
function deps(linha: Record<string, unknown>): { deps: DepsDaIntervencao; escritas: unknown[] } {
  const escritas: unknown[] = [];
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    or: () => cadeia,
    maybeSingle: async () => ({ data: linha, error: null }),
    update: (p: unknown) => (escritas.push(p), cadeia),
  };
  const supabase = { from: () => cadeia } as unknown as DepsDaIntervencao["supabase"];
  return {
    escritas,
    deps: { supabase, admin: supabase, orgId: "o1", userId: "u1", requestId: "r1" } as unknown as DepsDaIntervencao,
  };
}

const EXECUCAO = {
  id: "e1",
  status: "active",
  contact_id: "c1",
  pointer_id: "p1",
  version_id: "v1",
  current_node_id: "n1",
  next_eval_at: new Date(Date.now() + 60_000).toISOString(),
  claimed_until: null,
  steps_taken: 1,
};

describe("intervenções do relógio não valem para execução de automação (0986)", () => {
  it("pausar, retomar, adiar e pular recusam lane=automacao sem escrever nada", async () => {
    for (const acao of [
      (d: DepsDaIntervencao) => pausaEnrollment(d, "e1"),
      (d: DepsDaIntervencao) => retomaEnrollment(d, "e1"),
      (d: DepsDaIntervencao) => adiaEnrollment(d, "e1", new Date(Date.now() + 3_600_000).toISOString()),
      (d: DepsDaIntervencao) => pulaPassoDoEnrollment(d, "e1"),
    ]) {
      const { deps: d, escritas } = deps({ ...EXECUCAO, lane: "automacao" });
      const r = await acao(d);
      expect(r).toMatchObject({ ok: false, codigo: "estado_incompativel", mensagem: MENSAGEM_DE_AUTOMACAO });
      expect(escritas).toEqual([]);
    }
  });

  it("controle: o follow-up segue pausável", async () => {
    const { deps: d } = deps({ ...EXECUCAO, lane: "followup" });
    const r = await pausaEnrollment(d, "e1");
    expect(r).not.toMatchObject({ mensagem: MENSAGEM_DE_AUTOMACAO });
  });
});
