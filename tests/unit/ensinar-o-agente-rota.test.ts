/**
 * "Usar para ensinar o agente" — a rota `/api/v1/conversations/[id]/usable-for-rag`.
 *
 * O `requireRole` roda DE VERDADE: o papel sai da RPC `fn_user_role_in_org` do
 * banco em memória, como no Postgres. Trocados só a sessão (`loadAuthUser`,
 * `resolveActiveOrg`, `mfaEmDivida`), o portão de suporte e a gravação da
 * auditoria — que é o efeito externo observado.
 *
 * Mede: piso de papel (viewer não marca), organização da SESSÃO (conversa de
 * outra organização é 404 e fica intacta), só conversa encerrada pode ser
 * marcada, marcar duas vezes não muda nada nem audita de novo, e desmarcar uma
 * conversa já indexada não apaga o `ingested` — senão ela seria indexada em
 * dobro se alguém a marcasse outra vez.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { criarBancoEmMemoria, type BancoEmMemoria } from "../helpers/banco-em-memoria";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const USER = "aaaaaaaa-3333-4000-8000-000000000003";
const CONV_A = "aaaaaaaa-1111-4000-8000-000000000001";
const CONV_ABERTA = "aaaaaaaa-1111-4000-8000-000000000002";
const CONV_B = "bbbbbbbb-1111-4000-8000-000000000001";

const estado = vi.hoisted(() => ({
  banco: null as unknown,
  papel: "agent" as string,
  suporteNega: false,
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => estado.banco }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: USER,
    email: "a@x.com",
    idioma: "pt-BR",
    is_platform_admin: false,
    support: null,
    organizations: [],
  }),
  resolveActiveOrg: async () => ({ orgId: ORG_A, name: "A", role: "agent", status: "active" }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: async () =>
    estado.suporteNega
      ? new Response(JSON.stringify({ error: { code: "forbidden", message: "x" } }), { status: 403 })
      : null,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { audit } from "@/lib/audit";
import { GET, POST } from "@/app/api/v1/conversations/[id]/usable-for-rag/route";

let banco: BancoEmMemoria;

function conversa(id: string, org: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: org,
    status,
    usable_for_rag: false,
    usable_for_rag_marked_at: null,
    usable_for_rag_marked_by: null,
    rag_review_status: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(audit).mockClear();
  estado.papel = "agent";
  estado.suporteNega = false;
  banco = criarBancoEmMemoria(
    {
      conversations: [
        conversa(CONV_A, ORG_A, "closed"),
        conversa(CONV_ABERTA, ORG_A, "open"),
        conversa(CONV_B, ORG_B, "closed"),
      ],
    },
    { rpc: { fn_user_role_in_org: () => ({ data: estado.papel }) } },
  );
  estado.banco = banco;
});

function linha(id: string) {
  return banco.tabelas["conversations"]!.find((c) => c["id"] === id)!;
}

async function marcar(id: string, enabled: boolean) {
  const req = new NextRequest(`http://localhost/api/v1/conversations/${id}/usable-for-rag`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const res = await POST(req, { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

describe("rota usable-for-rag — quem pode e onde", () => {
  it("agent marca uma conversa encerrada da própria organização, com auditoria", async () => {
    const r = await marcar(CONV_A, true);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ usable_for_rag: true, pode_marcar: true });
    expect(linha(CONV_A)).toMatchObject({ usable_for_rag: true, usable_for_rag_marked_by: USER });
    expect(typeof linha(CONV_A)["usable_for_rag_marked_at"]).toBe("string");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]![0]).toMatchObject({
      action: "conversation.usable_for_rag_toggled",
      organizationId: ORG_A,
      resourceId: CONV_A,
    });
  });

  it("viewer recebe 403 e a conversa não muda", async () => {
    estado.papel = "viewer";
    const r = await marcar(CONV_A, true);
    expect(r.status).toBe(403);
    expect(linha(CONV_A)["usable_for_rag"]).toBe(false);
  });

  it("conversa de OUTRA organização: 404, intacta, sem auditoria", async () => {
    const r = await marcar(CONV_B, true);
    expect(r.status).toBe(404);
    expect(linha(CONV_B)["usable_for_rag"]).toBe(false);
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "conversation.usable_for_rag_toggled" }),
    );
    const g = await GET(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ id: CONV_B }) });
    expect(g.status).toBe(404);
  });

  it("acompanhamento sem escrita é barrado antes do efeito", async () => {
    estado.suporteNega = true;
    const r = await marcar(CONV_A, true);
    expect(r.status).toBe(403);
    expect(linha(CONV_A)["usable_for_rag"]).toBe(false);
  });

  it("corpo fora do contrato é recusado pelo Zod", async () => {
    const req = new NextRequest(`http://localhost/x`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "sim" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: CONV_A }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(linha(CONV_A)["usable_for_rag"]).toBe(false);
  });
});

describe("rota usable-for-rag — o laço", () => {
  it("conversa ainda aberta não pode ser marcada (409)", async () => {
    const r = await marcar(CONV_ABERTA, true);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("invalid_state");
    expect(linha(CONV_ABERTA)["usable_for_rag"]).toBe(false);
  });

  it("marcar duas vezes: o mesmo estado, a data da 1ª marcação e uma auditoria só", async () => {
    await marcar(CONV_A, true);
    const primeira = linha(CONV_A)["usable_for_rag_marked_at"];
    const r = await marcar(CONV_A, true);
    expect(r.status).toBe(200);
    expect(r.body.data.usable_for_rag).toBe(true);
    expect(linha(CONV_A)["usable_for_rag_marked_at"]).toBe(primeira);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("marcar conversa encerrada há semanas grava a data de AGORA (é por ela que o lote filtra)", async () => {
    linha(CONV_A)["status_changed_at"] = "2026-09-01T10:00:00Z";
    const antes = Date.now();
    await marcar(CONV_A, true);
    const marcada = Date.parse(String(linha(CONV_A)["usable_for_rag_marked_at"]));
    expect(marcada).toBeGreaterThanOrEqual(antes - 1000);
  });

  it("desmarcar conversa já indexada mantém `ingested` — e remarcar não a põe na fila de novo", async () => {
    Object.assign(linha(CONV_A), {
      usable_for_rag: true,
      usable_for_rag_marked_at: "2026-10-20T10:00:00Z",
      rag_review_status: "ingested",
    });
    const r = await marcar(CONV_A, false);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ usable_for_rag: false, rag_review_status: "ingested" });
    expect(linha(CONV_A)["rag_review_status"]).toBe("ingested");

    await marcar(CONV_A, true);
    expect(linha(CONV_A)["rag_review_status"]).toBe("ingested");
  });

  it("desmarcar o que ainda não foi indexado tira da fila", async () => {
    await marcar(CONV_A, true);
    await marcar(CONV_A, false);
    expect(linha(CONV_A)).toMatchObject({
      usable_for_rag: false,
      usable_for_rag_marked_at: null,
      rag_review_status: null,
    });
  });

  it("GET devolve o estado lido do banco", async () => {
    const g = await GET(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ id: CONV_A }) });
    expect(g.status).toBe(200);
    expect((await g.json()).data).toEqual({
      conversation_id: CONV_A,
      usable_for_rag: false,
      usable_for_rag_marked_at: null,
      rag_review_status: null,
      pode_marcar: true,
    });
  });
});
