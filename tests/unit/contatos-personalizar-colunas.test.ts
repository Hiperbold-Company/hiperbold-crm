import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  COLUNAS_PADRAO,
  MAXIMO_DE_COLUNAS,
  colunaValida,
  ehPadrao,
  normalizarColunas,
} from "@/lib/contacts/colunas-da-lista";
import { resumoDoFunil } from "@/components/contacts/FiltrosAvancadosDeContatos";

/**
 * "Personalizar colunas" da tela de Contatos: a régua (pura) e a rota que grava a escolha
 * POR USUÁRIO. O isolamento da tabela (`user_preferences`) é provado no banco de verdade em
 * `tests/invariants/preferencias-por-usuario-rls.test.ts`; aqui se prova o que a ROTA decide:
 * de quem é a linha (sempre da sessão, nunca do corpo), o que ela aceita e o que ela audita.
 */

describe("régua das colunas", () => {
  it("sem escolha (ou escolha ilegível) = as 7 colunas de sempre", () => {
    expect(normalizarColunas(undefined)).toEqual([...COLUNAS_PADRAO]);
    expect(normalizarColunas("x")).toEqual([...COLUNAS_PADRAO]);
    expect(ehPadrao(normalizarColunas(null))).toBe(true);
  });

  it("Nome sempre primeiro, ações sempre por último, sem repetir nem id desconhecido", () => {
    expect(normalizarColunas(["acoes", "tags", "nome", "tags", "inexistente", "cf:utm_source"])).toEqual([
      "nome",
      "tags",
      "cf:utm_source",
      "acoes",
    ]);
    expect(normalizarColunas([])).toEqual(["nome", "acoes"]);
  });

  it(`no máximo ${MAXIMO_DE_COLUNAS} colunas, contando Nome e ações`, () => {
    const muitas = Array.from({ length: 20 }, (_, i) => `cf:campo${i}`);
    const r = normalizarColunas(muitas);
    expect(r).toHaveLength(MAXIMO_DE_COLUNAS);
    expect(r[0]).toBe("nome");
    expect(r.at(-1)).toBe("acoes");
  });

  it("campo de documento nunca vira coluna; chave que não é identificador também não", () => {
    for (const id of ["cf:cpf", "cf:rg", "cf:cnpj", "cf:a->b", "cf:", "cf:1x", "drop"]) {
      expect(colunaValida(id), id).toBe(false);
    }
    expect(colunaValida("cf:cargo")).toBe(true);
    expect(colunaValida("entrou_no_crm")).toBe(true);
  });
});

describe("rótulo do funil com várias etapas", () => {
  const funil = {
    name: "FUTURO 2027",
    etapas: [
      { id: "a", name: "Novo" },
      { id: "b", name: "Proposta" },
      { id: "c", name: "Fechamento" },
    ],
  };
  const t = (s: string) => s;
  it("nenhuma, uma e várias", () => {
    expect(resumoDoFunil(funil, [], t)).toBe("FUTURO 2027");
    expect(resumoDoFunil(funil, ["b"], t)).toBe("FUTURO 2027 › Proposta");
    expect(resumoDoFunil(funil, ["a", "b", "c"], t)).toBe("FUTURO 2027 › 3 etapas");
    // Etapa que saiu do funil não conta no rótulo.
    expect(resumoDoFunil(funil, ["a", "zz"], t)).toBe("FUTURO 2027 › Novo");
  });
});

