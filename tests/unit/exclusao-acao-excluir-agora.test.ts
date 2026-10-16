import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Excluir agora" do admin da plataforma: confere o nome exato, NÃO cria nem altera programação (se falhar, o
 * cron das 06:00 não herda nada) e executa pela exclusão `forcar`. Antes do conserto a ação programava a
 * organização para agora e, falhando o Storage, deixava a programação para o cron apagar no dia seguinte.
 */
const rpcs: { nome: string; args: unknown }[] = [];
const excluir = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false }));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: async () => ({ user: { id: "admin-1" }, platformAdmin: { scope: "full" } }),
}));
vi.mock("@/lib/http/ip-do-cliente", () => ({ ipDoCliente: () => null }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/retencao/exclusao-de-organizacao/rodada", () => ({ excluirOrganizacao: (...a: unknown[]) => excluir(...a) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { display_name: "Empresa Teste" }, error: null }) }) }),
    }),
    rpc: async (nome: string, args: unknown) => {
      rpcs.push({ nome, args });
      return { data: null, error: null };
    },
  }),
}));

import { excluirAgora } from "@/app/actions/admin/exclusoes";

const ORG = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  rpcs.length = 0;
  excluir.mockReset();
});

describe("excluirAgora", () => {
  it("nome diferente (inclusive caixa ou espaço): recusa e não executa", async () => {
    for (const nome of ["empresa teste", "Empresa Teste ", "Outra"]) {
      const r = await excluirAgora({ organizationId: ORG, nomeDigitado: nome, confirmar: true });
      expect(r.ok, nome).toBe(false);
    }
    expect(excluir).not.toHaveBeenCalled();
  });

  it("falha na exclusão: nenhuma programação foi criada ou alterada (o cron não herda nada)", async () => {
    excluir.mockResolvedValue({ ok: false, etapa: "armazenamento", motivo: "storage_remover:x" });
    const r = await excluirAgora({ organizationId: ORG, nomeDigitado: "Empresa Teste", confirmar: true });
    expect(r.ok).toBe(false);
    expect(rpcs.filter((x) => x.nome === "fn_exclusao_programar" || x.nome === "fn_exclusao_cancelar")).toEqual([]);
  });

  it("sucesso: executa forçada, sem tocar em programação", async () => {
    excluir.mockResolvedValue({ ok: true, resumo: {} });
    const r = await excluirAgora({ organizationId: ORG, nomeDigitado: "Empresa Teste", confirmar: true });
    expect(r).toEqual({ ok: true });
    expect(excluir).toHaveBeenCalledWith(expect.anything(), ORG, "admin-1", { forcar: true });
    expect(rpcs).toEqual([]);
  });
});
