import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Excluir organização" pelo painel de tenants (`/admin/tenants`): a ação `excluirAgora` aceita o SLUG no lugar do
 * nome e, nesse caminho, só exclui tenant SUSPENSO. Programar/cancelar seguem as da tela de Exclusões. A leitura
 * `situacaoDaExclusaoDaOrganizacao` entrega a data que a regra existente sugere (suspensão + dias de guarda).
 */
type Org = { display_name: string; slug: string; status: string; suspended_at: string | null };
let org: Org | null;
let programacao: { origem: string; estado: string; excluir_em: string } | null;
let diasConfigurados = "";
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
vi.mock("@/lib/instalacao/config", () => ({
  valorDaInstalacao: async () => ({ valor: diasConfigurados, fonte: "env" }),
}));
vi.mock("@/lib/retencao/exclusao-de-organizacao/rodada", () => ({ excluirOrganizacao: (...a: unknown[]) => excluir(...a) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            tabela === "organizations" ? { data: org, error: null } : { data: programacao, error: null },
        }),
      }),
    }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import { excluirAgora, situacaoDaExclusaoDaOrganizacao } from "@/app/actions/admin/exclusoes";

const ORG = "11111111-2222-4333-8444-555555555555";
const DIA = 86_400_000;

beforeEach(() => {
  excluir.mockReset();
  excluir.mockResolvedValue({ ok: true, resumo: {} });
  programacao = null;
  diasConfigurados = "";
  org = { display_name: "Acme Ltda", slug: "acme-ltda", status: "suspended", suspended_at: new Date().toISOString() };
});

describe("excluirAgora pelo slug (painel de tenants)", () => {
  it("tenant ATIVO: recusa e não executa, mesmo com o slug certo", async () => {
    org = { ...org!, status: "active", suspended_at: null };
    const r = await excluirAgora({ organizationId: ORG, slugDigitado: "acme-ltda", confirmar: true });
    expect(r).toEqual({ ok: false, error: "Suspenda a organização antes de excluir." });
    expect(excluir).not.toHaveBeenCalled();
  });

  it("slug diferente (caixa, espaço, nome no lugar do slug): recusa e não executa", async () => {
    for (const slug of ["ACME-LTDA", "acme-ltda ", "Acme Ltda", "acme"]) {
      const r = await excluirAgora({ organizationId: ORG, slugDigitado: slug, confirmar: true });
      expect(r.ok, slug).toBe(false);
    }
    expect(excluir).not.toHaveBeenCalled();
  });

  it("suspenso + slug exato: executa a exclusão forçada", async () => {
    const r = await excluirAgora({ organizationId: ORG, slugDigitado: "acme-ltda", confirmar: true });
    expect(r).toEqual({ ok: true });
    expect(excluir).toHaveBeenCalledWith(expect.anything(), ORG, "admin-1", { forcar: true });
  });

  it("sem nome nem slug, ou com os dois: dados inválidos", async () => {
    expect((await excluirAgora({ organizationId: ORG, confirmar: true })).ok).toBe(false);
    expect(
      (await excluirAgora({ organizationId: ORG, nomeDigitado: "Acme Ltda", slugDigitado: "acme-ltda", confirmar: true })).ok,
    ).toBe(false);
    expect(excluir).not.toHaveBeenCalled();
  });
});

describe("situacaoDaExclusaoDaOrganizacao", () => {
  const dia = (d: Date) => d.toISOString().slice(0, 10);

  it("sugere suspensão + 90 dias (o padrão) quando a instalação não configurou nada", async () => {
    const suspensaEm = new Date(Date.now() - 10 * DIA);
    org = { ...org!, suspended_at: suspensaEm.toISOString() };
    const r = await situacaoDaExclusaoDaOrganizacao({ organizationId: ORG });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diasDeGuarda).toBe(90);
    // O dia civil é o de São Paulo: aceita a diferença de um dia contra o UTC.
    const esperado = new Date(suspensaEm.getTime() + 90 * DIA);
    expect([dia(new Date(esperado.getTime() - DIA)), dia(esperado)]).toContain(r.dataPadrao);
    expect(r.programada).toBeNull();
  });

  it("respeita os dias de guarda configurados na instalação", async () => {
    diasConfigurados = "120";
    const r = await situacaoDaExclusaoDaOrganizacao({ organizationId: ORG });
    expect(r.ok && r.diasDeGuarda).toBe(120);
  });

  it("suspensa há muito tempo: a data sugerida nunca é anterior a amanhã", async () => {
    org = { ...org!, suspended_at: new Date(Date.now() - 400 * DIA).toISOString() };
    const r = await situacaoDaExclusaoDaOrganizacao({ organizationId: ORG });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dataPadrao > dia(new Date(Date.now() - DIA))).toBe(true);
    expect(r.dataPadrao >= dia(new Date())).toBe(true);
  });

  it("devolve a exclusão programada; a cancelada não conta", async () => {
    programacao = { origem: "manual", estado: "programada", excluir_em: "2027-02-10T05:00:00.000Z" };
    let r = await situacaoDaExclusaoDaOrganizacao({ organizationId: ORG });
    expect(r.ok && r.programada).toEqual({ excluirEm: "2027-02-10T05:00:00.000Z", origem: "manual" });
    programacao = { origem: "automatica", estado: "cancelada", excluir_em: "2027-02-10T05:00:00.000Z" };
    r = await situacaoDaExclusaoDaOrganizacao({ organizationId: ORG });
    expect(r.ok && r.programada).toBeNull();
  });
});