const mocks = vi.hoisted(() => ({
  support: vi.fn(),
  role: vi.fn(),
  audit: vi.fn(),
  chamadas: [] as Array<[string, ...unknown[]]>,
  resposta: { data: null as unknown, error: null as unknown },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const builder: Record<string, unknown> = new Proxy(
      {},
      {
        get: (_a, metodo: string) => {
          if (metodo === "then") {
            return (ok: (v: unknown) => unknown) => Promise.resolve(mocks.resposta).then(ok);
          }
          return (...args: unknown[]) => {
            mocks.chamadas.push([metodo, ...args]);
            return metodo === "maybeSingle" ? Promise.resolve(mocks.resposta) : builder;
          };
        },
      },
    );
    return {
      from: (tabela: string) => {
        mocks.chamadas.push(["from", tabela]);
        return builder;
      },
    };
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const put = (corpo: unknown) =>
  new Request("http://localhost/api/v1/contacts/colunas", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  }) as never;

describe("rota /api/v1/contacts/colunas", () => {
  beforeEach(() => {
    mocks.chamadas.length = 0;
    mocks.resposta = { data: null, error: null };
    mocks.support.mockReset().mockResolvedValue(null);
    mocks.audit.mockReset();
    mocks.role.mockReset().mockResolvedValue({ ok: true, user: { id: USER }, org: { orgId: ORG } });
  });

  it("GET sem escolha gravada devolve o padrão, lendo só a linha DESTE usuário nesta organização", async () => {
    const { GET } = await import("@/app/api/v1/contacts/colunas/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ colunas: [...COLUNAS_PADRAO], padrao: true });
    expect(mocks.chamadas).toContainEqual(["from", "user_preferences"]);
    expect(mocks.chamadas).toContainEqual(["eq", "organization_id", ORG]);
    expect(mocks.chamadas).toContainEqual(["eq", "user_id", USER]);
    expect(mocks.chamadas).toContainEqual(["eq", "chave", "contatos.colunas"]);
  });

  it("GET com escolha gravada devolve a escolha normalizada (id que deixou de existir some)", async () => {
    mocks.resposta = { data: { valor: { colunas: ["nome", "cf:utm_source", "sumiu", "acoes"] } }, error: null };
    const { GET } = await import("@/app/api/v1/contacts/colunas/route");
    expect((await (await GET()).json()).data).toEqual({ colunas: ["nome", "cf:utm_source", "acoes"], padrao: false });
  });

  it("PUT grava na linha da SESSÃO (organização e usuário do corpo são recusados) e audita", async () => {
    const { PUT } = await import("@/app/api/v1/contacts/colunas/route");
    const intruso = await PUT(put({ colunas: ["nome", "acoes"], user_id: "outro" }));
    expect(intruso.status).toBe(422);

    const res = await PUT(put({ colunas: ["entrou_no_crm", "nome", "cf:utm_source"] }));
    expect(res.status).toBe(200);
    const upsert = mocks.chamadas.find((c) => c[0] === "upsert")!;
    expect(upsert[1]).toMatchObject({
      organization_id: ORG,
      user_id: USER,
      chave: "contatos.colunas",
      valor: { colunas: ["nome", "entrou_no_crm", "cf:utm_source", "acoes"] },
    });
    expect(upsert[2]).toEqual({ onConflict: "organization_id,user_id,chave" });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user_preferences.updated", organizationId: ORG, actorUserId: USER }),
    );
  });

  it("PUT recusa coluna desconhecida, campo de documento e mais de 12", async () => {
    const { PUT } = await import("@/app/api/v1/contacts/colunas/route");
    for (const colunas of [["nome", "drop"], ["cf:cpf"], Array.from({ length: 13 }, (_, i) => `cf:c${i}`)]) {
      expect((await PUT(put({ colunas }))).status, JSON.stringify(colunas)).toBe(422);
    }
    expect(mocks.chamadas.some((c) => c[0] === "upsert")).toBe(false);
  });

  it("suporte somente leitura não grava; DELETE (restaurar padrão) apaga só a própria linha", async () => {
    const { PUT, DELETE } = await import("@/app/api/v1/contacts/colunas/route");
    mocks.support.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await PUT(put({ colunas: ["nome"] }))).status).toBe(403);
    expect(mocks.chamadas).toHaveLength(0);

    const res = await DELETE();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ colunas: [...COLUNAS_PADRAO], padrao: true });
    expect(mocks.chamadas).toContainEqual(["delete"]);
    expect(mocks.chamadas).toContainEqual(["eq", "user_id", USER]);
  });
});
