/**
 * DUAS CONCLUSÕES CONCORRENTES NÃO DUPLICAM O EVENTO NEM A AUDITORIA.
 *
 * A tela de pagamento faz polling e o roteador `/onboarding` conclui a organização quando o contrato
 * vira ativo. Duas requisições simultâneas passam pela leitura inicial (`onboarded_at` ainda nulo),
 * mas só UMA muda a linha no UPDATE condicional (`is onboarded_at null`). Só ela emite
 * `tenant.onboarded` e audita. Código real de `concluirOnboarding`; dublê só no banco (formato do
 * PostgREST) e na auditoria.
 *
 * Comando: npx vitest run tests/unit/onboarding-conclusao-concorrente.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  onboardedAt: null as string | null,
  /** Simula a corrida: a leitura enxerga nulo, mas outro pedido conclui antes do UPDATE. */
  outroConcluiAntesDoUpdate: false,
  eventos: [] as Array<Record<string, unknown>>,
  auditorias: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (a: { action: string }) => {
    h.auditorias.push(a.action);
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const b: Record<string, unknown> = {};
      let atualizando = false;
      for (const m of ["select", "eq", "is"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: { onboarded_at: h.onboardedAt }, error: null });
      b.update = () => {
        atualizando = true;
        if (h.outroConcluiAntesDoUpdate) h.onboardedAt = "2026-10-15T10:00:00Z";
        return b;
      };
      b.insert = async (linha: Record<string, unknown>) => {
        h.eventos.push({ tabela, ...linha });
        return { error: null };
      };
      b.then = (resolve: (v: unknown) => unknown) => {
        if (!atualizando) return resolve({ data: null, error: null });
        const mudou = h.onboardedAt === null;
        if (mudou) h.onboardedAt = "2026-10-15T10:00:01Z";
        return resolve({ data: mudou ? [{ id: ORG }] : [], error: null });
      };
      return b;
    },
  }),
}));

import { concluirOnboarding } from "@/lib/onboarding/concluir";

beforeEach(() => {
  h.onboardedAt = null;
  h.outroConcluiAntesDoUpdate = false;
  h.eventos.length = 0;
  h.auditorias.length = 0;
});

describe("concluirOnboarding", () => {
  it("a primeira conclusão grava o evento e as duas auditorias", async () => {
    expect(await concluirOnboarding({ orgId: ORG, userId: USER })).toEqual({ ok: true, jaConcluida: false });
    expect(h.eventos).toHaveLength(1);
    expect(h.auditorias).toEqual(["onboarding.completed", "tenant.onboarded"]);
  });

  it("⭐ o UPDATE não alterou linha (outro pedido concluiu no meio): NÃO emite evento nem auditoria", async () => {
    h.outroConcluiAntesDoUpdate = true;
    expect(await concluirOnboarding({ orgId: ORG, userId: USER })).toEqual({ ok: true, jaConcluida: true });
    expect(h.eventos).toEqual([]);
    expect(h.auditorias).toEqual([]);
  });

  it("chamadas em sequência: só a primeira emite", async () => {
    await concluirOnboarding({ orgId: ORG, userId: USER });
    expect(await concluirOnboarding({ orgId: ORG, userId: USER })).toEqual({ ok: true, jaConcluida: true });
    expect(h.eventos).toHaveLength(1);
    expect(h.auditorias).toHaveLength(2);
  });
});
