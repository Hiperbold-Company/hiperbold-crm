/**
 * Ação "Atribuir a conversa e iniciar o atendimento" (`assign_conversation`),
 * pelo executor de produção.
 *
 * O banco é em memória e FILTRA de verdade (organização, contato, canal,
 * membro ativo), e a função `fn_conversation_assign` é reproduzida na borda
 * com as mesmas recusas da real (conversa de outra organização, destino que
 * não é atendente). O que se mede é a escolha da conversa, a conferência da
 * pessoa e o desfecho — não um mock do próprio código.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock, comandoMock } = vi.hoisted(() => ({ auditMock: vi.fn(), comandoMock: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: auditMock, isServiceRoleConfigured: () => true }));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({ registrarTrocaDeComando: comandoMock }));

import type { PedidoDeEfeito } from "@/lib/followup/engine";
import type { FlowNode } from "@/lib/followup/graph-schema";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";

import type { FatosDaAutomacao } from "../fatos";
import { crmActionSchema } from "../schemas";
import { fraseDoErro } from "../vocabulario";
import { criarExecutorDeEfeitos } from "./index";

type Linha = Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OUTRA_ORG = "00000000-0000-4000-8000-0000000000b2";
const CONTATO = "20000000-0000-4000-8000-000000000001";
const ANA = "30000000-0000-4000-8000-000000000001";
const VISUALIZADOR = "30000000-0000-4000-8000-000000000002";
const DE_OUTRA_ORG = "30000000-0000-4000-8000-000000000003";
const CANAL_GATILHO = "40000000-0000-4000-8000-000000000001";
const OUTRO_CANAL = "40000000-0000-4000-8000-000000000002";
/** Silêncio durável: alguém assumiu ou pausou — a IA NÃO está no comando. */
const CALADA = { bot_silenced_until: "infinity" };

