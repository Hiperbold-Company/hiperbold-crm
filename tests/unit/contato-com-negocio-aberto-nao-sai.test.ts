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

const auditSpy = vi.fn(async (_evento: unknown) => undefined);
vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));
vi.mock("@/lib/mcp/servidor-externo/do-agente/revogacao", () => ({
  revogarAcessosDoContato: async () => 0,
}));
// O cliente de servidor: a contagem de `crm_leads` da lixeira passa por ele (a RLS do `agent`
// esconde o negócio de outro dono). Cada teste diz o que ele enxerga.
let bancoDoAdmin: unknown = null;
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => bancoDoAdmin }));

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
function bancoFalso(opts: { negociosAbertos?: string[]; negociosEncerrados?: string[]; maxRows?: number } = {}) {
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
        const linhas = universo.filter((c) => alvo.includes(c)).map((contact_id) => ({ contact_id }));
        // `max_rows` do PostgREST: a resposta sai cortada, sem erro.
        return opts.maxRows === undefined ? linhas : linhas.slice(0, opts.maxRows);
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
  bancoDoAdmin = bancoFalso();
  consultas.length = 0;
  rpcs.length = 0;
  auditSpy.mockClear();
});

describe("a lixeira de uma linha recusa contato com negócio em aberto", () => {
  it("devolve 409 com a contagem de negócios abertos e não apaga nada", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    bancoDoAdmin = bancoFalso({ negociosAbertos: [CONTATO] });
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
    bancoDoAdmin = bancoFalso({ negociosEncerrados: [CONTATO] });
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
    bancoDoAdmin = bancoFalso({ negociosAbertos: [CONTATO] });
    const r = await vinculosDoContatoHandler(bancoFalso({ negociosAbertos: [CONTATO] }) as never, ctx(), CONTATO);
    expect(r.por_tabela.crm_leads).toBe(1);
  });

  it("negócio de OUTRO dono, que a RLS do atendente esconde, ainda barra: 409", async () => {
    // O cliente do usuário (agent, visibilidade "own") não enxerga o negócio do colega;
    // o cliente de servidor, filtrado pela organização da sessão, enxerga.
    bancoDoAdmin = bancoFalso({ negociosAbertos: [CONTATO] });
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    const erro = await deleteContactHandler(bancoFalso() as never, ctx(), CONTATO).catch((e: unknown) => e);

    expect(erro).toMatchObject({ status: 409, code: "state_conflict" });
    expect((erro as { details?: { por_tabela?: Record<string, number> } }).details?.por_tabela?.crm_leads).toBe(1);
    expect(rpcs.map((r) => r.nome)).not.toContain("fn_apagar_contato_com_historico");
  });

  it("a pré-checagem do diálogo também enxerga o negócio escondido pela RLS", async () => {
    bancoDoAdmin = bancoFalso({ negociosAbertos: [CONTATO] });
    const { vinculosDoContatoHandler } = await import("@/app/api/v1/contacts/_handler");
    const r = await vinculosDoContatoHandler(bancoFalso() as never, ctx(), CONTATO);
    expect(r.por_tabela.crm_leads).toBe(1);
  });

  it("o gatilho do banco recusa por corrida (HB409): a rota responde 409, não 500", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    const banco = bancoFalso();
    const rpcOriginal = banco.rpc;
    banco.rpc = (nome: string, args?: Record<string, unknown>) => {
      if (nome !== "fn_apagar_contato_com_historico") return rpcOriginal(nome, args);
      rpcs.push({ nome, args });
      return Promise.resolve({ data: null, error: { code: "HB409", message: "contato_com_negocio_aberto" } }) as never;
    };
    await expect(deleteContactHandler(banco as never, ctx(), CONTATO)).rejects.toMatchObject({
      status: 409,
      code: "state_conflict",
    });
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

  it("resposta cortada pelo max_rows não esconde bloqueio", async () => {
    // Dois negócios abertos do primeiro contato enchem a resposta (max_rows = 2); o do segundo
    // só aparece numa consulta seguinte. Lido uma vez só, o segundo seria apagado.
    const { excluirContatosEmLote } = await import("@/lib/contacts/excluir-em-lote");
    const r = await excluirContatosEmLote(
      bancoFalso({ negociosAbertos: [CONTATO, CONTATO, OUTRO], maxRows: 2 }) as never,
      [CONTATO, OUTRO],
      { organizationId: ORG, requestId: "req-1", metadataDoAtor: {} },
    );
    expect([...r.bloqueados].sort()).toEqual([CONTATO, OUTRO].sort());
    expect(rpcs.some((x) => x.nome === "fn_excluir_contatos_em_lote")).toBe(false);
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
