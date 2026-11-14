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

function criarBanco(tabelas: Record<string, Linha[]>) {
  const rpcs: Array<{ nome: string; args: Linha }> = [];
  const valor = (l: Linha, c: string) => l[c];
  const admin = {
    from(tabela: string) {
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
  return { admin: admin as unknown as SupabaseClient, tabelas, rpcs };
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
});
