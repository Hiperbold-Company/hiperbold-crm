import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  avisoDeConexaoAlheia,
  conexaoPermitidaNoModoRestrito,
  decidirAbertura,
  envioPermitidoPelaConexao,
  type ConversaDoContatoNaConexao,
  type OpcoesDeAbertura,
} from "@/lib/inbox/conexao-ao-abrir";
import { carregarOpcoesDeAbertura, envioRecusadoPelaConexao } from "@/lib/inbox/opcoes-de-abertura";
import { guardarConexaoAoAbrir } from "@/lib/inbox/guarda-da-conexao-ao-abrir";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import {
  CHANNEL_PROVIDER_META_SOCIAL,
  DEFAULT_CHANNEL_PROVIDER,
  CHANNEL_PROVIDER_WACALLS,
} from "@/lib/channels/capabilities";

/**
 * "Abrir conversa" e "enviar" pela conexão de quem atende (cliente real,
 * 16/11/2026): a vendedora abriu pelo card do funil a conversa que estava na
 * conexão da colega e respondeu pelo número dela.
 *
 * Três camadas medidas aqui, de baixo para cima:
 *  1. as regras puras (`decidirAbertura`, `envioPermitidoPelaConexao`);
 *  2. a leitura do banco e a guarda do POST, sobre um banco EM MEMÓRIA que
 *     aplica os filtros de verdade — é ele que prova que nada de outra
 *     organização entra, e que a visibilidade recorta a lista;
 *  3. `openSharedContactConversation` recusando sessão de outra organização.
 */

// ─── banco em memória: aplica eq / in / is de verdade ───────────────────────

type Linha = Record<string, unknown>;

function bancoEmMemoria(tabelas: Record<string, Linha[]>): SupabaseClient {
  function consulta(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    const linhas = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    const b = {
      select: () => b,
      order: () => b,
      limit: () => b,
      eq: (c: string, v: unknown) => {
        filtros.push((l) => l[c] === v);
        return b;
      },
      in: (c: string, vs: unknown[]) => {
        filtros.push((l) => vs.includes(l[c]));
        return b;
      },
      is: (c: string, v: unknown) => {
        filtros.push((l) => (l[c] ?? null) === v);
        return b;
      },
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) => ok({ data: linhas(), error: null }),
    };
    return b;
  }
  return { from: consulta } as unknown as SupabaseClient;
}

const ORG = "00000000-0000-4000-8000-00000000000a";
const OUTRA_ORG = "00000000-0000-4000-8000-00000000000b";
const ROSANA = "00000000-0000-4000-8000-000000000001";
const INGRID = "00000000-0000-4000-8000-000000000002";
const GERENTE = "00000000-0000-4000-8000-000000000003";
const SEM_NUMERO = "00000000-0000-4000-8000-000000000004";
const LUCAS = "00000000-0000-4000-8000-000000000101";
const SESS_ROSANA = "00000000-0000-4000-8000-000000000201";
const SESS_INGRID = "00000000-0000-4000-8000-000000000202";
const SESS_GERAL = "00000000-0000-4000-8000-000000000203";
const SESS_OUTRA_ORG = "00000000-0000-4000-8000-000000000204";
const SESS_ARQUIVADA = "00000000-0000-4000-8000-000000000205";
const SESS_INSTAGRAM = "00000000-0000-4000-8000-000000000206";
const CONV_INGRID = "00000000-0000-4000-8000-000000000301";
const CONV_GERAL = "00000000-0000-4000-8000-000000000302";
const CONV_ARQUIVADA = "00000000-0000-4000-8000-000000000303";
const CONV_INSTAGRAM = "00000000-0000-4000-8000-000000000304";
const LEAD = "00000000-0000-4000-8000-000000000401";

