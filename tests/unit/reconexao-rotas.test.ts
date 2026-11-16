import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * As rotas da reconexão de uma conexão existente: o que a BORDA faz (guarda de suporte, Zod no path e no
 * corpo, teto de taxa por organização, organização da sessão e nunca a do corpo, audit sem QR nem número).
 * O comportamento da reconexão em si está em `reconexao-de-conexao.test.ts`; aqui o módulo de canais é
 * um dublê, e o limitador de taxa é o de verdade (memória do processo, sem Redis).
 */

const h = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  iniciar: vi.fn(),
  verificar: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.support }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ marca: "admin" }) }));
vi.mock("@/lib/channels/reconexao", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, iniciarReconexao: h.iniciar, verificarReconexao: h.verificar };
});

import * as reconectar from "@/app/api/v1/channels/instancia/[id]/reconectar/route";
import * as verificar from "@/app/api/v1/channels/instancia/[id]/reconectar/verificar/route";
import { LIMITES_DO_PAREAMENTO_QR } from "@/lib/channels/pareamento-qr-limite";

const ID = "11111111-1111-4111-8111-111111111111";
const QR = "data:image/png;base64,AA==";
let contador = 0;
let org = "";

const req = (corpo: unknown = {}) =>
  new Request("http://localhost/x", { method: "POST", body: JSON.stringify(corpo), headers: { "user-agent": "vitest" } });
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });
const chamar = async (f: unknown, ...a: unknown[]) => (await (f as (...x: unknown[]) => Promise<Response>)(...a)) as Response;

const conectado = (concluiuAgora: boolean, numeroMudou = false) => ({
  id: ID,
  estado: "conectado",
  conexao: { id: ID, displayName: "Comercial", phoneNumber: "+5511988887777", status: "WORKING" },
  webhook: { registrado: true, aviso: null },
  numeroMudou,
  concluiuAgora,
});

beforeEach(() => {
  vi.clearAllMocks();
  org = `org-${++contador}-${Math.random().toString(16).slice(2)}`;
  h.role.mockResolvedValue({ ok: true, org: { orgId: org }, user: { id: "u1", idioma: "pt-BR" } });
  h.support.mockResolvedValue(null);
  h.iniciar.mockResolvedValue({ id: ID, estado: "aguardando", qr: QR, codigo: null });
  h.verificar.mockResolvedValue({ id: ID, estado: "aguardando", qr: QR, codigo: null });
});

