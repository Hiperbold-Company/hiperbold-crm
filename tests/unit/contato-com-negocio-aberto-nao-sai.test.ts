/**
 * CONTATO COM NEGÓCIO EM ABERTO NÃO PODE SER EXCLUÍDO.
 *
 * Regra do dono do produto (19/11/2026): um negócio sem contato é um negócio sem
 * lead. Até aqui a exclusão apagava a ficha e o `ON DELETE SET NULL` de
 * `crm_leads.contact_id` deixava o negócio aberto no funil, órfão.
 *
 * A regra mora na lista de vínculos que barram a exclusão
 * (`lib/contacts/vinculos-restrict.ts`), a mesma que a lixeira de uma linha, a
 * pré-checagem do diálogo e a exclusão em lote consultam ANTES de apagar. Só o
 * negócio ABERTO (`status = 'open'`) barra: ganho e perdido seguem como antes
 * (ficam sem contato), porque são histórico encerrado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const auditSpy = vi.fn(async () => undefined);
vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));
vi.mock("@/lib/mcp/servidor-externo/do-agente/revogacao", () => ({
  revogarAcessosDoContato: async () => 0,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const CONTATO = "c05e7a00-0000-4000-8000-0000000000c1";
const OUTRO = "c05e7a00-0000-4000-8000-0000000000c2";
const USUARIO = "c05e7a00-0000-4000-8000-0000000000a1";

type Filtro = [string, string, unknown];
const consultas: Array<{ tabela: string; filtros: Filtro[] }> = [];
const rpcs: Array<{ nome: string; args: Record<string, unknown> | undefined }> = [];

/**
 * Banco falso: `negociosAbertos` são os contatos que têm negócio com status
 * `open`. A contagem e a busca em `crm_leads` só os enxergam quando a consulta
 * filtra `status = 'open'` — sem o filtro, o falso devolve também os encerrados
 * (`negociosEncerrados`), e o teste pega quem esqueceu o filtro.
 */
function bancoFalso(opts: { negociosAbertos?: string[]; negociosEncerrados?: string[] } = {}) {
  const abertos = opts.negociosAbertos ?? [];
  const encerrados = opts.negociosEncerrados ?? [];
  return {
    from(tabela: string) {
      const filtros: Filtro[] = [];
      const linhasDe = (): Array<{ contact_id: string }> => {
        if (tabela !== "crm_leads") return [];
        const soAbertos = filtros.some(([op, col, v]) => op === "eq" && col === "status" && v === "open");
        const universo = soAbertos ? abertos : [...abertos, ...encerrados];
        const porContato = filtros.find(([op, col]) => col === "contact_id" && (op === "eq" || op === "in"));
        const alvo = porContato ? (porContato[0] === "in" ? (porContato[2] as string[]) : [porContato[2] as string]) : universo;
        return universo.filter((c) => alvo.includes(c)).map((contact_id) => ({ contact_id }));
      };
      const cadeia = {
        _contagem: false,
        select(_c?: string, o?: { count?: string; head?: boolean }) {
          if (o?.count) cadeia._contagem = true;
          return cadeia;
        },
        eq(col: string, v: unknown) {
          filtros.push(["eq", col, v]);
          return cadeia;
        },
        in(col: string, v: unknown) {
          filtros.push(["in", col, v]);
          return cadeia;
        },
        async maybeSingle() {
          consultas.push({ tabela, filtros });
          return { data: tabela === "contacts" ? { id: CONTATO, organization_id: ORG } : null, error: null };
        },
        then(resolve: (v: unknown) => unknown) {
          consultas.push({ tabela, filtros });
          if (tabela === "contacts") {
            const ids = (filtros.find(([op, col]) => op === "in" && col === "id")?.[2] as string[]) ?? [];
            return resolve({
              data: ids.map((id) => ({ id, is_anonymized: false, is_merged_into: null })),
              error: null,
            });
          }
          const linhas = linhasDe();
          return resolve(cadeia._contagem ? { count: linhas.length, error: null } : { data: linhas, error: null });
        },
      };
      return cadeia;
    },
    rpc(nome: string, args?: Record<string, unknown>) {
      rpcs.push({ nome, args });
      if (nome === "fn_excluir_contatos_em_lote") return Promise.resolve({ data: args?.p_contact_ids ?? [], error: null });
      return Promise.resolve({ data: true, error: null });
    },
  };
}

function ctx(): HandlerCtx {
  return { organization_id: ORG, actor: { type: "user", id: USUARIO }, requestId: "req-1" };
}

