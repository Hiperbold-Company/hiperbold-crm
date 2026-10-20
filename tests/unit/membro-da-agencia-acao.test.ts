import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A action do painel da plataforma que marca e remove o membro da agência (migration 0974): recusa antes de chamar
 * a RPC quem não é admin `full`, quem está com o segundo fator em dívida e entrada inválida; traduz os erros de
 * negócio em frase fixa e nunca devolve o texto cru do banco.
 */

const USUARIO = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  rpc: vi.fn(),
  revalidatePath: vi.fn(),
  mfaEmDivida: vi.fn(),
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: h.guard }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfaEmDivida }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: h.rpc }) }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));

beforeEach(() => {
  vi.clearAllMocks();
  h.guard.mockResolvedValue({ user: { id: USUARIO }, platformAdmin: { scope: "full" } });
  h.mfaEmDivida.mockResolvedValue(false);
  h.rpc.mockResolvedValue({ data: { acao: "criado" }, error: null });
});

async function acao() {
  return (await import("@/app/actions/admin/membrosDaAgencia")).definirMembroDaAgencia;
}

describe("definirMembroDaAgencia", () => {
  it("admin full com fator provado: chama a função do banco com o ator da sessão e o e-mail normalizado", async () => {
    const r = await (await acao())({ organizationId: ORG, email: "  Pessoa@Agencia.com.br ", ativo: true });
    expect(r).toEqual({ ok: true, acao: "criado" });
    expect(h.rpc).toHaveBeenCalledWith("fn_membro_da_agencia_definir", {
      p_org: ORG,
      p_user_email: "pessoa@agencia.com.br",
      p_ativo: true,
      p_actor: USUARIO,
    });
    expect(h.revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${ORG}`);
  });

  it("suporte somente leitura é recusado antes da RPC", async () => {
    h.guard.mockResolvedValue({ user: { id: USUARIO }, platformAdmin: { scope: "support_readonly" } });
    const r = await (await acao())({ organizationId: ORG, email: "a@b.com", ativo: true });
    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("segundo fator em dívida é recusado antes da RPC", async () => {
    h.mfaEmDivida.mockResolvedValue(true);
    const r = await (await acao())({ organizationId: ORG, email: "a@b.com", ativo: false });
    expect(r.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("entrada inválida (organização não uuid, e-mail ruim) não chega à RPC", async () => {
    const f = await acao();
    expect((await f({ organizationId: "x", email: "a@b.com", ativo: true })).ok).toBe(false);
    expect((await f({ organizationId: ORG, email: "sem-arroba", ativo: true })).ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("usuário inexistente vira frase fixa; erro desconhecido nunca vaza o texto do banco", async () => {
    const f = await acao();
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "usuario_nao_encontrado" } });
    const a = await f({ organizationId: ORG, email: "a@b.com", ativo: true });
    expect(a).toEqual({ ok: false, error: expect.stringContaining("Não existe usuário com esse e-mail") });

    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "relation public.segredo does not exist" } });
    const b = await f({ organizationId: ORG, email: "a@b.com", ativo: true });
    expect(b.ok).toBe(false);
    expect(JSON.stringify(b)).not.toContain("segredo");
  });

  it("remover o último admin vira a frase do dono ainda não ter aceitado", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "23514", message: "organizacao_sem_admin" } });
    const r = await (await acao())({ organizationId: ORG, email: "a@b.com", ativo: false });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("sem administrador") });
  });
});
