import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { regravarSettingsDoFunil } from "./regravar-settings";

type Linha = Record<string, unknown>;

/**
 * Banco em memória que aplica os `eq` (inclusive o de `updated_at`), move o `updated_at` a cada
 * escrita como o gatilho `fn_set_updated_at`, e deixa um "outro escritor" gravar entre a leitura e
 * a escrita — o cenário que apagava `card_lines`.
 */
function banco(linha: Linha, intrometido?: () => void) {
  let versao = 1;
  let leituras = 0;
  return {
    linha,
    leituras: () => leituras,
    client: {
      from: () => {
        const filtros: Array<[string, unknown]> = [];
        let mudanca: Linha | null = null;
        const casa = () => filtros.every(([c, v]) => linha[c] === v);
        const b = {
          select: () => b,
          update: (v: Linha) => {
            mudanca = v;
            return b;
          },
          eq: (c: string, v: unknown) => {
            filtros.push([c, v]);
            return b;
          },
          maybeSingle: async () => {
            leituras += 1;
            const lido = casa() ? structuredClone(linha) : null;
            if (leituras === 1) intrometido?.();
            return { data: lido, error: null };
          },
          then: (resolve: (r: { data: Linha[]; error: null }) => void) => {
            const ok = casa();
            if (ok && mudanca) {
              Object.assign(linha, mudanca, { updated_at: `v${++versao}` });
            }
            resolve({ data: ok ? [{ id: linha.id }] : [], error: null });
          },
        };
        return b;
      },
    },
  };
}

const alvo = { organizationId: "org", pipelineId: "p" };

describe("regravarSettingsDoFunil — trava otimista por updated_at", () => {
  it("⭐ outro escritor grava `card_lines` no meio: a nova tentativa preserva a chave dele", async () => {
    const db = banco({ id: "p", organization_id: "org", updated_at: "v1", settings: { lost_reasons: [] } });
    const comIntrometido = banco(db.linha, () => {
      db.linha.settings = { ...(db.linha.settings as Linha), card_lines: ["email"] };
      db.linha.updated_at = "v-outro";
    });
    const r = await regravarSettingsDoFunil(comIntrometido.client as never, alvo, (atual) => ({
      ...atual,
      cold_call: { ativo: true, roteiro: "oi" },
    }));
    expect(r).toBe("gravou");
    expect(comIntrometido.leituras()).toBe(2);
    expect(db.linha.settings).toEqual({
      lost_reasons: [],
      card_lines: ["email"],
      cold_call: { ativo: true, roteiro: "oi" },
    });
  });

  it("sem corrida: uma leitura, uma escrita, merge sobre o lido", async () => {
    const db = banco({ id: "p", organization_id: "org", updated_at: "v1", settings: { card_lines: [] } });
    expect(await regravarSettingsDoFunil(db.client as never, alvo, (a) => ({ ...a, x: 1 }))).toBe("gravou");
    expect(db.leituras()).toBe(1);
    expect(db.linha.settings).toEqual({ card_lines: [], x: 1 });
  });

  it("nada a mudar não grava; outra organização é não encontrado", async () => {
    const db = banco({ id: "p", organization_id: "org", updated_at: "v1", settings: { a: 1 } });
    expect(await regravarSettingsDoFunil(db.client as never, alvo, () => null)).toBe("nada_a_mudar");
    expect(db.linha.updated_at).toBe("v1");
    expect(
      await regravarSettingsDoFunil(db.client as never, { ...alvo, organizationId: "outra" }, (a) => a),
    ).toBe("nao_encontrado");
  });

  it("os dois escritores do Cold Call passam pela trava (não regravam `settings` direto)", () => {
    for (const arq of ["app/api/v1/cold-call/route.ts", "app/api/v1/cold-call/resultado/route.ts"]) {
      const fonte = readFileSync(arq, "utf8");
      expect(fonte, arq).toContain("regravarSettingsDoFunil(");
      expect(fonte, arq).not.toMatch(/\.update\(\{\s*settings/);
    }
  });
});