beforeEach(() => {
  consultas.length = 0;
  rpcs.length = 0;
  auditSpy.mockClear();
});

describe("a lixeira de uma linha recusa contato com negócio em aberto", () => {
  it("devolve 409 com a contagem de negócios abertos e não apaga nada", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    const erro = await deleteContactHandler(
      bancoFalso({ negociosAbertos: [CONTATO] }) as never,
      ctx(),
      CONTATO,
    ).catch((e: unknown) => e);

    expect(erro).toMatchObject({ status: 409, code: "state_conflict" });
    expect((erro as { details?: { por_tabela?: Record<string, number> } }).details?.por_tabela?.crm_leads).toBe(1);
    expect(rpcs.map((r) => r.nome)).not.toContain("fn_apagar_contato_com_historico");
    expect(auditSpy.mock.calls.at(-1)?.[0]).toMatchObject({ action: "contact.delete_blocked" });
  });

  it("a contagem filtra o negócio pela organização, pelo contato e por status aberto", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await deleteContactHandler(bancoFalso() as never, ctx(), CONTATO);
    const contagem = consultas.find((c) => c.tabela === "crm_leads");
    expect(contagem?.filtros).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", ORG],
        ["eq", "contact_id", CONTATO],
        ["eq", "status", "open"],
      ]),
    );
  });

  it("negócio ganho ou perdido não barra: o contato sai como antes", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    const out = await deleteContactHandler(
      bancoFalso({ negociosEncerrados: [CONTATO] }) as never,
      ctx(),
      CONTATO,
    );
    expect(out).toEqual({ id: CONTATO });
    expect(rpcs.map((r) => r.nome)).toContain("fn_apagar_contato_com_historico");
  });

  it("a pré-checagem do diálogo enxerga o negócio aberto antes do clique", async () => {
    const { vinculosDoContatoHandler } = await import("@/app/api/v1/contacts/_handler");
    const r = await vinculosDoContatoHandler(bancoFalso({ negociosAbertos: [CONTATO] }) as never, ctx(), CONTATO);
    expect(r.por_tabela.crm_leads).toBe(1);
  });
});

describe("a exclusão em lote pula o contato com negócio em aberto", () => {
  it("volta como bloqueado e fica fora da função que apaga", async () => {
    const { excluirContatosEmLote } = await import("@/lib/contacts/excluir-em-lote");
    const r = await excluirContatosEmLote(
      bancoFalso({ negociosAbertos: [CONTATO], negociosEncerrados: [OUTRO] }) as never,
      [CONTATO, OUTRO],
      { organizationId: ORG, requestId: "req-1", metadataDoAtor: {} },
    );
    expect(r.bloqueados).toEqual([CONTATO]);
    const lote = rpcs.find((x) => x.nome === "fn_excluir_contatos_em_lote");
    expect(lote?.args?.p_contact_ids).toEqual([OUTRO]);
  });
});

describe("a tela explica o bloqueio", () => {
  const t = (s: string) => s;

  it("um negócio aberto: mensagem no singular", async () => {
    const { mensagemDeBloqueioPorVinculo } = await import("@/hooks/contacts/useDeleteContact");
    const m = mensagemDeBloqueioPorVinculo({ por_tabela: { crm_leads: 1 } }, t);
    expect(m).toMatch(/1 negócio em aberto/);
  });

  it("vários negócios abertos: mensagem no plural com o número", async () => {
    const { mensagemDeBloqueioPorVinculo } = await import("@/hooks/contacts/useDeleteContact");
    const m = mensagemDeBloqueioPorVinculo({ por_tabela: { crm_leads: 3 } }, t);
    expect(m).toMatch(/3 negócios em aberto/);
  });

  it("negócio e compromisso juntos: a mensagem fala dos dois", async () => {
    const { mensagemDeBloqueioPorVinculo } = await import("@/hooks/contacts/useDeleteContact");
    const m = mensagemDeBloqueioPorVinculo({ por_tabela: { crm_leads: 1, calendar_appointments: 1 } }, t) ?? "";
    expect(m).toMatch(/negócio em aberto/);
    expect(m).toMatch(/compromisso/);
  });

  it("só compromisso: a mensagem da agenda continua igual", async () => {
    const { mensagemDeBloqueioPorVinculo } = await import("@/hooks/contacts/useDeleteContact");
    expect(mensagemDeBloqueioPorVinculo({ por_tabela: { calendar_appointments: 1 } }, t)).toBe(
      "Este contato tem 1 compromisso na Agenda. Cancele ou apague o compromisso antes de excluir.",
    );
  });
});