function sessao(id: string, org: string, nome: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: org,
    display_name: nome,
    phone_number: "5511999990000",
    provider: DEFAULT_CHANNEL_PROVIDER,
    status: "WORKING",
    metadata: {},
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

interface Cenario {
  modo?: "choose" | "own_only";
  /** A conversa na conexão da Ingrid: dona e estado. */
  donaDaConversa?: string;
  statusDaConversa?: string;
  /** Sem número geral na organização. */
  semGeral?: boolean;
  /** A conversa do contato no número geral existe. */
  conversaNoGeral?: boolean;
  /** Quem fez a última troca de dono do negócio (que é da Rosana). */
  trocaDoNegocioPor?: string | null;
  /** A conexão da Rosana fora do ar. */
  rosanaDesconectada?: boolean;
}

function tabelas(c: Cenario = {}): Record<string, Linha[]> {
  return {
    organizations: [{ id: ORG, settings: { routing: { conversation_connection_mode: c.modo ?? "choose" } } }],
    channel_sessions: [
      sessao(SESS_ROSANA, ORG, "Rosana Comercial", c.rosanaDesconectada ? { status: "STOPPED" } : {}),
      sessao(SESS_INGRID, ORG, "Ingrid Müller"),
      ...(c.semGeral ? [] : [sessao(SESS_GERAL, ORG, "Número geral")]),
      sessao(SESS_ARQUIVADA, ORG, "Arquivada", { archived_at: "2026-06-01T00:00:00Z" }),
      sessao(SESS_INSTAGRAM, ORG, "Instagram da loja", { provider: CHANNEL_PROVIDER_META_SOCIAL }),
      // A outra organização tem uma conexão em que a Rosana aparece como
      // responsável (linha forjada): nunca pode virar "minha conexão".
      sessao(SESS_OUTRA_ORG, OUTRA_ORG, "Conexão de outra empresa"),
    ],
    channel_routing_policies: [
      { id: "p-rosana", organization_id: ORG, channel_session_id: SESS_ROSANA },
      { id: "p-ingrid", organization_id: ORG, channel_session_id: SESS_INGRID },
      { id: "p-outra", organization_id: OUTRA_ORG, channel_session_id: SESS_OUTRA_ORG },
    ],
    channel_routing_responsibles: [
      { organization_id: ORG, policy_id: "p-rosana", user_id: ROSANA },
      { organization_id: ORG, policy_id: "p-ingrid", user_id: INGRID },
      { organization_id: OUTRA_ORG, policy_id: "p-outra", user_id: ROSANA },
    ],
    conversations: [
      {
        id: CONV_INGRID,
        organization_id: ORG,
        contact_id: LUCAS,
        channel_session_id: SESS_INGRID,
        is_group: false,
        status: c.statusDaConversa ?? "open",
        assigned_to_user_id: c.donaDaConversa ?? INGRID,
      },
      ...(c.conversaNoGeral
        ? [
            {
              id: CONV_GERAL,
              organization_id: ORG,
              contact_id: LUCAS,
              channel_session_id: SESS_GERAL,
              is_group: false,
              status: "open",
              assigned_to_user_id: null,
            },
          ]
        : []),
      {
        id: CONV_ARQUIVADA,
        organization_id: ORG,
        contact_id: LUCAS,
        channel_session_id: SESS_ARQUIVADA,
        is_group: false,
        status: "open",
        assigned_to_user_id: null,
      },
      {
        id: CONV_INSTAGRAM,
        organization_id: ORG,
        contact_id: LUCAS,
        channel_session_id: SESS_INSTAGRAM,
        is_group: false,
        status: "open",
        assigned_to_user_id: null,
      },
    ],
    crm_leads: [{ id: LEAD, organization_id: ORG, contact_id: LUCAS, owner_user_id: ROSANA }],
    crm_lead_activities:
      c.trocaDoNegocioPor === undefined
        ? []
        : [
            {
              organization_id: ORG,
              lead_id: LEAD,
              type: "lead_edited",
              payload: { fields: ["owner_user_id"] },
              performed_by_user_id: c.trocaDoNegocioPor,
              performed_at: "2026-11-10T00:00:00Z",
            },
          ],
    contacts: [{ id: LUCAS, organization_id: ORG, is_personal: false }],
  };
}

const cenario = (c: Cenario = {}) => bancoEmMemoria(tabelas(c));

// ─── 1. as regras puras ─────────────────────────────────────────────────────

const MINHA = { id: "minha", nome: "Rosana Comercial", conectada: true };
const GERAL = { id: "geral", nome: "Número geral", conectada: true };

function opcoes(p: Partial<OpcoesDeAbertura> = {}): OpcoesDeAbertura {
  return {
    modo: "choose",
    restrito: false,
    minha_conexao: MINHA,
    minhas_conexoes_ids: ["minha"],
    conexao_geral: GERAL,
    conexoes_com_responsavel_ids: ["minha", "da-ingrid"],
    conversas: [],
    contato_em_conexao_de_outro: false,
    transferido_para_mim: false,
    ...p,
  };
}

const naDaIngrid: ConversaDoContatoNaConexao = {
  conversation_id: "conv-ingrid",
  channel_session_id: "da-ingrid",
  conexao_nome: "Ingrid Müller",
  conexao_de_outro: true,
  aberta_e_minha: false,
};
const naMinha: ConversaDoContatoNaConexao = {
  ...naDaIngrid,
  conversation_id: "conv-minha",
  channel_session_id: "minha",
  conexao_nome: "Rosana Comercial",
  conexao_de_outro: false,
};
const noGeral: ConversaDoContatoNaConexao = {
  ...naDaIngrid,
  conversation_id: "conv-geral",
  channel_session_id: "geral",
  conexao_nome: "Número geral",
  conexao_de_outro: false,
};

describe("decidirAbertura — modo 'deixar escolher'", () => {
  it("contato já tem conversa na MINHA conexão → abre essa, sem perguntar", () => {
    expect(decidirAbertura(opcoes({ conversas: [naDaIngrid, naMinha] }))).toEqual({
      tipo: "abrir",
      conversationId: "conv-minha",
    });
  });

  it("contato só tem conversa em OUTRA conexão → janela, com a minha como padrão", () => {
    expect(decidirAbertura(opcoes({ conversas: [naDaIngrid] }))).toEqual({
      tipo: "escolher",
      padrao: MINHA,
      existentes: [naDaIngrid],
    });
  });

  it("contato com VÁRIAS conversas em outras conexões → uma linha por conexão na janela", () => {
    const d = decidirAbertura(opcoes({ conversas: [naDaIngrid, noGeral] }));
    expect(d.tipo).toBe("escolher");
    expect(d.tipo === "escolher" && d.existentes.map((c) => c.conexao_nome)).toEqual([
      "Ingrid Müller",
      "Número geral",
    ]);
  });

  it("sem conexão vinculada → comportamento de hoje", () => {
    expect(
      decidirAbertura(opcoes({ minha_conexao: null, minhas_conexoes_ids: [], conversas: [naDaIngrid] })),
    ).toEqual({ tipo: "como_hoje" });
  });

  it("nenhuma conversa que eu enxergue → inicia pela minha (a do colega não vira opção)", () => {
    expect(decidirAbertura(opcoes({ contato_em_conexao_de_outro: true }))).toEqual({
      tipo: "iniciar",
      conexao: MINHA,
    });
  });
});

describe("decidirAbertura — modo 'só a conexão própria' (atendente)", () => {
  const restrito = { modo: "own_only" as const, restrito: true };

  it("conversa já na minha → abre", () => {
    expect(decidirAbertura(opcoes({ ...restrito, conversas: [naMinha, naDaIngrid] }))).toEqual({
      tipo: "abrir",
      conversationId: "conv-minha",
    });
  });

  it("contato na conexão de OUTRO atendente → recusa, sem nome de conexão", () => {
    expect(
      decidirAbertura(opcoes({ ...restrito, conversas: [naDaIngrid], contato_em_conexao_de_outro: true })),
    ).toEqual({ tipo: "recusar", motivo: "contato_de_outro" });
  });

  it("transferido para mim → inicia pela MINHA conexão, sem janela", () => {
    expect(
      decidirAbertura(
        opcoes({ ...restrito, conversas: [naDaIngrid], contato_em_conexao_de_outro: true, transferido_para_mim: true }),
      ),
    ).toEqual({ tipo: "iniciar", conexao: MINHA });
  });

  it("contato só no número geral → inicia pela minha (não continua no geral)", () => {
    expect(decidirAbertura(opcoes({ ...restrito, conversas: [noGeral] }))).toEqual({
      tipo: "iniciar",
      conexao: MINHA,
    });
  });

  describe("sem conexão vinculada", () => {
    const semMinha = { ...restrito, minha_conexao: null, minhas_conexoes_ids: [] };

    it("conversa no número geral → abre essa", () => {
      expect(decidirAbertura(opcoes({ ...semMinha, conversas: [naDaIngrid, noGeral] }))).toEqual({
        tipo: "abrir",
        conversationId: "conv-geral",
      });
    });

    it("sem conversa → inicia pelo número geral", () => {
      expect(decidirAbertura(opcoes(semMinha))).toEqual({ tipo: "iniciar", conexao: GERAL });
    });

    it("contato na conexão de colega → recusa", () => {
      expect(
        decidirAbertura(opcoes({ ...semMinha, conversas: [naDaIngrid], contato_em_conexao_de_outro: true })),
      ).toEqual({ tipo: "recusar", motivo: "contato_de_outro" });
    });

    it("sem número geral → recusa (sem_conexao)", () => {
      expect(decidirAbertura(opcoes({ ...semMinha, conexao_geral: null }))).toEqual({
        tipo: "recusar",
        motivo: "sem_conexao",
      });
    });

    it("sem número geral mas com conversa ABERTA atribuída a mim → abre ela", () => {
      const transferida = { ...naDaIngrid, aberta_e_minha: true };
      expect(
        decidirAbertura(
          opcoes({
            ...semMinha,
            conexao_geral: null,
            conversas: [transferida],
            contato_em_conexao_de_outro: true,
            transferido_para_mim: true,
          }),
        ),
      ).toEqual({ tipo: "abrir", conversationId: "conv-ingrid" });
    });
  });
});

describe("conexaoPermitidaNoModoRestrito", () => {
  const r = opcoes({ modo: "own_only", restrito: true });
  it("com conexão própria: só a própria", () => {
    expect(conexaoPermitidaNoModoRestrito(r, "minha")).toBe(true);
    expect(conexaoPermitidaNoModoRestrito(r, "da-ingrid")).toBe(false);
    expect(conexaoPermitidaNoModoRestrito(r, "geral")).toBe(false);
  });
  it("sem conexão própria: só o número geral", () => {
    const s = { ...r, minha_conexao: null, minhas_conexoes_ids: [] };
    expect(conexaoPermitidaNoModoRestrito(s, "geral")).toBe(true);
    expect(conexaoPermitidaNoModoRestrito(s, "da-ingrid")).toBe(false);
  });
  it("fora do modo restrito, qualquer uma", () => {
    expect(conexaoPermitidaNoModoRestrito(opcoes(), "da-ingrid")).toBe(true);
  });
});

describe("envioPermitidoPelaConexao", () => {
  const base = { restrito: true, sessaoEhMinha: false, sessaoTemResponsaveis: true, conversaAbertaEMinha: false };
  it("restrito, conexão do colega → recusa", () => {
    expect(envioPermitidoPelaConexao(base)).toBe(false);
  });
  it("restrito: a minha, o número geral ou a conversa aberta atribuída a mim → permite", () => {
    expect(envioPermitidoPelaConexao({ ...base, sessaoEhMinha: true })).toBe(true);
    expect(envioPermitidoPelaConexao({ ...base, sessaoTemResponsaveis: false })).toBe(true);
    expect(envioPermitidoPelaConexao({ ...base, conversaAbertaEMinha: true })).toBe(true);
  });
  it("fora do modo restrito → sempre", () => {
    expect(envioPermitidoPelaConexao({ ...base, restrito: false })).toBe(true);
  });
});

describe("avisoDeConexaoAlheia — o aviso do Chat", () => {
  it("aparece quando a conversa não está numa conexão minha", () => {
    expect(avisoDeConexaoAlheia(["minha"], "da-ingrid")).toBe(true);
  });
  it("não aparece na minha conexão, nem para quem não tem conexão vinculada", () => {
    expect(avisoDeConexaoAlheia(["minha"], "minha")).toBe(false);
    expect(avisoDeConexaoAlheia([], "da-ingrid")).toBe(false);
    expect(avisoDeConexaoAlheia(undefined, "da-ingrid")).toBe(false);
  });
});

// ─── 2. a leitura e a guarda, sobre o banco em memória ─────────────────────

describe("carregarOpcoesDeAbertura", () => {
  const base = { organizationId: ORG, userId: ROSANA, role: "agent", contactId: LUCAS };

  it("o caso real: minha conexão, e a conversa na da colega com o NOME da conexão", async () => {
    const op = await carregarOpcoesDeAbertura(cenario(), base);
    expect(op.minha_conexao).toEqual({ id: SESS_ROSANA, nome: "Rosana Comercial", conectada: true });
    expect(op.conversas.map((c) => [c.conversation_id, c.conexao_nome, c.conexao_de_outro])).toEqual([
      [CONV_INGRID, "Ingrid Müller", true],
    ]);
    expect(op.contato_em_conexao_de_outro).toBe(true);
    expect(decidirAbertura(op).tipo).toBe("escolher");
  });

  it("conexão arquivada e de rede social nunca viram opção", async () => {
    const op = await carregarOpcoesDeAbertura(cenario(), base);
    const ids = op.conversas.map((c) => c.conversation_id);
    expect(ids).not.toContain(CONV_ARQUIVADA);
    expect(ids).not.toContain(CONV_INSTAGRAM);
  });

  it("⭐ isolamento: a conexão de OUTRA organização nunca entra como minha", async () => {
    const op = await carregarOpcoesDeAbertura(cenario(), { ...base, contactId: null });
    expect(op.minhas_conexoes_ids).toEqual([SESS_ROSANA]);
    expect(op.conexoes_com_responsavel_ids).not.toContain(SESS_OUTRA_ORG);
  });

  it("⭐ visibilidade: conversa que a pessoa não enxerga não vira opção, mas conta como de outro", async () => {
    // A sessão (RLS) da Rosana não enxerga a conversa da Ingrid.
    const sessaoDaRosana = bancoEmMemoria({ ...tabelas(), conversations: [] });
    const op = await carregarOpcoesDeAbertura(cenario(), { ...base, sessao: sessaoDaRosana });
    expect(op.conversas).toEqual([]);
    expect(op.contato_em_conexao_de_outro).toBe(true);
    expect(decidirAbertura(op)).toEqual({
      tipo: "iniciar",
      conexao: { id: SESS_ROSANA, nome: "Rosana Comercial", conectada: true },
    });
  });

  it("gerente vê todas, mesmo com o recorte da sessão vazio", async () => {
    const vazia = bancoEmMemoria({ conversations: [] });
    const op = await carregarOpcoesDeAbertura(cenario(), { ...base, role: "manager", sessao: vazia });
    expect(op.conversas.map((c) => c.conversation_id)).toEqual([CONV_INGRID]);
  });

  it("gerente nunca é restrito; atendente é, no modo 'só a conexão própria'", async () => {
    const db = cenario({ modo: "own_only" });
    expect((await carregarOpcoesDeAbertura(db, base)).restrito).toBe(true);
    expect((await carregarOpcoesDeAbertura(db, { ...base, role: "manager" })).restrito).toBe(false);
  });

  it("minha conexão fora do ar: segue sendo a minha, marcada como desconectada", async () => {
    const op = await carregarOpcoesDeAbertura(cenario({ rosanaDesconectada: true }), base);
    expect(op.minha_conexao).toEqual({ id: SESS_ROSANA, nome: "Rosana Comercial", conectada: false });
  });

  describe("transferido para mim", () => {
    it("conversa ABERTA do contato atribuída a mim conta", async () => {
      const op = await carregarOpcoesDeAbertura(cenario({ donaDaConversa: ROSANA }), base);
      expect(op.transferido_para_mim).toBe(true);
    });
    it("conversa ENCERRADA atribuída a mim não conta", async () => {
      const op = await carregarOpcoesDeAbertura(cenario({ donaDaConversa: ROSANA, statusDaConversa: "closed" }), base);
      expect(op.transferido_para_mim).toBe(false);
    });
    it("negócio passado a mim por OUTRA pessoa conta", async () => {
      const op = await carregarOpcoesDeAbertura(cenario({ trocaDoNegocioPor: GERENTE }), { ...base, leadId: LEAD });
      expect(op.transferido_para_mim).toBe(true);
    });
    it("negócio que EU me atribuí não conta", async () => {
      const op = await carregarOpcoesDeAbertura(cenario({ trocaDoNegocioPor: ROSANA }), { ...base, leadId: LEAD });
      expect(op.transferido_para_mim).toBe(false);
    });
    it("negócio meu sem troca registrada (eu criei) não conta", async () => {
      const op = await carregarOpcoesDeAbertura(cenario(), { ...base, leadId: LEAD });
      expect(op.transferido_para_mim).toBe(false);
    });
    it("negócio de OUTRO contato não serve de passe", async () => {
      const op = await carregarOpcoesDeAbertura(cenario({ trocaDoNegocioPor: GERENTE }), {
        ...base,
        contactId: "00000000-0000-4000-8000-000000000999",
        leadId: LEAD,
      });
      expect(op.transferido_para_mim).toBe(false);
    });
  });
});

describe("guardarConexaoAoAbrir — o lado do servidor do POST", () => {
  const base = { organizationId: ORG, userId: ROSANA, role: "agent" };

  describe("modo 'deixar escolher'", () => {
    it("passa a sessão pedida adiante, sem trocar", async () => {
      const g = await guardarConexaoAoAbrir(cenario(), {
        ...base,
        input: { contact_id: LUCAS, channel_session_id: SESS_INGRID },
      });
      expect(g).toEqual({ ok: true, channelSessionId: SESS_INGRID });
    });

    it("sem sessão pedida e com conexão própria → a minha (não a mais antiga da org)", async () => {
      const g = await guardarConexaoAoAbrir(cenario(), { ...base, input: { contact_id: LUCAS } });
      expect(g).toEqual({ ok: true, channelSessionId: SESS_ROSANA });
    });

    it("sem sessão pedida e sem conexão própria → como antes (o fallback da org)", async () => {
      const g = await guardarConexaoAoAbrir(cenario(), {
        ...base,
        userId: SEM_NUMERO,
        input: { contact_id: LUCAS },
      });
      expect(g).toEqual({ ok: true, channelSessionId: undefined });
    });
  });

  describe("modo 'só a conexão própria'", () => {
    const own = { modo: "own_only" as const };

    it("recusa sessão que não é da pessoa", async () => {
      const g = await guardarConexaoAoAbrir(cenario({ ...own, donaDaConversa: ROSANA }), {
        ...base,
        input: { contact_id: LUCAS, channel_session_id: SESS_INGRID },
      });
      expect(g).toEqual({ ok: false, motivo: "conexao_alheia" });
    });

    it("contato da colega sem transferência → recusa", async () => {
      const g = await guardarConexaoAoAbrir(cenario(own), { ...base, input: { contact_id: LUCAS } });
      expect(g).toEqual({ ok: false, motivo: "contato_de_outro" });
    });

    it("conversa transferida para ela → sai pela conexão DELA mesmo sem pedir", async () => {
      const g = await guardarConexaoAoAbrir(cenario({ ...own, donaDaConversa: ROSANA }), {
        ...base,
        input: { contact_id: LUCAS },
      });
      expect(g).toEqual({ ok: true, channelSessionId: SESS_ROSANA });
    });

    it("negócio passado a ela pelo gerente → sai pela conexão dela", async () => {
      const g = await guardarConexaoAoAbrir(cenario({ ...own, trocaDoNegocioPor: GERENTE }), {
        ...base,
        input: { contact_id: LUCAS, lead_id: LEAD },
      });
      expect(g).toEqual({ ok: true, channelSessionId: SESS_ROSANA });
    });

    it("negócio que ela mesma se atribuiu → continua recusado", async () => {
      const g = await guardarConexaoAoAbrir(cenario({ ...own, trocaDoNegocioPor: ROSANA }), {
        ...base,
        input: { contact_id: LUCAS, lead_id: LEAD },
      });
      expect(g).toEqual({ ok: false, motivo: "contato_de_outro" });
    });

    it("gerente escolhe qualquer conexão", async () => {
      const g = await guardarConexaoAoAbrir(cenario(own), {
        ...base,
        role: "manager",
        input: { contact_id: LUCAS, channel_session_id: SESS_INGRID },
      });
      expect(g).toEqual({ ok: true, channelSessionId: SESS_INGRID });
    });

    describe("sem conexão vinculada", () => {
      const semNumero = { ...base, userId: SEM_NUMERO };
      const NOVO = "00000000-0000-4000-8000-000000000102";

      it("conexão de colega → recusa", async () => {
        const g = await guardarConexaoAoAbrir(cenario(own), {
          ...semNumero,
          input: { contact_id: NOVO, channel_session_id: SESS_INGRID },
        });
        expect(g).toEqual({ ok: false, motivo: "conexao_alheia" });
      });

      it("número geral pedido → passa", async () => {
        const g = await guardarConexaoAoAbrir(cenario(own), {
          ...semNumero,
          input: { contact_id: NOVO, channel_session_id: SESS_GERAL },
        });
        expect(g).toEqual({ ok: true, channelSessionId: SESS_GERAL });
      });

      it("sem sessão pedida → o número geral", async () => {
        const g = await guardarConexaoAoAbrir(cenario(own), { ...semNumero, input: { contact_id: NOVO } });
        expect(g).toEqual({ ok: true, channelSessionId: SESS_GERAL });
      });

      it("conversa do contato no número geral → reaproveita a do geral", async () => {
        const g = await guardarConexaoAoAbrir(cenario({ ...own, conversaNoGeral: true }), {
          ...semNumero,
          input: { contact_id: LUCAS },
        });
        expect(g).toEqual({ ok: true, channelSessionId: SESS_GERAL });
      });

      it("sem número geral na organização → recusa (sem_conexao)", async () => {
        const g = await guardarConexaoAoAbrir(cenario({ ...own, semGeral: true }), {
          ...semNumero,
          input: { contact_id: NOVO },
        });
        expect(g).toEqual({ ok: false, motivo: "sem_conexao" });
      });
    });
  });
});

describe("envioRecusadoPelaConexao — o envio do Chat", () => {
  const base = {
    organizationId: ORG,
    userId: ROSANA,
    role: "agent",
    conversationId: CONV_INGRID,
    channelSessionId: SESS_INGRID,
  };
  it("modo 'deixar escolher' → nunca recusa", async () => {
    expect(await envioRecusadoPelaConexao(cenario(), base)).toBe(false);
  });
  it("own_only: conexão da colega em conversa que não é minha → recusa", async () => {
    expect(await envioRecusadoPelaConexao(cenario({ modo: "own_only" }), base)).toBe(true);
  });
  it("own_only: conversa ABERTA atribuída a mim (transferência) → permite", async () => {
    expect(await envioRecusadoPelaConexao(cenario({ modo: "own_only", donaDaConversa: ROSANA }), base)).toBe(false);
  });
  it("own_only: conversa ENCERRADA atribuída a mim → recusa", async () => {
    expect(
      await envioRecusadoPelaConexao(
        cenario({ modo: "own_only", donaDaConversa: ROSANA, statusDaConversa: "closed" }),
        base,
      ),
    ).toBe(true);
  });
  it("own_only: minha conexão e número geral → permite", async () => {
    const db = cenario({ modo: "own_only" });
    expect(await envioRecusadoPelaConexao(db, { ...base, channelSessionId: SESS_ROSANA })).toBe(false);
    expect(await envioRecusadoPelaConexao(db, { ...base, channelSessionId: SESS_GERAL })).toBe(false);
  });
  it("own_only: gerente → permite", async () => {
    expect(await envioRecusadoPelaConexao(cenario({ modo: "own_only" }), { ...base, role: "manager" })).toBe(false);
  });
});

// ─── 3. a sessão pedida é da organização da sessão do usuário ──────────────

describe("openSharedContactConversation — channel_session_id validado pela organização", () => {
  it("⭐ isolamento: sessão de OUTRA organização → session_not_found", async () => {
    await expect(
      openSharedContactConversation(cenario(), ORG, { contact_id: LUCAS, channel_session_id: SESS_OUTRA_ORG }),
    ).rejects.toThrow("session_not_found");
  });

  it("sessão que não é de mensagem (voz) → session_not_found", async () => {
    const db = bancoEmMemoria({
      channel_sessions: [sessao(SESS_ROSANA, ORG, "Linha de voz", { provider: CHANNEL_PROVIDER_WACALLS })],
    });
    await expect(
      openSharedContactConversation(db, ORG, { contact_id: LUCAS, channel_session_id: SESS_ROSANA }),
    ).rejects.toThrow("session_not_found");
  });
});