function criarBanco(tabelas: Record<string, Linha[]>) {
  const rpcs: Array<{ nome: string; args: Linha }> = [];
  /** Cada `from(tabela)` aberto, na ordem: mede quantas vezes o efeito foi ao negócio. */
  const lidas: string[] = [];
  const valor = (l: Linha, c: string) => l[c];
  const admin = {
    from(tabela: string) {
      lidas.push(tabela);
      const filtros: Array<(l: Linha) => boolean> = [];
      let limite = Infinity;
      let ordem: { col: string; asc: boolean } | null = null;
      let escrita: Linha | null = null;
      const executar = () => {
        let linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        if (ordem) {
          const { col, asc } = ordem;
          linhas = [...linhas].sort((a, b) => {
            const x = String(a[col] ?? ""),
              y = String(b[col] ?? "");
            return asc ? x.localeCompare(y) : y.localeCompare(x);
          });
        }
        if (escrita) for (const l of linhas) Object.assign(l, escrita);
        return linhas.slice(0, limite);
      };
      const b: Record<string, unknown> = {
        select: () => b,
        update(patch: Linha) {
          escrita = patch;
          return b;
        },
        eq(c: string, v: unknown) {
          filtros.push((l) => valor(l, c) === v);
          return b;
        },
        in(c: string, vs: unknown[]) {
          filtros.push((l) => vs.includes(valor(l, c)));
          return b;
        },
        is(c: string, v: null) {
          filtros.push((l) => (valor(l, c) ?? null) === v);
          return b;
        },
        not(c: string, op: string, v: string) {
          // `.not("col", "in", "(a,b)")`: a única forma que o efeito usa.
          const fora = op === "in" ? v.replace(/[()]/g, "").split(",") : [];
          filtros.push((l) => !fora.includes(String(valor(l, c))));
          return b;
        },
        order(col: string, o?: { ascending?: boolean }) {
          ordem = { col, asc: o?.ascending !== false };
          return b;
        },
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
    rpc(nome: string, args: Linha) {
      rpcs.push({ nome, args });
      if (nome !== "fn_conversation_assign") return Promise.resolve({ data: null, error: null });
      // A função real: só alcança conversa da organização e só entrega a agent+ dela.
      const membro = (tabelas.user_organizations ?? []).find(
        (m) => m.organization_id === args.p_organization_id && m.user_id === args.p_to_user_id && m.revoked_at == null,
      );
      if (!membro || membro.role === "viewer") {
        return Promise.resolve({ data: null, error: { message: "assignee_not_eligible_member" } });
      }
      const conv = (tabelas.conversations ?? []).find(
        (c) => c.id === args.p_conversation_id && c.organization_id === args.p_organization_id,
      );
      if (!conv) return Promise.resolve({ data: [], error: null });
      conv.assigned_to_user_id = args.p_to_user_id;
      conv.status = "claimed";
      return Promise.resolve({ data: [conv], error: null });
    },
  };
  return { admin: admin as unknown as SupabaseClient, tabelas, rpcs, lidas };
}

function tabelasBase(conversas: Linha[]): Record<string, Linha[]> {
  return {
    contacts: [{ id: CONTATO, organization_id: ORG, phone_number: null, is_merged_into: null, is_personal: false }],
    user_organizations: [
      { organization_id: ORG, user_id: ANA, role: "agent", revoked_at: null },
      { organization_id: ORG, user_id: VISUALIZADOR, role: "viewer", revoked_at: null },
      { organization_id: OUTRA_ORG, user_id: DE_OUTRA_ORG, role: "agent", revoked_at: null },
    ],
    conversations: conversas,
  };
}

const conversa = (over: Linha): Linha => ({
  organization_id: ORG,
  contact_id: CONTATO,
  is_group: false,
  assigned_to_user_id: null,
  last_message_at: "2026-11-14T10:00:00Z",
  ...over,
});

function pedido(userId: string, vars: Record<string, unknown> = {}, onError: "route" | "continue" = "route"): PedidoDeEfeito {
  const fatos = {
    contato: { id: CONTATO, name: "Maria", email: null, phone_number: null, birthdate: null, tags: [], custom_fields: {} },
    negocio: null,
    negocios: [],
    vars,
  } as unknown as FatosDaAutomacao;
  return {
    enrollment: {
      id: "e1",
      organization_id: ORG,
      contact_id: CONTATO,
      pointer_id: "p1",
      vars,
    } as EnrollmentRow,
    node: {
      id: "acao-1",
      type: "crm_action",
      label: "Atribuir",
      position: { x: 0, y: 0 },
      config: { actions: [{ type: "assign_conversation", user_id: userId }], on_error: onError },
    } as FlowNode,
    fatos,
    chave: "acao-1:1",
  };
}

/** O mesmo pedido, pedindo TODAS as conversas abertas do contato. */
function pedidoTodas(userId: string, vars: Record<string, unknown> = {}): PedidoDeEfeito {
  const p = pedido(userId, vars);
  const config = (p.node as { config: { actions: Array<Record<string, unknown>> } }).config;
  config.actions[0]!.todas = true;
  return p;
}

const executar = (admin: SupabaseClient, p: PedidoDeEfeito) =>
  criarExecutorDeEfeitos(admin, { podeProduzir: async () => true }).executar(p);

beforeEach(() => {
  auditMock.mockReset();
  comandoMock.mockReset();
});

describe("assign_conversation", () => {
  it("o schema pede só uma pessoa (uuid)", () => {
    expect(crmActionSchema.safeParse({ type: "assign_conversation", user_id: ANA }).success).toBe(true);
    expect(crmActionSchema.safeParse({ type: "assign_conversation", user_id: "" }).success).toBe(false);
    expect(crmActionSchema.safeParse({ type: "assign_conversation" }).success).toBe(false);
    expect(crmActionSchema.safeParse({ type: "assign_conversation", user_id: ANA, extra: 1 }).success).toBe(false);
  });

  it("atribui a conversa, avisa o destino, audita e registra na linha do tempo", async () => {
    const { admin, tabelas, rpcs } = criarBanco(tabelasBase([conversa({ id: "c1" })]));
    const r = await executar(admin, pedido(ANA));
    expect(r.desfecho).toEqual({ ok: true });
    expect(tabelas.conversations![0]).toMatchObject({ assigned_to_user_id: ANA, status: "claimed" });
    const troca = rpcs.find((x) => x.nome === "fn_conversation_assign")!;
    expect(troca.args).toMatchObject({
      p_organization_id: ORG,
      p_conversation_id: "c1",
      p_to_user_id: ANA,
      p_reason: "transfer",
      p_enforce_expected: false,
    });
    expect(rpcs.some((x) => x.nome === "emit_event" && x.args.p_event_type === "conversation.transferred")).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.transferred",
        organizationId: ORG,
        resourceId: "c1",
        metadata: expect.objectContaining({ origem: "automacao", to_user_id: ANA }),
      }),
    );
    expect(comandoMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, conversationId: "c1", tipo: "conversation_transferred" }),
    );
    expect(r.detalhes?.[0]).toMatchObject({ tipo: "assign_conversation", ok: true, conversation_id: "c1" });
  });

  it("escolhe a mais recente do canal do gatilho, mesmo havendo uma mais nova em outro canal", async () => {
    const { admin, tabelas } = criarBanco(
      tabelasBase([
        conversa({ id: "no-gatilho", channel_session_id: CANAL_GATILHO, last_message_at: "2026-11-13T10:00:00Z" }),
        conversa({ id: "mais-nova-outro-canal", channel_session_id: OUTRO_CANAL, last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "no-gatilho-antiga", channel_session_id: CANAL_GATILHO, last_message_at: "2026-11-01T10:00:00Z" }),
      ]),
    );
    const r = await executar(admin, pedido(ANA, { gatilho: { tipo: "message_received", channel_session_id: CANAL_GATILHO } }));
    expect(r.desfecho).toEqual({ ok: true });
    const donos = Object.fromEntries(tabelas.conversations!.map((c) => [c.id as string, c.assigned_to_user_id]));
    expect(donos).toEqual({ "no-gatilho": ANA, "mais-nova-outro-canal": null, "no-gatilho-antiga": null });
  });

  it("sem conversa no canal do gatilho, usa a mais recente do contato", async () => {
    const { admin, tabelas } = criarBanco(
      tabelasBase([
        conversa({ id: "antiga", channel_session_id: OUTRO_CANAL, last_message_at: "2026-11-01T10:00:00Z" }),
        conversa({ id: "recente", channel_session_id: OUTRO_CANAL, last_message_at: "2026-11-14T10:00:00Z" }),
      ]),
    );
    await executar(admin, pedido(ANA, { gatilho: { channel_session_id: CANAL_GATILHO } }));
    expect(tabelas.conversations!.find((c) => c.id === "recente")!.assigned_to_user_id).toBe(ANA);
    expect(tabelas.conversations!.find((c) => c.id === "antiga")!.assigned_to_user_id).toBeNull();
  });

  describe("conversa ativa (`vars.conversa_ativa`)", () => {
    const ativa = (conversationId: string, channelSessionId: string) => ({
      conversa_ativa: { conversation_id: conversationId, channel_session_id: channelSessionId, canal: null },
    });

    it("a principal é a conversa ativa, mesmo com o gatilho em outra conexão", async () => {
      const { admin, tabelas } = criarBanco(
        tabelasBase([
          conversa({ id: "no-gatilho", channel_session_id: CANAL_GATILHO, last_message_at: "2026-11-14T10:00:00Z" }),
          conversa({ id: "ativa", channel_session_id: OUTRO_CANAL, last_message_at: "2026-11-01T10:00:00Z" }),
        ]),
      );
      const r = await executar(
        admin,
        pedido(ANA, {
          gatilho: { tipo: "message_received", channel_session_id: CANAL_GATILHO },
          ...ativa("ativa", OUTRO_CANAL),
        }),
      );
      expect(r.desfecho).toEqual({ ok: true });
      const donos = Object.fromEntries(tabelas.conversations!.map((c) => [c.id as string, c.assigned_to_user_id]));
      expect(donos).toEqual({ "no-gatilho": null, ativa: ANA });
    });

    it("conversa ativa de outro contato não vale: cai na regra antiga", async () => {
      const { admin, tabelas } = criarBanco(
        tabelasBase([
          conversa({ id: "no-gatilho", channel_session_id: CANAL_GATILHO, last_message_at: "2026-11-01T10:00:00Z" }),
          conversa({
            id: "alheia",
            contact_id: "20000000-0000-4000-8000-0000000000ff",
            channel_session_id: OUTRO_CANAL,
            last_message_at: "2026-11-14T10:00:00Z",
          }),
        ]),
      );
      const r = await executar(
        admin,
        pedido(ANA, {
          gatilho: { tipo: "message_received", channel_session_id: CANAL_GATILHO },
          ...ativa("alheia", OUTRO_CANAL),
        }),
      );
      expect(r.desfecho).toEqual({ ok: true });
      const donos = Object.fromEntries(tabelas.conversations!.map((c) => [c.id as string, c.assigned_to_user_id]));
      expect(donos).toEqual({ "no-gatilho": ANA, alheia: null });
    });

    it("conversa ativa já encerrada não vale: cai na regra antiga", async () => {
      const { admin, tabelas } = criarBanco(
        tabelasBase([
          conversa({ id: "no-gatilho", channel_session_id: CANAL_GATILHO, last_message_at: "2026-11-01T10:00:00Z" }),
          conversa({ id: "fechada", channel_session_id: OUTRO_CANAL, status: "closed", last_message_at: "2026-11-14T10:00:00Z" }),
        ]),
      );
      await executar(admin, pedido(ANA, { gatilho: { channel_session_id: CANAL_GATILHO }, ...ativa("fechada", OUTRO_CANAL) }));
      expect(tabelas.conversations!.find((c) => c.id === "no-gatilho")!.assigned_to_user_id).toBe(ANA);
      expect(tabelas.conversations!.find((c) => c.id === "fechada")!.assigned_to_user_id).toBeNull();
    });

    it("sem conversa ativa: igual ao comportamento de sempre (canal do gatilho)", async () => {
      const { admin, tabelas } = criarBanco(
        tabelasBase([
          conversa({ id: "no-gatilho", channel_session_id: CANAL_GATILHO, last_message_at: "2026-11-13T10:00:00Z" }),
          conversa({ id: "mais-nova", channel_session_id: OUTRO_CANAL, last_message_at: "2026-11-14T10:00:00Z" }),
        ]),
      );
      await executar(admin, pedido(ANA, { gatilho: { tipo: "message_received", channel_session_id: CANAL_GATILHO } }));
      const donos = Object.fromEntries(tabelas.conversations!.map((c) => [c.id as string, c.assigned_to_user_id]));
      expect(donos).toEqual({ "no-gatilho": ANA, "mais-nova": null });
    });
  });

  it("contato sem conversa: saída de erro `sem_conversa`, sem lançar e sem escrever", async () => {
    const { admin, rpcs } = criarBanco(tabelasBase([]));
    const r = await executar(admin, pedido(ANA));
    expect(r.desfecho).toEqual({ ok: false, erro: "sem_conversa" });
    expect(fraseDoErro("sem_conversa")).toContain("conversa");
    expect(rpcs.some((x) => x.nome === "fn_conversation_assign")).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("conversa de outra organização nunca é alcançada", async () => {
    const { admin, tabelas } = criarBanco(tabelasBase([conversa({ id: "alheia", organization_id: OUTRA_ORG })]));
    const r = await executar(admin, pedido(ANA));
    expect(r.desfecho).toEqual({ ok: false, erro: "sem_conversa" });
    expect(tabelas.conversations![0]!.assigned_to_user_id).toBeNull();
  });

  it("usuário de outra organização, visualizador ou desconhecido: erro `usuario_invalido`, nada muda", async () => {
    for (const quem of [DE_OUTRA_ORG, VISUALIZADOR, "30000000-0000-4000-8000-0000000000ff"]) {
      const { admin, tabelas, rpcs } = criarBanco(tabelasBase([conversa({ id: "c1" })]));
      const r = await executar(admin, pedido(quem));
      expect(r.desfecho, quem).toEqual({ ok: false, erro: "usuario_invalido" });
      expect(tabelas.conversations![0]!.assigned_to_user_id).toBeNull();
      expect(rpcs.some((x) => x.nome === "fn_conversation_assign")).toBe(false);
    }
    expect(auditMock).not.toHaveBeenCalled();
    expect(comandoMock).not.toHaveBeenCalled();
  });

  it("membro revogado não recebe a conversa", async () => {
    const base = tabelasBase([conversa({ id: "c1" })]);
    base.user_organizations![0]!.revoked_at = "2026-11-10T00:00:00Z";
    const { admin, tabelas } = criarBanco(base);
    const r = await executar(admin, pedido(ANA));
    expect(r.desfecho).toEqual({ ok: false, erro: "usuario_invalido" });
    expect(tabelas.conversations![0]!.assigned_to_user_id).toBeNull();
  });

  it("contato pessoal: erro `contato_pessoal`, sem atribuir, sem auditar", async () => {
    const base = tabelasBase([conversa({ id: "c1" })]);
    base.contacts![0]!.is_personal = true;
    const { admin, tabelas, rpcs } = criarBanco(base);
    const r = await executar(admin, pedido(ANA));
    expect(r.desfecho).toEqual({ ok: false, erro: "contato_pessoal" });
    expect(fraseDoErro("contato_pessoal")).toContain("pessoal");
    expect(tabelas.conversations![0]!.assigned_to_user_id).toBeNull();
    expect(rpcs.some((x) => x.nome === "fn_conversation_assign")).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("gêmeo de telefone pessoal também barra", async () => {
    const GEMEO = "20000000-0000-4000-8000-000000000009";
    const base = tabelasBase([conversa({ id: "c1" }), conversa({ id: "c-gemeo", contact_id: GEMEO })]);
    base.contacts![0]!.phone_number = "+5532984793302";
    base.contacts!.push({ id: GEMEO, organization_id: ORG, phone_number: "+553284793302", is_merged_into: null, is_personal: true });
    const { admin, tabelas } = criarBanco(base);
    const r = await executar(admin, pedido(ANA));
    expect(r.desfecho).toEqual({ ok: false, erro: "contato_pessoal" });
    expect(tabelas.conversations!.every((c) => c.assigned_to_user_id === null)).toBe(true);
  });

  it("conversa fechada não é reaberta: só as não fechadas entram, e sem nenhuma é `sem_conversa`", async () => {
    const { admin, tabelas } = criarBanco(
      tabelasBase([
        conversa({ id: "fechada-recente", status: "closed", last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "arquivada", status: "archived", last_message_at: "2026-11-13T10:00:00Z" }),
        conversa({ id: "resolvida", status: "resolved", last_message_at: "2026-11-12T10:00:00Z" }),
        conversa({ id: "aberta-antiga", status: "open", last_message_at: "2026-11-01T10:00:00Z" }),
      ]),
    );
    expect((await executar(admin, pedido(ANA))).desfecho).toEqual({ ok: true });
    const donos = Object.fromEntries(tabelas.conversations!.map((c) => [c.id as string, c.assigned_to_user_id]));
    expect(donos).toEqual({ "fechada-recente": null, arquivada: null, resolvida: null, "aberta-antiga": ANA });

    const so = criarBanco(tabelasBase([conversa({ id: "f", status: "closed" }), conversa({ id: "a", status: "archived" })]));
    const r = await executar(so.admin, pedido(ANA));
    expect(r.desfecho).toEqual({ ok: false, erro: "sem_conversa" });
    expect(so.rpcs.some((x) => x.nome === "fn_conversation_assign")).toBe(false);
    expect(so.tabelas.conversations!.every((c) => c.assigned_to_user_id === null)).toBe(true);
  });

  it("a auditoria leva o dono anterior, o número antes e depois e a versão, só ids", async () => {
    const { admin } = criarBanco(
      tabelasBase([conversa({ id: "c1", assigned_to_user_id: VISUALIZADOR, channel_session_id: OUTRO_CANAL, status: "open" })]),
    );
    const p = pedido(ANA);
    (p.enrollment as { version_id: string }).version_id = "50000000-0000-4000-8000-000000000001";
    await executar(admin, p);
    const meta = auditMock.mock.calls[0]![0].metadata as Record<string, unknown>;
    expect(meta).toMatchObject({
      to_user_id: ANA,
      from_user_id: VISUALIZADOR,
      numero_anterior: OUTRO_CANAL,
      numero_novo: OUTRO_CANAL,
      version_id: "50000000-0000-4000-8000-000000000001",
      negocio_aberto: "sem_negocio_aberto",
    });
  });

  it("o negócio aberto do contato passa para o atendente, como na transferência manual", async () => {
    const base = tabelasBase([conversa({ id: "c1" })]);
    base.crm_leads = [{ id: "L1", organization_id: ORG, contact_id: CONTATO, status: "open", owner_user_id: null, owner_agent_id: null }];
    const { admin, rpcs } = criarBanco(base);
    await executar(admin, pedido(ANA));
    expect(base.crm_leads![0]).toMatchObject({ owner_user_id: ANA });
    expect(auditMock.mock.calls[0]![0].metadata).toMatchObject({ negocio_aberto: "sincronizado", negocio_id: "L1" });
    expect(rpcs.some((x) => x.nome === "fn_conversation_assign")).toBe(true);
  });

  it("o schema aceita `todas` só como booleano, e a forma antiga segue valendo", () => {
    expect(crmActionSchema.safeParse({ type: "assign_conversation", user_id: ANA, todas: true }).success).toBe(true);
    expect(crmActionSchema.safeParse({ type: "assign_conversation", user_id: ANA, todas: false }).success).toBe(true);
    expect(crmActionSchema.safeParse({ type: "assign_conversation", user_id: ANA, todas: "sim" }).success).toBe(false);
  });
});

describe("assign_conversation com `todas`", () => {
  const dono = (tabelas: Record<string, Linha[]>) =>
    Object.fromEntries(tabelas.conversations!.map((c) => [c.id as string, c.assigned_to_user_id]));
  const baseComNegocio = (conversas: Linha[]) => {
    const base = tabelasBase(conversas);
    base.crm_leads = [{ id: "L1", organization_id: ORG, contact_id: CONTATO, status: "open", owner_user_id: null, owner_agent_id: null }];
    return base;
  };
  const leituras = (lidas: string[], tabela: string) => lidas.filter((t) => t === tabela).length;

  it("com 2 conversas abertas, atribui as duas (a principal primeiro) e conta no detalhe", async () => {
    const { admin, tabelas, rpcs } = criarBanco(
      tabelasBase([
        conversa({ id: "whatsapp-antiga", channel_session_id: CANAL_GATILHO, last_message_at: "2026-11-01T10:00:00Z" }),
        conversa({ id: "direct-recente", channel_session_id: OUTRO_CANAL, last_message_at: "2026-11-14T10:00:00Z", ...CALADA }),
      ]),
    );
    const r = await executar(admin, pedidoTodas(ANA, { gatilho: { channel_session_id: CANAL_GATILHO } }));
    expect(r.desfecho).toEqual({ ok: true });
    const trocas = rpcs.filter((x) => x.nome === "fn_conversation_assign");
    // A principal (a do canal do gatilho) primeiro; depois as demais, a mais recente primeiro.
    expect(trocas.map((x) => x.args.p_conversation_id)).toEqual(["whatsapp-antiga", "direct-recente"]);
    expect(dono(tabelas)).toEqual({ "whatsapp-antiga": ANA, "direct-recente": ANA });
    expect(r.detalhes?.[0]).toMatchObject({
      tipo: "assign_conversation",
      ok: true,
      user_id: ANA,
      conversation_id: "whatsapp-antiga",
      conversas: 2,
      puladas_ia: 0,
      ja_eram_dela: 0,
    });
    expect(r.detalhes?.[0]).not.toHaveProperty("falhas");
    expect(r.detalhes?.[0]).not.toHaveProperty("truncado");
    // Cada conversa deixa os seus rastros: auditoria, aviso do destino e linha do tempo.
    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(comandoMock).toHaveBeenCalledTimes(2);
    expect(rpcs.filter((x) => x.nome === "emit_event")).toHaveLength(2);
  });

  it("o negócio aberto é sincronizado UMA vez por contato, não uma por conversa", async () => {
    const uma = criarBanco(baseComNegocio([conversa({ id: "c1" })]));
    await executar(uma.admin, pedido(ANA));
    const duas = criarBanco(
      baseComNegocio([
        conversa({ id: "c1", last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "c2", last_message_at: "2026-11-13T10:00:00Z", ...CALADA }),
      ]),
    );
    await executar(duas.admin, pedidoTodas(ANA));
    expect(duas.tabelas.crm_leads![0]).toMatchObject({ owner_user_id: ANA });
    // O mesmo número de idas ao negócio que a atribuição de uma conversa só.
    expect(leituras(duas.lidas, "crm_leads")).toBe(leituras(uma.lidas, "crm_leads"));
    expect(leituras(duas.lidas, "crm_leads")).toBeGreaterThan(0);
    const motivos = auditMock.mock.calls.slice(-2).map((c) => (c[0].metadata as Record<string, unknown>).negocio_aberto);
    // A segunda conversa do MESMO contato audita o motivo real da sincronia já feita.
    expect(motivos).toEqual(["sincronizado", "sincronizado"]);
  });

  it("só entram as não fechadas, de qualquer canal; gêmeo de outra organização não entra", async () => {
    const { admin, tabelas } = criarBanco(
      tabelasBase([
        conversa({ id: "a", status: "open", channel_session_id: CANAL_GATILHO }),
        conversa({ id: "b", status: "claimed", channel_session_id: OUTRO_CANAL, last_message_at: "2026-11-13T10:00:00Z", ...CALADA }),
        conversa({ id: "fechada", status: "closed", last_message_at: "2026-11-12T10:00:00Z" }),
        conversa({ id: "arquivada", status: "archived", last_message_at: "2026-11-11T10:00:00Z" }),
        conversa({ id: "grupo", is_group: true, last_message_at: "2026-11-10T10:00:00Z" }),
        conversa({ id: "alheia", organization_id: OUTRA_ORG, last_message_at: "2026-11-09T10:00:00Z" }),
      ]),
    );
    const r = await executar(admin, pedidoTodas(ANA));
    expect(r.desfecho).toEqual({ ok: true });
    expect(dono(tabelas)).toEqual({
      a: ANA,
      b: ANA,
      fechada: null,
      arquivada: null,
      grupo: null,
      alheia: null,
    });
    expect(r.detalhes?.[0]).toMatchObject({ conversas: 2 });
  });

  it("sem `todas`, continua sendo uma conversa só e o detalhe não traz a contagem", async () => {
    const { admin, tabelas, rpcs } = criarBanco(
      tabelasBase([
        conversa({ id: "c1", last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "c2", last_message_at: "2026-11-13T10:00:00Z" }),
      ]),
    );
    const r = await executar(admin, pedido(ANA));
    expect(r.desfecho).toEqual({ ok: true });
    expect(rpcs.filter((x) => x.nome === "fn_conversation_assign")).toHaveLength(1);
    expect(dono(tabelas)).toEqual({ c1: ANA, c2: null });
    expect(r.detalhes?.[0]).not.toHaveProperty("conversas");
  });

  it("com `todas: false` explícito também é uma conversa só", async () => {
    const { admin, rpcs } = criarBanco(
      tabelasBase([conversa({ id: "c1" }), conversa({ id: "c2", last_message_at: "2026-11-13T10:00:00Z" })]),
    );
    const p = pedidoTodas(ANA);
    (p.node as { config: { actions: Array<Record<string, unknown>> } }).config.actions[0]!.todas = false;
    await executar(admin, p);
    expect(rpcs.filter((x) => x.nome === "fn_conversation_assign")).toHaveLength(1);
  });

  it("a primeira recusada com assignee_not_eligible_member: erro `usuario_invalido`, nada atribuído nem auditado", async () => {
    const { admin, tabelas, rpcs } = criarBanco(
      tabelasBase([
        conversa({ id: "c1", last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "c2", last_message_at: "2026-11-13T10:00:00Z" }),
      ]),
    );
    // A pessoa passa na conferência do efeito e é recusada pela função do banco
    // (ex.: perdeu o acesso no meio do caminho): a recusa vem da primeira troca.
    const troca = admin.rpc.bind(admin) as (nome: string, args: Linha) => unknown;
    (admin as unknown as { rpc: unknown }).rpc = (nome: string, args: Linha) => {
      if (nome === "fn_conversation_assign") {
        rpcs.push({ nome, args });
        return Promise.resolve({ data: null, error: { message: "assignee_not_eligible_member" } });
      }
      return troca(nome, args);
    };
    const r = await executar(admin, pedidoTodas(ANA));
    expect(r.desfecho).toEqual({ ok: false, erro: "usuario_invalido" });
    expect(rpcs.filter((x) => x.nome === "fn_conversation_assign")).toHaveLength(1);
    expect(dono(tabelas)).toEqual({ c1: null, c2: null });
    expect(auditMock).not.toHaveBeenCalled();
    expect(comandoMock).not.toHaveBeenCalled();
  });

  it("falha que não é de elegibilidade na primeira devolve `efeito_falhou`", async () => {
    const { admin } = criarBanco(tabelasBase([conversa({ id: "c1" }), conversa({ id: "c2", last_message_at: "2026-11-13T10:00:00Z" })]));
    (admin as unknown as { rpc: unknown }).rpc = () => Promise.resolve({ data: null, error: { message: "boom" } });
    const r = await executar(admin, pedidoTodas(ANA));
    expect(r.desfecho).toEqual({ ok: false, erro: "efeito_falhou" });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("falha na segunda: registra e CONTINUA; o resultado é ok com as atribuídas e as falhas", async () => {
    const { admin, tabelas } = criarBanco(
      tabelasBase([
        conversa({ id: "c1", last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "c2", last_message_at: "2026-11-13T10:00:00Z", ...CALADA }),
        conversa({ id: "c3", last_message_at: "2026-11-12T10:00:00Z", ...CALADA }),
      ]),
    );
    const troca = admin.rpc.bind(admin) as (nome: string, args: Linha) => unknown;
    (admin as unknown as { rpc: unknown }).rpc = (nome: string, args: Linha) =>
      nome === "fn_conversation_assign" && args.p_conversation_id === "c2"
        ? Promise.resolve({ data: null, error: { message: "boom" } })
        : troca(nome, args);
    const r = await executar(admin, pedidoTodas(ANA));
    expect(r.desfecho).toEqual({ ok: true });
    // A falha da segunda não impede a terceira.
    expect(dono(tabelas)).toEqual({ c1: ANA, c2: null, c3: ANA });
    expect(r.detalhes?.[0]).toMatchObject({ conversas: 2, falhas: 1, conversation_id: "c1" });
  });

  it("`sem_conversa` numa conversa (sumiu entre a leitura e a troca) também não interrompe as próximas", async () => {
    const { admin, tabelas } = criarBanco(
      tabelasBase([
        conversa({ id: "c1", last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "c2", last_message_at: "2026-11-13T10:00:00Z", ...CALADA }),
      ]),
    );
    const troca = admin.rpc.bind(admin) as (nome: string, args: Linha) => unknown;
    (admin as unknown as { rpc: unknown }).rpc = (nome: string, args: Linha) =>
      nome === "fn_conversation_assign" && args.p_conversation_id === "c1"
        ? Promise.resolve({ data: [], error: null })
        : troca(nome, args);
    const r = await executar(admin, pedidoTodas(ANA));
    expect(r.desfecho).toEqual({ ok: true });
    expect(dono(tabelas)).toEqual({ c1: null, c2: ANA });
    expect(r.detalhes?.[0]).toMatchObject({ conversas: 1, falhas: 1, conversation_id: "c2" });
  });

  it("todas falham: erro da PRIMEIRA falha", async () => {
    const { admin } = criarBanco(
      tabelasBase([
        conversa({ id: "c1", last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "c2", last_message_at: "2026-11-13T10:00:00Z", ...CALADA }),
      ]),
    );
    (admin as unknown as { rpc: unknown }).rpc = (nome: string, args: Linha) =>
      Promise.resolve(
        nome === "fn_conversation_assign" && args.p_conversation_id === "c1"
          ? { data: [], error: null }
          : { data: null, error: { message: "boom" } },
      );
    const r = await executar(admin, pedidoTodas(ANA));
    expect(r.desfecho).toEqual({ ok: false, erro: "sem_conversa" });
  });

  it("pessoa recusada pelo banco no meio do laço: para tudo, a próxima não é tentada", async () => {
    const { admin, tabelas, rpcs } = criarBanco(
      tabelasBase([
        conversa({ id: "c1", last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "c2", last_message_at: "2026-11-13T10:00:00Z", ...CALADA }),
        conversa({ id: "c3", last_message_at: "2026-11-12T10:00:00Z", ...CALADA }),
      ]),
    );
    const troca = admin.rpc.bind(admin) as (nome: string, args: Linha) => unknown;
    (admin as unknown as { rpc: unknown }).rpc = (nome: string, args: Linha) => {
      if (nome === "fn_conversation_assign" && args.p_conversation_id === "c2") {
        rpcs.push({ nome, args });
        return Promise.resolve({ data: null, error: { message: "assignee_not_eligible_member" } });
      }
      return troca(nome, args);
    };
    const r = await executar(admin, pedidoTodas(ANA));
    expect(r.desfecho).toEqual({ ok: true });
    expect(dono(tabelas)).toEqual({ c1: ANA, c2: null, c3: null });
    expect(rpcs.filter((x) => x.nome === "fn_conversation_assign").map((x) => x.args.p_conversation_id)).toEqual([
      "c1",
      "c2",
    ]);
    expect(r.detalhes?.[0]).toMatchObject({ conversas: 1, falhas: 1 });
  });

  it("IA no comando: a principal é atribuída mesmo assim; das demais, só as que a IA não atende", async () => {
    const { admin, tabelas } = criarBanco(
      tabelasBase([
        // Principal (a do canal do gatilho), com a IA atendendo: atribuída sempre.
        conversa({ id: "principal-ia", channel_session_id: CANAL_GATILHO, last_message_at: "2026-11-10T10:00:00Z" }),
        // Demais com a IA no comando (sem dono e sem silêncio vigente): ficam com a IA.
        conversa({ id: "ia", channel_session_id: OUTRO_CANAL, last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "silencio-vencido", bot_silenced_until: "2026-01-01T00:00:00Z", last_message_at: "2026-11-13T10:00:00Z" }),
        conversa({ id: "menos-infinito", bot_silenced_until: "-infinity", last_message_at: "2026-11-12T10:00:00Z" }),
        // Demais em que a IA NÃO está no comando: entram.
        conversa({ id: "calada", ...CALADA, last_message_at: "2026-11-11T10:00:00Z" }),
        conversa({ id: "silencio-futuro", bot_silenced_until: "2999-01-01T00:00:00Z", last_message_at: "2026-11-09T10:00:00Z" }),
        conversa({ id: "de-outra-pessoa", assigned_to_user_id: VISUALIZADOR, last_message_at: "2026-11-08T10:00:00Z" }),
      ]),
    );
    const r = await executar(admin, pedidoTodas(ANA, { gatilho: { channel_session_id: CANAL_GATILHO } }));
    expect(r.desfecho).toEqual({ ok: true });
    expect(dono(tabelas)).toEqual({
      "principal-ia": ANA,
      ia: null,
      "silencio-vencido": null,
      "menos-infinito": null,
      calada: ANA,
      "silencio-futuro": ANA,
      "de-outra-pessoa": ANA,
    });
    expect(r.detalhes?.[0]).toMatchObject({ conversation_id: "principal-ia", conversas: 4, puladas_ia: 3 });
  });

  it("contato travado (force_human) ou descadastrado tira a IA do comando: as demais dele entram", async () => {
    for (const trava of ["force_human", "is_blocked"] as const) {
      const base = tabelasBase([
        conversa({ id: "c1", last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "c2", last_message_at: "2026-11-13T10:00:00Z" }),
      ]);
      base.contacts![0]![trava] = true;
      const { admin, tabelas } = criarBanco(base);
      const r = await executar(admin, pedidoTodas(ANA));
      expect(dono(tabelas), trava).toEqual({ c1: ANA, c2: ANA });
      expect(r.detalhes?.[0], trava).toMatchObject({ conversas: 2, puladas_ia: 0 });
    }
  });

  it("conversa que já é da pessoa não é tocada (nem a principal), e a ação segue sendo sucesso", async () => {
    const tudoDela = criarBanco(
      tabelasBase([
        conversa({ id: "c1", assigned_to_user_id: ANA, last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "c2", assigned_to_user_id: ANA, last_message_at: "2026-11-13T10:00:00Z" }),
      ]),
    );
    const r = await executar(tudoDela.admin, pedidoTodas(ANA));
    expect(r.desfecho).toEqual({ ok: true });
    expect(tudoDela.rpcs.some((x) => x.nome === "fn_conversation_assign" || x.nome === "emit_event")).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
    expect(comandoMock).not.toHaveBeenCalled();
    expect(r.detalhes?.[0]).toMatchObject({ conversation_id: "c1", conversas: 0, ja_eram_dela: 2 });

    const misto = criarBanco(
      tabelasBase([
        conversa({ id: "principal-dela", assigned_to_user_id: ANA, last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "outra", ...CALADA, last_message_at: "2026-11-13T10:00:00Z" }),
      ]),
    );
    const r2 = await executar(misto.admin, pedidoTodas(ANA));
    expect(misto.rpcs.filter((x) => x.nome === "fn_conversation_assign").map((x) => x.args.p_conversation_id)).toEqual([
      "outra",
    ]);
    expect(r2.detalhes?.[0]).toMatchObject({ conversation_id: "outra", conversas: 1, ja_eram_dela: 1 });
  });

  it("sem `todas`, a conversa que já é da pessoa continua sendo reatribuída (comportamento de sempre)", async () => {
    const { rpcs, admin } = criarBanco(tabelasBase([conversa({ id: "c1", assigned_to_user_id: ANA })]));
    expect((await executar(admin, pedido(ANA))).desfecho).toEqual({ ok: true });
    expect(rpcs.filter((x) => x.nome === "fn_conversation_assign")).toHaveLength(1);
  });

  it("o negócio é sincronizado uma vez por contato DISTINTO: o lead e o gêmeo, cada um o seu", async () => {
    const GEMEO = "20000000-0000-4000-8000-000000000009";
    const comGemeo = (conversas: Linha[]) => {
      const base = tabelasBase(conversas);
      base.contacts![0]!.phone_number = "+5532984793302";
      base.contacts!.push({ id: GEMEO, organization_id: ORG, phone_number: "+553284793302", is_merged_into: null, is_personal: false });
      base.crm_leads = [
        { id: "L1", organization_id: ORG, contact_id: CONTATO, status: "open", owner_user_id: null, owner_agent_id: null },
        { id: "L2", organization_id: ORG, contact_id: GEMEO, status: "open", owner_user_id: null, owner_agent_id: null },
      ];
      return base;
    };
    const uma = criarBanco(comGemeo([conversa({ id: "c1" })]));
    await executar(uma.admin, pedido(ANA));
    const porContato = leituras(uma.lidas, "crm_leads");
    auditMock.mockReset();

    const tres = criarBanco(
      comGemeo([
        conversa({ id: "c1", last_message_at: "2026-11-14T10:00:00Z" }),
        conversa({ id: "c2", last_message_at: "2026-11-13T10:00:00Z", ...CALADA }),
        conversa({ id: "c-gemeo", contact_id: GEMEO, last_message_at: "2026-11-12T10:00:00Z", ...CALADA }),
      ]),
    );
    const r = await executar(tres.admin, pedidoTodas(ANA));
    expect(r.detalhes?.[0]).toMatchObject({ conversas: 3 });
    expect(tres.tabelas.crm_leads!.map((l) => [l.id, l.owner_user_id])).toEqual([
      ["L1", ANA],
      ["L2", ANA],
    ]);
    // Dois contatos distintos = duas sincronias; a segunda conversa do lead não vai ao negócio.
    expect(leituras(tres.lidas, "crm_leads")).toBe(2 * porContato);
    const metas = auditMock.mock.calls.map((c) => c[0].metadata as Record<string, unknown>);
    expect(metas.map((m) => [m.negocio_aberto, m.negocio_id])).toEqual([
      ["sincronizado", "L1"],
      ["sincronizado", "L1"],
      ["sincronizado", "L2"],
    ]);
  });

  it("mais de 20 conversas: atribui 20 e sinaliza `truncado`; com 20 exatas, não", async () => {
    const muitas = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        conversa({ id: `c${String(i).padStart(2, "0")}`, last_message_at: `2026-11-${String(28 - i).padStart(2, "0")}T10:00:00Z`, ...CALADA }),
      );
    const cheio = criarBanco(tabelasBase(muitas(22)));
    const r = await executar(cheio.admin, pedidoTodas(ANA));
    expect(cheio.rpcs.filter((x) => x.nome === "fn_conversation_assign")).toHaveLength(20);
    expect(r.detalhes?.[0]).toMatchObject({ conversas: 20, truncado: true });
    expect(dono(cheio.tabelas)).toMatchObject({ c20: null, c21: null });

    const exato = criarBanco(tabelasBase(muitas(20)));
    const r2 = await executar(exato.admin, pedidoTodas(ANA));
    expect(r2.detalhes?.[0]).toMatchObject({ conversas: 20 });
    expect(r2.detalhes?.[0]).not.toHaveProperty("truncado");
  });

  it("contato pessoal e contato sem conversa continuam sendo erro, também com `todas`", async () => {
    const pessoal = tabelasBase([conversa({ id: "c1" })]);
    pessoal.contacts![0]!.is_personal = true;
    const a = criarBanco(pessoal);
    expect((await executar(a.admin, pedidoTodas(ANA))).desfecho).toEqual({ ok: false, erro: "contato_pessoal" });
    const b = criarBanco(tabelasBase([]));
    expect((await executar(b.admin, pedidoTodas(ANA))).desfecho).toEqual({ ok: false, erro: "sem_conversa" });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("pessoa que não é atendente da organização barra antes de qualquer troca, também com `todas`", async () => {
    const { admin, rpcs } = criarBanco(tabelasBase([conversa({ id: "c1" }), conversa({ id: "c2" })]));
    const r = await executar(admin, pedidoTodas(VISUALIZADOR));
    expect(r.desfecho).toEqual({ ok: false, erro: "usuario_invalido" });
    expect(rpcs.some((x) => x.nome === "fn_conversation_assign")).toBe(false);
  });
});