describe("guardas", () => {
  it("as duas rotas só têm POST", () => {
    expect((reconectar as Record<string, unknown>).GET).toBeUndefined();
    expect((verificar as Record<string, unknown>).GET).toBeUndefined();
    expect(typeof reconectar.POST).toBe("function");
    expect(typeof verificar.POST).toBe("function");
  });

  it.each([
    ["reconectar", () => reconectar.POST],
    ["verificar", () => verificar.POST],
  ])("%s: suporte em modo somente leitura é negado antes de qualquer efeito", async (_n, rota) => {
    h.support.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await chamar(rota(), req(), ctx())).status).toBe(403);
    expect(h.role).not.toHaveBeenCalled();
    expect(h.iniciar).not.toHaveBeenCalled();
    expect(h.verificar).not.toHaveBeenCalled();
  });

  it("o piso é gerente, como a tela de Conexões", async () => {
    await chamar(reconectar.POST, req(), ctx());
    expect(h.role).toHaveBeenCalledWith("manager", expect.anything());
    await chamar(verificar.POST, req(), ctx());
    expect(h.role).toHaveBeenLastCalledWith("manager", expect.anything());
  });

  it.each([
    ["reconectar", () => reconectar.POST],
    ["verificar", () => verificar.POST],
  ])("%s: id que não é uuid é 422, sem chegar à reconexão", async (_n, rota) => {
    expect((await chamar(rota(), req(), ctx("nao-e-uuid"))).status).toBe(422);
    expect(h.iniciar).not.toHaveBeenCalled();
    expect(h.verificar).not.toHaveBeenCalled();
  });

  it("corpo fora do contrato (telefone que não é texto) é 422", async () => {
    expect((await chamar(reconectar.POST, req({ telefone: 123 }), ctx())).status).toBe(422);
    expect(h.iniciar).not.toHaveBeenCalled();
  });

  it("usa a organização da SESSÃO, nunca a do corpo", async () => {
    await chamar(reconectar.POST, req({ organization_id: "outra", telefone: "5511988887777" }), ctx());
    expect(h.iniciar).toHaveBeenCalledWith(
      { marca: "admin" },
      expect.objectContaining({ organizationId: org, id: ID, telefone: "5511988887777" }),
    );
    await chamar(verificar.POST, req({ organization_id: "outra" }), ctx());
    expect(h.verificar).toHaveBeenCalledWith({ marca: "admin" }, expect.objectContaining({ organizationId: org, id: ID }));
  });

  it("a falha da reconexão (ex.: 404 de outra organização) sai com o status dela", async () => {
    h.iniciar.mockResolvedValue({ ok: false, status: 404, codigo: "not_found", reason: "Conexão não encontrada." });
    const r = await chamar(reconectar.POST, req(), ctx());
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("not_found");
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("resposta e audit", () => {
  it("gerar o QR: devolve o QR e audita o começo sem QR, código nem número", async () => {
    const r = await chamar(reconectar.POST, req({ telefone: "5511988887777" }), ctx());
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ id: ID, estado: "aguardando", qr: QR, codigo: null });
    expect(h.audit).toHaveBeenCalledTimes(1);
    const evento = h.audit.mock.calls[0]![0] as Record<string, unknown>;
    expect(evento).toMatchObject({ action: "channel.reconnect_started", organizationId: org, resourceId: ID });
    expect(evento.metadata).toEqual({ via: "reconexao", com_codigo: true });
    expect(JSON.stringify(evento)).not.toContain("5511988887777");
    expect(JSON.stringify(evento)).not.toContain(QR);
  });

  it.each([
    ["só espaços", "   "],
    ["sem dígitos", "abc"],
  ])("telefone %s é QR comum: sem código no pedido, sem cota de código, `com_codigo: false`", async (_n, telefone) => {
    const { max } = LIMITES_DO_PAREAMENTO_QR.reconectar_codigo;
    for (let i = 0; i < max + 2; i++) {
      expect((await chamar(reconectar.POST, req({ telefone }), ctx())).status).toBe(200);
    }
    expect(h.iniciar).toHaveBeenLastCalledWith({ marca: "admin" }, expect.objectContaining({ telefone: null }));
    expect((h.audit.mock.calls[0]![0] as { metadata: unknown }).metadata).toEqual({ via: "reconexao", com_codigo: false });
  });

  it("telefone com máscara vira só dígitos e conta como código", async () => {
    await chamar(reconectar.POST, req({ telefone: "+55 (11) 98888-7777" }), ctx());
    expect(h.iniciar).toHaveBeenCalledWith({ marca: "admin" }, expect.objectContaining({ telefone: "5511988887777" }));
    expect((h.audit.mock.calls[0]![0] as { metadata: unknown }).metadata).toEqual({ via: "reconexao", com_codigo: true });
  });

  it("verificar que conclui: audita `channel.connected` via reconexão uma vez, a repetição não, e devolve numero_mudou", async () => {
    h.verificar.mockResolvedValueOnce(conectado(true, true));
    const r = await chamar(verificar.POST, req(), ctx());
    const corpo = (await r.json()).data;
    expect(corpo).toMatchObject({ estado: "conectado", numero_mudou: true, conexao: { status: "WORKING" } });
    expect(h.audit).toHaveBeenCalledTimes(1);
    const evento = h.audit.mock.calls[0]![0] as Record<string, unknown>;
    expect(evento).toMatchObject({ action: "channel.connected", metadata: expect.objectContaining({ via: "reconexao" }) });
    expect(JSON.stringify(evento)).not.toContain("5511988887777");

    h.audit.mockClear();
    h.role.mockResolvedValue({ ok: true, org: { orgId: `${org}-repeticao` }, user: { id: "u1", idioma: "pt-BR" } });
    h.verificar.mockResolvedValueOnce(conectado(false));
    expect((await chamar(verificar.POST, req(), ctx())).status).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("verificar aguardando ou expirado não audita", async () => {
    h.verificar.mockResolvedValueOnce({ id: ID, estado: "expirado", qr: null, codigo: null });
    const r = await chamar(verificar.POST, req(), ctx());
    expect((await r.json()).data).toEqual({ id: ID, estado: "expirado", qr: null, codigo: null });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("o número já tinha voltado (reconectar responde conectado): audita a conexão, não o começo", async () => {
    h.iniciar.mockResolvedValueOnce(conectado(true));
    await chamar(reconectar.POST, req(), ctx());
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({ action: "channel.connected" });
  });
});

describe("teto de taxa por organização", () => {
  it("reconectar: depois do teto por hora, 429 com Retry-After e nada pedido ao servidor; outra organização segue", async () => {
    const { max } = LIMITES_DO_PAREAMENTO_QR.reconectar;
    for (let i = 0; i < max; i++) expect((await chamar(reconectar.POST, req(), ctx())).status).toBe(200);
    const barrada = await chamar(reconectar.POST, req(), ctx());
    expect(barrada.status).toBe(429);
    expect(barrada.headers.get("retry-after")).toBe("3600");
    expect(h.iniciar).toHaveBeenCalledTimes(max);

    h.role.mockResolvedValue({ ok: true, org: { orgId: `${org}-outra` }, user: { id: "u2", idioma: "pt-BR" } });
    expect((await chamar(reconectar.POST, req(), ctx())).status).toBe(200);
  });

  it("código por telefone tem teto próprio, menor", async () => {
    const { max } = LIMITES_DO_PAREAMENTO_QR.reconectar_codigo;
    for (let i = 0; i < max; i++) {
      expect((await chamar(reconectar.POST, req({ telefone: "5511988887777" }), ctx())).status).toBe(200);
    }
    expect((await chamar(reconectar.POST, req({ telefone: "5511988887777" }), ctx())).status).toBe(429);
    // Sem telefone (QR) ainda passa.
    expect((await chamar(reconectar.POST, req(), ctx())).status).toBe(200);
  });

  it("verificar: 1 por segundo por organização", async () => {
    expect((await chamar(verificar.POST, req(), ctx())).status).toBe(200);
    const barrada = await chamar(verificar.POST, req(), ctx());
    expect(barrada.status).toBe(429);
    expect(barrada.headers.get("retry-after")).toBe("1");
  });
});
