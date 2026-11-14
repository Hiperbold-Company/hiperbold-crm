/**
 * Condição "Janela de 24h aberta?" (`window_open`): a regra pura, a leitura da
 * janela da conversa, o carregamento dos fatos (só quando alguém pergunta), a
 * decisão do nó no motor e o grafo (schema, frase e publicação).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { avaliarRegraNova } from "@/lib/automacoes/condicoes";
import { ehCanalDoDirect } from "@/lib/channels/canal-do-direct";
import { capabilitiesOf, PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";
import { ehCanalDeWhatsapp } from "@/lib/channels/canal-de-whatsapp";
import type { ChannelProvider } from "@/lib/channels/types";
import {
  flowGraphSchema,
  nodeBranches,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "@/lib/followup/graph-schema";
import { processNode, type EnrollmentRow } from "@/lib/followup/node-handlers";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";

import { carregarFatosDaAutomacao } from "./carregar-fatos";
import { janelaDaConversa, type ConversaDoContato } from "./conversa-de-whatsapp";
import type { FatosDaAutomacao } from "./fatos";
import { REGRAS_NOVAS, fraseDaRegraNova } from "./vocabulario";

const AGORA = new Date("2026-11-14T12:00:00Z");
const horasAtras = (h: number) => new Date(AGORA.getTime() - h * 3_600_000).toISOString();
const REGRA = { kind: "window_open" } as const;

const fatosBase = (over: Partial<FatosDaAutomacao> = {}): FatosDaAutomacao => ({
  contato: null,
  negocio: null,
  negocios: [],
  vars: {},
  ...over,
});

// Os providers saem da CAPACIDADE, nunca pelo nome (doutrina restricao-de-canal).
const WHATSAPP = PROVIDERS_DE_MENSAGEM.filter((p) => ehCanalDeWhatsapp(p));
const COM_JANELA = WHATSAPP.filter((p) => !capabilitiesOf(p as ChannelProvider).freeformOutsideWindow);
const SEM_JANELA = WHATSAPP.filter((p) => capabilitiesOf(p as ChannelProvider).freeformOutsideWindow);
const OFICIAL = COM_JANELA[0]!;

describe("avaliarRegraNova: window_open", () => {
  it("só com a janela 'aberta' responde Sim", () => {
    expect(avaliarRegraNova(REGRA, fatosBase({ janela: "aberta" }))).toBe(true);
    expect(avaliarRegraNova(REGRA, fatosBase({ janela: "fechada" }))).toBe(false);
    expect(avaliarRegraNova(REGRA, fatosBase({ janela: "sem_conversa" }))).toBe(false);
  });

  it("fatos sem a leitura da janela, ou sem fatos, respondem Não", () => {
    expect(avaliarRegraNova(REGRA, fatosBase())).toBe(false);
    expect(avaliarRegraNova(REGRA, undefined)).toBe(false);
  });
});

describe("janelaDaConversa", () => {
  const conversa = (provider: string | null, lastInboundAt: string | null): ConversaDoContato => ({
    id: "c1",
    provider,
    last_inbound_at: lastInboundAt,
  });

  it("contato sem conversa de WhatsApp: sem_conversa", () => {
    expect(janelaDaConversa(null, AGORA)).toBe("sem_conversa");
  });

  it("canal com janela: cliente escreveu há 1h = aberta; há 25h = fechada", () => {
    expect(janelaDaConversa(conversa(OFICIAL, horasAtras(1)), AGORA)).toBe("aberta");
    expect(janelaDaConversa(conversa(OFICIAL, horasAtras(25)), AGORA)).toBe("fechada");
  });

  it("canal oficial: logo antes e logo depois das 24h", () => {
    expect(janelaDaConversa(conversa(OFICIAL, horasAtras(23.9)), AGORA)).toBe("aberta");
    expect(janelaDaConversa(conversa(OFICIAL, horasAtras(24.1)), AGORA)).toBe("fechada");
  });

  it("canal oficial sem nenhuma mensagem do cliente: fechada (só modelo sai)", () => {
    expect(janelaDaConversa(conversa(OFICIAL, null), AGORA)).toBe("fechada");
  });

  it("todo canal de WhatsApp com janela (oficial e o parceiro que a intermedia) tem a mesma régua", () => {
    expect(COM_JANELA.length).toBeGreaterThanOrEqual(2);
    for (const provider of COM_JANELA) {
      expect(janelaDaConversa(conversa(provider, horasAtras(1)), AGORA), provider).toBe("aberta");
      expect(janelaDaConversa(conversa(provider, horasAtras(25)), AGORA), provider).toBe("fechada");
    }
  });

  it("canal sem restrição de janela é sempre aberta, mesmo com a última mensagem antiga ou ausente", () => {
    expect(SEM_JANELA.length).toBeGreaterThan(0);
    for (const provider of SEM_JANELA) {
      expect(janelaDaConversa(conversa(provider, horasAtras(1)), AGORA), provider).toBe("aberta");
      expect(janelaDaConversa(conversa(provider, horasAtras(500)), AGORA), provider).toBe("aberta");
      expect(janelaDaConversa(conversa(provider, null), AGORA), provider).toBe("aberta");
    }
  });

  it("provider ausente conta como sem restrição", () => {
    expect(janelaDaConversa(conversa(null, null), AGORA)).toBe("aberta");
  });
});

// ---------------------------------------------------------------------------
// carregarFatosDaAutomacao: só paga a consulta da conversa quem pergunta
// ---------------------------------------------------------------------------

type Linha = Record<string, unknown>;
const ORG = "00000000-0000-4000-8000-0000000000a1";
const OUTRA_ORG = "00000000-0000-4000-8000-0000000000b2";
const CONTATO = "20000000-0000-4000-8000-000000000001";

const CANAL_DO_DIRECT = PROVIDERS_DE_MENSAGEM.find((p) => ehCanalDoDirect(p))!;

function criarBanco(tabelas: Record<string, Linha[]>) {
  const consultadas: string[] = [];
  const admin = {
    from(tabela: string) {
      consultadas.push(tabela);
      const filtros: Array<(l: Linha) => boolean> = [];
      let limite = Infinity;
      const executar = () =>
        (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l))).slice(0, limite);
      const b: Record<string, unknown> = {
        select: () => b,
        eq(c: string, v: unknown) {
          filtros.push((l) => l[c] === v);
          return b;
        },
        in(c: string, vs: unknown[]) {
          filtros.push((l) => vs.includes(l[c]));
          return b;
        },
        is(c: string, v: null) {
          filtros.push((l) => (l[c] ?? null) === v);
          return b;
        },
        order: () => b,
        limit(n: number) {
          limite = n;
          return b;
        },
        maybeSingle: () => Promise.resolve({ data: executar()[0] ?? null, error: null }),
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          return Promise.resolve({ data: executar(), error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
  return { admin: admin as unknown as SupabaseClient, consultadas };
}

const conversaDoBanco = (over: Linha): Linha => ({
  id: "conv-1",
  organization_id: ORG,
  contact_id: CONTATO,
  is_group: false,
  last_inbound_at: horasAtras(1),
  channel_sessions: { provider: OFICIAL },
  ...over,
});

function tabelas(conversas: Linha[]): Record<string, Linha[]> {
  return {
    contacts: [{ id: CONTATO, organization_id: ORG, name: "Maria", phone_number: null, tags: [] }],
    crm_leads: [],
    conversations: conversas,
  };
}

describe("carregarFatosDaAutomacao: a janela", () => {
  it("sem pedir a janela, não consulta conversa nenhuma e o fato fica ausente", async () => {
    const { admin, consultadas } = criarBanco(tabelas([conversaDoBanco({})]));
    const fatos = await carregarFatosDaAutomacao(admin, ORG, CONTATO, {});
    expect(fatos.janela).toBeUndefined();
    expect(consultadas).not.toContain("conversations");
  });

  it("pedindo, lê aberta e fechada pela última mensagem do cliente", async () => {
    const aberta = criarBanco(tabelas([conversaDoBanco({ last_inbound_at: horasAtras(2) })]));
    expect(
      (
        await carregarFatosDaAutomacao(
          aberta.admin,
          ORG,
          CONTATO,
          {},
          { janela: true, agora: AGORA },
        )
      ).janela,
    ).toBe("aberta");
    const fechada = criarBanco(tabelas([conversaDoBanco({ last_inbound_at: horasAtras(30) })]));
    expect(
      (
        await carregarFatosDaAutomacao(
          fechada.admin,
          ORG,
          CONTATO,
          {},
          { janela: true, agora: AGORA },
        )
      ).janela,
    ).toBe("fechada");
  });

  it("contato sem conversa de WhatsApp: sem_conversa (grupo, conversa de outra organização e canal social não contam)", async () => {
    const { admin } = criarBanco(
      tabelas([
        conversaDoBanco({ id: "grupo", is_group: true }),
        conversaDoBanco({ id: "alheia", organization_id: OUTRA_ORG }),
        conversaDoBanco({ id: "direct", channel_sessions: { provider: "meta_social" } }),
      ]),
    );
    const fatos = await carregarFatosDaAutomacao(
      admin,
      ORG,
      CONTATO,
      {},
      { janela: true, agora: AGORA },
    );
    expect(fatos.janela).toBe("sem_conversa");
  });

  it("execução que nasceu de comentário pergunta pela conversa do Direct (a mesma do envio), não pela de WhatsApp", async () => {
    const SESSAO_IG = "sessao-ig";
    const IGSID = "6543210987654321";
    const vars = {
      gatilho: { tipo: "instagram_comment", comment_id: "c-1", channel_session_id: SESSAO_IG, autor_id: IGSID },
    };
    const direct = (over: Linha) =>
      conversaDoBanco({
        id: "conv-ig",
        channel_session_id: SESSAO_IG,
        provider_conversation_id: IGSID,
        channel_sessions: { provider: CANAL_DO_DIRECT },
        ...over,
      });
    // WhatsApp ABERTO e Direct FECHADO: a resposta tem de ser a do Direct.
    const fechado = criarBanco(
      tabelas([conversaDoBanco({ id: "conv-wa", last_inbound_at: horasAtras(1) }), direct({ last_inbound_at: horasAtras(30) })]),
    );
    expect((await carregarFatosDaAutomacao(fechado.admin, ORG, CONTATO, vars, { janela: true, agora: AGORA })).janela).toBe(
      "fechada",
    );
    const aberto = criarBanco(tabelas([direct({ last_inbound_at: horasAtras(2) })]));
    expect((await carregarFatosDaAutomacao(aberto.admin, ORG, CONTATO, vars, { janela: true, agora: AGORA })).janela).toBe(
      "aberta",
    );
    // Sem a conversa do Direct (a pessoa ainda não respondeu), o WhatsApp não a substitui.
    const semDirect = criarBanco(tabelas([conversaDoBanco({ id: "conv-wa", last_inbound_at: horasAtras(1) })]));
    expect(
      (await carregarFatosDaAutomacao(semDirect.admin, ORG, CONTATO, vars, { janela: true, agora: AGORA })).janela,
    ).toBe("sem_conversa");
  });

  it("a condição avalia pelo que foi carregado: Sim só com a janela aberta", async () => {
    for (const [horas, esperado] of [
      [2, true],
      [30, false],
    ] as const) {
      const { admin } = criarBanco(
        tabelas([conversaDoBanco({ last_inbound_at: horasAtras(horas) })]),
      );
      const fatos = await carregarFatosDaAutomacao(
        admin,
        ORG,
        CONTATO,
        {},
        { janela: true, agora: AGORA },
      );
      expect(avaliarRegraNova(REGRA, fatos), `${horas}h`).toBe(esperado);
    }
  });
});

// ---------------------------------------------------------------------------
// O nó de condição no motor, o grafo e a publicação
// ---------------------------------------------------------------------------

const pos = { x: 0, y: 0 };
const enrollment = { id: "e1", organization_id: "o1", lane: "automacao" } as EnrollmentRow;
const lead = { lead_stage: null, tags: [], steps_taken: 0, last_outcome: null };

const noCondicao = {
  id: "c1",
  type: "condition",
  label: "Janela aberta?",
  position: pos,
  config: { combinator: "and", checks: [REGRA] },
} as unknown as FlowNode;

const arestasDaCondicao: FlowEdge[] = [
  {
    id: "s",
    source: "c1",
    target: "texto",
    priority: 0,
    condition: { type: "cond_result", value: true },
  },
  {
    id: "n",
    source: "c1",
    target: "modelo",
    priority: 1,
    condition: { type: "cond_result", value: false },
  },
];

function decidir(fatos: FatosDaAutomacao | undefined) {
  return processNode({
    node: noCondicao,
    edges: arestasDaCondicao,
    enrollment,
    lead,
    clock: () => AGORA,
    fatos,
  });
}

describe("o nó de condição com a janela, no motor", () => {
  it("aberta segue por Sim; fechada, sem conversa e sem a leitura seguem por Não", () => {
    expect(decidir(fatosBase({ janela: "aberta" }))).toMatchObject({
      kind: "advance",
      next_node_id: "texto",
    });
    expect(decidir(fatosBase({ janela: "fechada" }))).toMatchObject({
      kind: "advance",
      next_node_id: "modelo",
    });
    expect(decidir(fatosBase({ janela: "sem_conversa" }))).toMatchObject({
      kind: "advance",
      next_node_id: "modelo",
    });
    expect(decidir(fatosBase())).toMatchObject({ kind: "advance", next_node_id: "modelo" });
    expect(decidir(undefined)).toMatchObject({ kind: "advance", next_node_id: "modelo" });
  });

  it("as saídas do nó são Sim e Não (mais o escape comum)", () => {
    const rotulos = nodeBranches(noCondicao as Extract<FlowNode, { type: "condition" }>).map(
      (r) => r.label,
    );
    expect(rotulos.slice(0, 2)).toEqual(["Sim", "Não"]);
  });
});

function grafo(checks: unknown[] = [REGRA]): FlowGraph {
  return flowGraphSchema.parse({
    nodes: [
      {
        id: "n1",
        type: "trigger",
        label: "Início",
        position: pos,
        config: {
          triggers: [{ kind: "manual" }],
          reentry: { policy: "skip_if_running", cooldown_minutes: 0 },
        },
      },
      {
        id: "c1",
        type: "condition",
        label: "Janela aberta?",
        position: pos,
        config: { combinator: "and", checks },
      },
      { id: "f1", type: "end", label: "Fim Sim", position: pos, config: { outcome: "converted" } },
      { id: "f2", type: "end", label: "Fim Não", position: pos, config: { outcome: "converted" } },
    ],
    edges: [
      { id: "e0", source: "n1", target: "c1", priority: 0, condition: { type: "always" } },
      {
        id: "e1",
        source: "c1",
        target: "f1",
        priority: 0,
        condition: { type: "cond_result", value: true },
      },
      {
        id: "e2",
        source: "c1",
        target: "f2",
        priority: 1,
        condition: { type: "cond_result", value: false },
      },
    ],
  });
}

describe("o grafo com a regra window_open", () => {
  it("passa no flowGraphSchema e a regra volta sem campo extra", () => {
    const g = grafo();
    const c = g.nodes.find((n) => n.type === "condition");
    expect(c?.type === "condition" && c.config.checks).toEqual([{ kind: "window_open" }]);
  });

  it("a regra não aceita campo a mais", () => {
    expect(() => grafo([{ kind: "window_open", extra: 1 }])).toThrow();
  });

  it("publica na automação e é recusada no follow-up (regra nova é só da automação)", () => {
    expect(validateFlowForPublish(grafo(), { surface: "automacao" })).toEqual({ ok: true });
    const r = validateFlowForPublish(grafo(), { surface: "followup" });
    expect(r.ok).toBe(false);
  });

  it("a regra tem nome e frase para a pessoa", () => {
    expect(REGRAS_NOVAS.window_open).toBe("Janela de 24h aberta?");
    expect(fraseDaRegraNova(REGRA, {})).toContain("24h");
  });
});
