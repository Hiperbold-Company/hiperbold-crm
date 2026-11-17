/**
 * As rotas da mensagem agendada (migration 1017), atravessando o handler DE
 * VERDADE com a biblioteca real no meio. Dublês só nas bordas: a sessão
 * (`requireRole`), o banco (em memória, que aplica os filtros) e o audit.
 *
 *   - tenant: a organização vem da sessão; a linha de outra organização é 404,
 *     e o corpo não escolhe organização;
 *   - papel: viewer não agenda (403); atendente não mexe na agendada do colega;
 *     gerente mexe;
 *   - estado visto: editar com `updated_at` velho, ou depois de o worker
 *     reservar, é 409 e nada muda.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type Linha } from "@/tests/helpers/banco-em-memoria";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";
import { requireRole } from "@/lib/auth/require-role";
import { MAX_PENDENTES_POR_CONVERSA, MAX_PENDENTES_POR_USUARIO } from "@/lib/mensagens-agendadas/regras";
import { MENSAGEM_LIMITE_DA_CONVERSA, MENSAGEM_LIMITE_DO_USUARIO } from "@/lib/mensagens-agendadas/servidor";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
let sessao: ReturnType<typeof criarBancoEmMemoria>;
let servico: ReturnType<typeof criarBancoEmMemoria>;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessao }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => servico }));

import { POST } from "@/app/api/v1/conversations/[id]/scheduled-messages/route";
import { DELETE, PATCH } from "@/app/api/v1/scheduled-messages/[id]/route";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const ANA = "aaaaaaaa-1111-4000-8000-000000000001";
const BETO = "aaaaaaaa-1111-4000-8000-000000000002";
const CANAL = "aaaaaaaa-2222-4000-8000-000000000001";
const CONV_A = "aaaaaaaa-4444-4000-8000-000000000001";
const CONV_B = "bbbbbbbb-4444-4000-8000-000000000002";
const SM_A = "aaaaaaaa-5555-4000-8000-000000000001";
const SM_B = "bbbbbbbb-5555-4000-8000-000000000002";
const VISTO = "2026-11-17T10:00:00.000Z";

function sessaoComo(userId: string, role: string, org = ORG_A) {
  const user = { id: userId, email: "x@y.z", full_name: null, avatar_url: null, is_platform_admin: false, idioma: "pt-BR", organizations: [] } as unknown as AuthUser;
  const ativa = { orgId: org, name: "Org", role } as ActiveOrg;
  vi.mocked(requireRole).mockImplementation(async (min) => {
    const rank: Record<string, number> = { viewer: 1, agent: 2, manager: 3, admin: 4 };
    if ((rank[role] ?? 0) < (rank[min] ?? 0)) {
      const { fail } = await import("@/lib/api/wrappers");
      return { ok: false, response: fail("forbidden", "Sem permissão.", 403) };
    }
    return { ok: true, user, org: ativa };
  });
}

function linhaAgendada(id: string, org: string, conv: string, extra: Linha = {}): Linha {
  return {
    id, organization_id: org, conversation_id: conv, contact_id: null, channel_session_id: CANAL, created_by: ANA,
    body: "texto", template: null, send_at: "2026-11-17T15:00:00.000Z", status: "agendada", motivo: null,
    message_id: null, adiada_ate: null, reservada_em: null, concluida_em: null, created_at: VISTO, updated_at: VISTO, ...extra,
  };
}

function modeloNoEspelho(name: string, status: string): Linha {
  return {
    id: `tpl-${name}`,
    organization_id: ORG_A,
    name,
    language: "pt_BR",
    status,
    components: [{ type: "BODY", text: "Oi {{1}}, a definição guardada." }],
    channel_session_id: null,
    waba_id: "WABA-A",
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  // A sessão de A só enxerga a conversa de A (a RLS de `conversations`).
  sessao = criarBancoEmMemoria({
    conversations: [{ id: CONV_A, organization_id: ORG_A, contact_id: null, channel_session_id: CANAL, last_inbound_at: "2026-11-17T11:00:00Z" }],
  });
  servico = criarBancoEmMemoria({
    channel_sessions: [{ id: CANAL, organization_id: ORG_A, provider: "meta_cloud", meta_waba_id: "WABA-A" }],
    meta_templates: [
      modeloNoEspelho("retomada", "APPROVED"),
      modeloNoEspelho("em_revisao", "PENDING"),
      { ...modeloNoEspelho("de_outra_conta", "APPROVED"), waba_id: "WABA-OUTRA" },
    ],
    scheduled_messages: [linhaAgendada(SM_A, ORG_A, CONV_A), linhaAgendada(SM_B, ORG_B, CONV_B)],
    idempotency_keys: [],
  });
});

const req = (metodo: string, corpo?: unknown) =>
  new NextRequest("http://x/api", { method: metodo, body: corpo === undefined ? undefined : JSON.stringify(corpo), headers: { "content-type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const sm = (id: string) => servico.tabelas.scheduled_messages!.find((l) => l.id === id)!;

describe("POST /conversations/:id/scheduled-messages", () => {
  it("atendente agenda na própria organização; a organização é a da sessão, não a do corpo", async () => {
    sessaoComo(ANA, "agent");
    const res = await POST(req("POST", { body: "Oi", send_at: "2026-11-17T14:00:00Z", organization_id: ORG_B }), params(CONV_A));
    expect(res.status).toBe(201);
    const nova = servico.tabelas.scheduled_messages!.at(-1)!;
    expect(nova).toMatchObject({ organization_id: ORG_A, conversation_id: CONV_A, created_by: ANA, status: "agendada" });
  });

  it("viewer não agenda (403)", async () => {
    sessaoComo(ANA, "viewer");
    const res = await POST(req("POST", { body: "Oi", send_at: "2026-11-17T14:00:00Z" }), params(CONV_A));
    expect(res.status).toBe(403);
  });

  it("conversa de outra organização é 404", async () => {
    sessaoComo(ANA, "agent");
    const res = await POST(req("POST", { body: "Oi", send_at: "2026-11-17T14:00:00Z" }), params(CONV_B));
    expect(res.status).toBe(404);
  });

  it("janela de 24h fechada no horário sem modelo é 422 modelo_obrigatorio", async () => {
    sessaoComo(ANA, "agent");
    const res = await POST(req("POST", { body: "Oi", send_at: "2026-11-18T14:00:00Z" }), params(CONV_A));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("modelo_obrigatorio");
  });
});

describe("PATCH e DELETE /scheduled-messages/:id", () => {
  it("quem agendou edita com o estado visto", async () => {
    sessaoComo(ANA, "agent");
    const res = await PATCH(req("PATCH", { expected_updated_at: VISTO, body: "novo" }), params(SM_A));
    expect(res.status).toBe(200);
    expect(sm(SM_A).body).toBe("novo");
  });

  it("estado visto velho é 409 e nada muda", async () => {
    sessaoComo(ANA, "agent");
    const res = await PATCH(req("PATCH", { expected_updated_at: "2026-11-17T09:00:00.000Z", body: "novo" }), params(SM_A));
    expect(res.status).toBe(409);
    expect(sm(SM_A).body).toBe("texto");
  });

  it("depois de o worker reservar (enviando), editar e cancelar são 409", async () => {
    sm(SM_A).status = "enviando";
    sessaoComo(ANA, "agent");
    expect((await PATCH(req("PATCH", { expected_updated_at: VISTO, body: "novo" }), params(SM_A))).status).toBe(409);
    expect((await DELETE(req("DELETE"), params(SM_A))).status).toBe(409);
    expect(sm(SM_A)).toMatchObject({ status: "enviando", body: "texto" });
  });

  it("outro atendente não mexe na agendada do colega (403); gerente cancela", async () => {
    sessaoComo(BETO, "agent");
    expect((await DELETE(req("DELETE"), params(SM_A))).status).toBe(403);
    expect(sm(SM_A).status).toBe("agendada");
    sessaoComo(BETO, "manager");
    expect((await DELETE(req("DELETE"), params(SM_A))).status).toBe(200);
    expect(sm(SM_A).status).toBe("cancelada");
  });

  it("agendada de outra organização é 404, e não muda", async () => {
    sessaoComo(ANA, "admin");
    expect((await DELETE(req("DELETE"), params(SM_B))).status).toBe(404);
    expect(sm(SM_B).status).toBe("agendada");
  });
});

describe("o modelo da agendada é o aprovado da conexão da conversa", () => {
  const amanha = "2026-11-18T14:00:00Z"; // janela de 24h fechada: exige modelo
  const escolhido = (name: string) => ({ name, language: "pt_BR", values: { "body:1": "Ana" }, body: "texto do navegador" });

  it("aprovado na WABA da conexão: grava, e o texto sai da definição guardada, não do navegador", async () => {
    sessaoComo(ANA, "agent");
    const res = await POST(req("POST", { body: "Oi", send_at: amanha, template: escolhido("retomada") }), params(CONV_A));
    expect(res.status).toBe(201);
    expect(servico.tabelas.scheduled_messages!.at(-1)!.template).toEqual({
      name: "retomada",
      language: "pt_BR",
      values: { "body:1": "Ana" },
      body: "Oi {{1}}, a definição guardada.",
    });
  });

  it("em revisão, de outra conta ou inexistente: 422 modelo_nao_aprovado e nada é gravado", async () => {
    sessaoComo(ANA, "agent");
    const antes = servico.tabelas.scheduled_messages!.length;
    for (const nome of ["em_revisao", "de_outra_conta", "nao_existe"]) {
      const res = await POST(req("POST", { body: "Oi", send_at: amanha, template: escolhido(nome) }), params(CONV_A));
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("modelo_nao_aprovado");
    }
    expect(servico.tabelas.scheduled_messages!).toHaveLength(antes);
  });

  it("editar para um modelo não aprovado é 422; para o aprovado grava o texto da definição", async () => {
    sessaoComo(ANA, "agent");
    const recusa = await PATCH(req("PATCH", { expected_updated_at: VISTO, template: escolhido("em_revisao") }), params(SM_A));
    expect(recusa.status).toBe(422);
    expect(sm(SM_A).template).toBeNull();
    const aceita = await PATCH(req("PATCH", { expected_updated_at: VISTO, template: escolhido("retomada") }), params(SM_A));
    expect(aceita.status).toBe(200);
    expect(sm(SM_A).template).toMatchObject({ name: "retomada", body: "Oi {{1}}, a definição guardada." });
  });
});

describe("tetos de agendadas pendentes", () => {
  const pendentes = (n: number, extra: (i: number) => Linha) =>
    Array.from({ length: n }, (_, i) => linhaAgendada(`aaaaaaaa-6666-4000-8000-${String(i).padStart(12, "0")}`, ORG_A, CONV_A, extra(i)));

  it(`a conversa com ${MAX_PENDENTES_POR_CONVERSA} pendentes recusa a próxima com 422; cancelada e enviada não contam`, async () => {
    sessaoComo(ANA, "agent");
    expect(MENSAGEM_LIMITE_DA_CONVERSA).toContain(String(MAX_PENDENTES_POR_CONVERSA));
    // SM_A já é uma pendente desta conversa; +18 agendadas +1 enviando = 20.
    servico.tabelas.scheduled_messages!.push(
      ...pendentes(19, (i) => ({ created_by: BETO, status: i === 0 ? "enviando" : "agendada" })),
      ...pendentes(5, () => ({ created_by: BETO, status: "cancelada" })).map((l, i) => ({ ...l, id: `c-${i}` })),
    );
    const res = await POST(req("POST", { body: "Oi", send_at: "2026-11-17T14:00:00Z" }), params(CONV_A));
    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("limite_da_conversa");
    expect(corpo.error.message).toBe(MENSAGEM_LIMITE_DA_CONVERSA);

    // Uma sai da conta (cancelada): cabe de novo.
    sm(SM_A).status = "cancelada";
    expect((await POST(req("POST", { body: "Oi", send_at: "2026-11-17T14:00:00Z" }), params(CONV_A))).status).toBe(201);
  });

  it(`quem já tem ${MAX_PENDENTES_POR_USUARIO} pendentes na organização não agenda mais (422)`, async () => {
    sessaoComo(ANA, "agent");
    expect(MENSAGEM_LIMITE_DO_USUARIO).toContain(String(MAX_PENDENTES_POR_USUARIO));
    // Espalhadas por outras conversas, para o teto da conversa não decidir.
    servico.tabelas.scheduled_messages!.push(
      ...pendentes(MAX_PENDENTES_POR_USUARIO - 1, (i) => ({ conversation_id: `conv-${i}` })),
    );
    const res = await POST(req("POST", { body: "Oi", send_at: "2026-11-17T14:00:00Z" }), params(CONV_A));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("limite_do_usuario");

    // O teto é por pessoa: o colega da mesma organização ainda agenda.
    sessaoComo(BETO, "agent");
    expect((await POST(req("POST", { body: "Oi", send_at: "2026-11-17T14:00:00Z" }), params(CONV_A))).status).toBe(201);
  });
});
