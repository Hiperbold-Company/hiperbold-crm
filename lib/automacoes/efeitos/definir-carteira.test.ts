/**
 * Ação "Definir carteira" (`set_carteira`) e condição "Carteira do contato"
 * (`carteira`), pelo executor e pelo motor de produção.
 *
 * O banco é em memória e FILTRA de verdade (organização, contato), e a função
 * `fn_definir_carteira_do_cliente` é reproduzida na borda com a régua da real:
 * sem ator só com a origem `automacao`, contato da organização, dono membro
 * ativo `agent`/`manager`/`admin`. O que se mede é quando a função é chamada,
 * com o quê, e o desfecho do passo — não um mock do próprio código.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: auditMock, isServiceRoleConfigured: () => true }));

import { avaliarRegraNova } from "@/lib/automacoes/condicoes";
import type { PedidoDeEfeito } from "@/lib/followup/engine";
import { flowGraphSchema, type FlowEdge, type FlowNode } from "@/lib/followup/graph-schema";
import { processNode, type EnrollmentRow } from "@/lib/followup/node-handlers";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import type { FatosDaAutomacao } from "../fatos";
import { exportarAutomacao, type CatalogoDaConta } from "../portabilidade";
import { referenciasDoGrafo } from "../referencias";
import { crmActionConfigSchema, crmActionSchema } from "../schemas";
import { ACOES_DE_CRM, fraseDaAcao, fraseDaRegraNova, fraseDoErro, REGRAS_NOVAS } from "../vocabulario";
import { criarExecutorDeEfeitos } from "./index";

type Linha = Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OUTRA_ORG = "00000000-0000-4000-8000-0000000000b2";
const CONTATO = "20000000-0000-4000-8000-000000000001";
const ANA = "30000000-0000-4000-8000-000000000001";
const BRUNO = "30000000-0000-4000-8000-000000000002";
const VISUALIZADOR = "30000000-0000-4000-8000-000000000003";

function criarBanco(tabelas: Record<string, Linha[]>) {
  const rpcs: Array<{ nome: string; args: Linha }> = [];
  const admin = {
    from(tabela: string) {
      const filtros: Array<(l: Linha) => boolean> = [];
      const executar = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
      const b: Record<string, unknown> = {
        select: () => b,
        eq(c: string, v: unknown) {
          filtros.push((l) => l[c] === v);
          return b;
        },
        is(c: string, v: null) {
          filtros.push((l) => (l[c] ?? null) === v);
          return b;
        },
        maybeSingle: () => Promise.resolve({ data: executar()[0] ?? null, error: null }),
      };
      return b;
    },
    rpc(nome: string, args: Linha) {
      rpcs.push({ nome, args });
      if (nome !== "fn_definir_carteira_do_cliente") return Promise.resolve({ data: null, error: null });
      const erro = (message: string) => Promise.resolve({ data: null, error: { message } });
      if (args.p_actor === null && args.p_origem !== "automacao") return erro("carteira_sem_ator");
      const contato = (tabelas.contacts ?? []).find((c) => c.id === args.p_contact);
      if (!contato) return erro("carteira_contato_nao_encontrado");
      if (contato.organization_id !== args.p_org) return erro("carteira_contato_de_outra_organizacao");
      const membro = (tabelas.user_organizations ?? []).find(
        (m) => m.organization_id === args.p_org && m.user_id === args.p_dono && m.revoked_at == null,
      );
      if (!membro || !["agent", "manager", "admin"].includes(String(membro.role))) {
        return erro("carteira_dono_invalido");
      }
      contato.carteira_user_id = args.p_dono;
      return Promise.resolve({ data: args.p_dono, error: null });
    },
  };
  return { admin: admin as unknown as SupabaseClient, tabelas, rpcs };
}

function tabelasCom(carteira: string | null, contatoDaOrg = ORG): Record<string, Linha[]> {
  return {
    contacts: [{ id: CONTATO, organization_id: contatoDaOrg, carteira_user_id: carteira }],
    user_organizations: [
      { organization_id: ORG, user_id: ANA, role: "agent", revoked_at: null },
      { organization_id: ORG, user_id: BRUNO, role: "manager", revoked_at: null },
      { organization_id: ORG, user_id: VISUALIZADOR, role: "viewer", revoked_at: null },
    ],
  };
}

function pedido(
  userId: string,
  seJaTiver: "manter" | "substituir",
  onError: "route" | "continue" = "route",
  segunda = false,
): PedidoDeEfeito {
  // Fatos SEM a carteira: a ação não pode confiar neles para decidir "manter".
  const fatos = {
    contato: { id: CONTATO, name: "Maria", email: null, phone_number: null, birthdate: null, tags: [], custom_fields: {} },
    negocio: null,
    negocios: [],
    vars: {},
  } as unknown as FatosDaAutomacao;
  return {
    enrollment: { id: "e1", organization_id: ORG, contact_id: CONTATO, pointer_id: "p1", vars: {} } as EnrollmentRow,
    node: {
      id: "acao-1",
      type: "crm_action",
      label: "Carteira",
      position: { x: 0, y: 0 },
      config: {
        actions: [
          { type: "set_carteira", user_id: userId, se_ja_tiver: seJaTiver },
          // A segunda ação só existe para medir `on_error` (sem negócio, ela não toca no banco).
          ...(segunda ? [{ type: "win_deal" }] : []),
        ],
        on_error: onError,
      },
    } as FlowNode,
    fatos,
    chave: "acao-1:1",
  };
}

const executar = (admin: SupabaseClient, p: PedidoDeEfeito) =>
  criarExecutorDeEfeitos(admin, { podeProduzir: async () => true }).executar(p);

const chamadasDaCarteira = (rpcs: Array<{ nome: string; args: Linha }>) =>
  rpcs.filter((r) => r.nome === "fn_definir_carteira_do_cliente");

beforeEach(() => auditMock.mockReset());

describe("set_carteira: schema", () => {
  it("aceita vendedor uuid com manter ou substituir", () => {
    expect(crmActionSchema.safeParse({ type: "set_carteira", user_id: ANA, se_ja_tiver: "manter" }).success).toBe(true);
    expect(crmActionSchema.safeParse({ type: "set_carteira", user_id: ANA, se_ja_tiver: "substituir" }).success).toBe(true);
  });

  it("recusa se_ja_tiver fora do vocabulário, ausente, user_id que não é uuid e campo a mais", () => {
    expect(crmActionSchema.safeParse({ type: "set_carteira", user_id: ANA, se_ja_tiver: "trocar" }).success).toBe(false);
    expect(crmActionSchema.safeParse({ type: "set_carteira", user_id: ANA }).success).toBe(false);
    expect(crmActionSchema.safeParse({ type: "set_carteira", user_id: "ana", se_ja_tiver: "manter" }).success).toBe(false);
    expect(crmActionSchema.safeParse({ type: "set_carteira", user_id: "", se_ja_tiver: "manter" }).success).toBe(false);
    expect(
      crmActionSchema.safeParse({ type: "set_carteira", user_id: ANA, se_ja_tiver: "manter", extra: 1 }).success,
    ).toBe(false);
  });

  it("o bloco com o vendedor em branco (como o editor o cria) não grava", () => {
    const config = { actions: [{ type: "set_carteira", user_id: "", se_ja_tiver: "manter" }], on_error: "route" };
    expect(crmActionConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("set_carteira: efeito", () => {
  it("(a) contato sem carteira: chama a porta única sem ator, com a origem automacao, e audita", async () => {
    const banco = criarBanco(tabelasCom(null));
    const r = await executar(banco.admin, pedido(ANA, "manter"));

    expect(r.desfecho).toEqual({ ok: true });
    expect(chamadasDaCarteira(banco.rpcs)).toEqual([
      {
        nome: "fn_definir_carteira_do_cliente",
        args: { p_org: ORG, p_actor: null, p_contact: CONTATO, p_dono: ANA, p_origem: "automacao" },
      },
    ]);
    expect(banco.tabelas.contacts![0]!.carteira_user_id).toBe(ANA);
    expect(r.detalhes?.[0]).toMatchObject({ tipo: "set_carteira", ok: true, resultado: "definido", user_id: ANA });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        actorUserId: null,
        action: "contact.carteira_changed",
        resourceId: CONTATO,
        metadata: expect.objectContaining({ antes: null, depois: ANA, origem: "automacao" }),
      }),
    );
  });

  it("(b) já é de outro vendedor + manter: NÃO chama a função e o passo conclui como mantido", async () => {
    const banco = criarBanco(tabelasCom(BRUNO));
    const r = await executar(banco.admin, pedido(ANA, "manter"));

    expect(r.desfecho).toEqual({ ok: true });
    expect(chamadasDaCarteira(banco.rpcs)).toEqual([]);
    expect(banco.tabelas.contacts![0]!.carteira_user_id).toBe(BRUNO);
    expect(r.detalhes?.[0]).toMatchObject({ tipo: "set_carteira", ok: true, resultado: "mantido", dono_atual: BRUNO });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("(c) já é de outro vendedor + substituir: chama a função e troca o dono", async () => {
    const banco = criarBanco(tabelasCom(BRUNO));
    const r = await executar(banco.admin, pedido(ANA, "substituir"));

    expect(r.desfecho).toEqual({ ok: true });
    expect(chamadasDaCarteira(banco.rpcs)).toHaveLength(1);
    expect(chamadasDaCarteira(banco.rpcs)[0]!.args).toMatchObject({ p_actor: null, p_origem: "automacao", p_dono: ANA });
    expect(banco.tabelas.contacts![0]!.carteira_user_id).toBe(ANA);
    expect(r.detalhes?.[0]).toMatchObject({ resultado: "trocado" });
  });

  it("o mesmo vendedor já dono: nada a gravar, nos dois modos", async () => {
    for (const modo of ["manter", "substituir"] as const) {
      const banco = criarBanco(tabelasCom(ANA));
      const r = await executar(banco.admin, pedido(ANA, modo));
      expect(r.desfecho, modo).toEqual({ ok: true });
      expect(chamadasDaCarteira(banco.rpcs), modo).toEqual([]);
      expect(r.detalhes?.[0], modo).toMatchObject({ resultado: "sem_mudanca" });
    }
  });

  it("(d) a função recusa o vendedor (viewer): erro do passo, saída Erro com route, sem a mensagem crua", async () => {
    const banco = criarBanco(tabelasCom(null));
    const r = await executar(banco.admin, pedido(VISUALIZADOR, "manter", "route", true));

    expect(r.desfecho).toEqual({ ok: false, erro: "carteira_dono_invalido" });
    expect(fraseDoErro("carteira_dono_invalido")).toMatch(/vendedor escolhido/);
    // `route`: a ação seguinte não roda.
    expect(r.detalhes).toHaveLength(1);
    expect(r.detalhes?.[0]).toMatchObject({ tipo: "set_carteira", ok: false, erro: "carteira_dono_invalido" });
    expect(banco.tabelas.contacts![0]!.carteira_user_id).toBeNull();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("(d) com continue, a recusa não impede as próximas ações, e o bloco sai com o erro", async () => {
    const banco = criarBanco(tabelasCom(null));
    const r = await executar(banco.admin, pedido(VISUALIZADOR, "manter", "continue", true));
    expect(r.desfecho).toEqual({ ok: false, erro: "carteira_dono_invalido" });
    expect(r.detalhes).toHaveLength(2);
  });

  it("recusa desconhecida da função vira código genérico", async () => {
    const banco = criarBanco(tabelasCom(null));
    (banco.admin as unknown as { rpc: unknown }).rpc = () =>
      Promise.resolve({ data: null, error: { message: "erro interno com detalhe do banco" } });
    const r = await executar(banco.admin, pedido(ANA, "manter"));
    expect(r.desfecho).toEqual({ ok: false, erro: "carteira_nao_definida" });
    expect(JSON.stringify(r.detalhes)).not.toContain("detalhe do banco");
  });

  it("(e) sem contato (inexistente ou de outra organização): erro sem_contato, a função não é chamada", async () => {
    for (const tabelas of [{ ...tabelasCom(null), contacts: [] }, tabelasCom(null, OUTRA_ORG)]) {
      const banco = criarBanco(tabelas);
      const r = await executar(banco.admin, pedido(ANA, "substituir"));
      expect(r.desfecho).toEqual({ ok: false, erro: "sem_contato" });
      expect(chamadasDaCarteira(banco.rpcs)).toEqual([]);
    }
  });
});

describe("set_carteira: nome, frase e referências", () => {
  it("tem nome de ação e frase com o vendedor", () => {
    expect(ACOES_DE_CRM.set_carteira).toBe("Definir carteira");
    const frase = fraseDaAcao(
      { type: "set_carteira", user_id: ANA, se_ja_tiver: "manter" },
      { pessoa: (id) => (id === ANA ? "Ana" : null) },
    );
    expect(frase).toContain("Ana");
  });

  it("o vendedor é uma pessoa citada (o publish confere que é membro ativo)", () => {
    const g = flowGraphSchema.parse(grafoComAcao());
    expect(referenciasDoGrafo(g).pessoas).toEqual([ANA]);
  });

  it("exportar o grafo transforma o vendedor numa referência do tipo pessoa", () => {
    const g = flowGraphSchema.parse(grafoComAcao());
    const catalogo: CatalogoDaConta = [{ id: ANA, tipo: "pessoa", nome: "Ana", ativo: true }];
    const arquivo = exportarAutomacao({ id: "aaaaaaaa-0000-4000-8000-000000000001", nome: "x", grafo: g }, catalogo, new Date());
    expect(arquivo.referencias).toEqual([{ id: "pessoa_1", tipo: "pessoa", nome: "Ana" }]);
    expect(JSON.stringify(arquivo)).not.toContain(ANA);
    expect(JSON.stringify(arquivo.automacao.grafo)).toContain('"user_id":"ref:pessoa_1"');
  });
});

function grafoComAcao(): unknown {
  const pos = { x: 0, y: 0 };
  return {
    nodes: [
      {
        id: "n1",
        type: "trigger",
        label: "Início",
        position: pos,
        config: { triggers: [{ kind: "manual" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
      },
      {
        id: "n2",
        type: "crm_action",
        label: "Carteira",
        position: pos,
        config: { actions: [{ type: "set_carteira", user_id: ANA, se_ja_tiver: "manter" }], on_error: "continue" },
      },
      { id: "n3", type: "end", label: "Fim", position: pos, config: { outcome: "converted" } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2", priority: 0, condition: { type: "always" } },
      { id: "e2", source: "n2", target: "n3", priority: 0, condition: { type: "always" } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Condição "Carteira do contato"
// ---------------------------------------------------------------------------

const contato = (carteira?: string | null) => ({
  id: CONTATO,
  name: "Maria",
  email: null,
  phone_number: null,
  birthdate: null,
  tags: [],
  custom_fields: {},
  ...(carteira !== undefined ? { carteira_user_id: carteira } : {}),
});
const fatosCom = (c: ReturnType<typeof contato> | null): FatosDaAutomacao => ({
  contato: c,
  negocio: null,
  negocios: [],
  vars: {},
});
const TEM = { kind: "carteira", op: "tem" } as const;
const SEM = { kind: "carteira", op: "sem" } as const;

describe("condição carteira: a regra", () => {
  it("com carteira: tem = Sim, sem = Não", () => {
    expect(avaliarRegraNova(TEM, fatosCom(contato(ANA)))).toBe(true);
    expect(avaliarRegraNova(SEM, fatosCom(contato(ANA)))).toBe(false);
  });

  it("sem carteira (null): tem = Não, sem = Sim", () => {
    expect(avaliarRegraNova(TEM, fatosCom(contato(null)))).toBe(false);
    expect(avaliarRegraNova(SEM, fatosCom(contato(null)))).toBe(true);
  });

  it("o desconhecido nunca satisfaz: sem contato, carteira não lida, ou sem fatos, as duas respondem Não", () => {
    for (const fatos of [fatosCom(null), fatosCom(contato()), undefined]) {
      expect(avaliarRegraNova(TEM, fatos)).toBe(false);
      expect(avaliarRegraNova(SEM, fatos)).toBe(false);
    }
  });

  it("tem nome, frase e passa no schema sem campo a mais", () => {
    expect(REGRAS_NOVAS.carteira).toBe("Carteira do contato");
    expect(fraseDaRegraNova(TEM)).toBe("Contato tem carteira");
    expect(fraseDaRegraNova(SEM)).toBe("Contato sem carteira");
    expect(() => flowGraphSchema.parse(grafoDaCondicao([{ kind: "carteira", op: "talvez" }]))).toThrow();
    expect(() => flowGraphSchema.parse(grafoDaCondicao([{ kind: "carteira", op: "tem", extra: 1 }]))).toThrow();
  });

  it("publica na automação (combinado e uma saída por regra)", () => {
    const combinado = flowGraphSchema.parse(grafoDaCondicao([TEM]));
    expect(validateFlowForPublish(combinado, { surface: "automacao" })).toEqual({ ok: true });
    const porRegra = flowGraphSchema.parse(grafoDaCondicao([{ ...TEM, id: "r-tem" }], true));
    expect(validateFlowForPublish(porRegra, { surface: "automacao" })).toEqual({ ok: true });
  });
});

function grafoDaCondicao(checks: unknown[], porRegra = false): unknown {
  const pos = { x: 0, y: 0 };
  return {
    nodes: [
      {
        id: "n1",
        type: "trigger",
        label: "Início",
        position: pos,
        config: { triggers: [{ kind: "manual" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
      },
      {
        id: "c1",
        type: "condition",
        label: "Tem carteira?",
        position: pos,
        config: { combinator: "and", ...(porRegra ? { branching: "per_check" } : {}), checks },
      },
      { id: "f1", type: "end", label: "Fim Sim", position: pos, config: { outcome: "converted" } },
      { id: "f2", type: "end", label: "Fim Não", position: pos, config: { outcome: "converted" } },
    ],
    edges: [
      { id: "e0", source: "n1", target: "c1", priority: 0, condition: { type: "always" } },
      porRegra
        ? { id: "e1", source: "c1", target: "f1", priority: 0, condition: { type: "branch", branch_id: "r-tem" } }
        : { id: "e1", source: "c1", target: "f1", priority: 0, condition: { type: "cond_result", value: true } },
      porRegra
        ? { id: "e2", source: "c1", target: "f2", priority: 1, condition: { type: "always" } }
        : { id: "e2", source: "c1", target: "f2", priority: 1, condition: { type: "cond_result", value: false } },
    ],
  };
}

describe("condição carteira: o nó no motor", () => {
  const enrollment = { id: "e1", organization_id: ORG, lane: "automacao" } as EnrollmentRow;
  const lead = { lead_stage: null, tags: [], steps_taken: 0, last_outcome: null };
  const no = (config: unknown) =>
    ({ id: "c1", type: "condition", label: "Tem carteira?", position: { x: 0, y: 0 }, config }) as unknown as FlowNode;
  const aresta = (id: string, target: string, condition: FlowEdge["condition"], priority = 0): FlowEdge => ({
    id,
    source: "c1",
    target,
    priority,
    condition,
  });
  const decidir = (node: FlowNode, edges: FlowEdge[], fatos: FatosDaAutomacao) =>
    processNode({ node, edges, enrollment, lead, clock: () => new Date("2026-11-24T12:00:00Z"), fatos });

  it("combinado: tem carteira E tag vip segue por Sim; sem a carteira, por Não", () => {
    const node = no({
      combinator: "and",
      checks: [TEM, { kind: "tag", target: "contact", op: "has_any", tags: ["vip"] }],
    });
    const edges = [
      aresta("s", "sim", { type: "cond_result", value: true }),
      aresta("n", "nao", { type: "cond_result", value: false }, 1),
    ];
    const vip = (c: ReturnType<typeof contato>) => fatosCom({ ...c, tags: ["vip"] as never[] });
    expect(decidir(node, edges, vip(contato(ANA)))).toMatchObject({ kind: "advance", next_node_id: "sim" });
    expect(decidir(node, edges, vip(contato(null)))).toMatchObject({ kind: "advance", next_node_id: "nao" });
  });

  it("uma saída por regra: cada caso cai no ramo da sua regra", () => {
    const node = no({
      combinator: "and",
      branching: "per_check",
      checks: [
        { ...TEM, id: "r-tem" },
        { ...SEM, id: "r-sem" },
      ],
    });
    const edges = [
      aresta("a", "com-dono", { type: "branch", branch_id: "r-tem" }),
      aresta("b", "sem-dono", { type: "branch", branch_id: "r-sem" }, 1),
      aresta("c", "outros", { type: "always" }, 2),
    ];
    expect(decidir(node, edges, fatosCom(contato(ANA)))).toMatchObject({ next_node_id: "com-dono" });
    expect(decidir(node, edges, fatosCom(contato(null)))).toMatchObject({ next_node_id: "sem-dono" });
    expect(decidir(node, edges, fatosCom(null))).toMatchObject({ next_node_id: "outros" });
  });
});
