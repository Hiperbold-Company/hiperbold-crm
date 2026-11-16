import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria, type Linha } from "../helpers/banco-em-memoria";

/**
 * Reconectar uma conexão que já existe (o aparelho saiu): QR novo na MESMA instância.
 *
 * O servidor de instâncias é um dublê de `fetch` que responde pela rota; o banco é o de memória com a
 * semântica de filtro do PostgREST. O que se prova é o COMPORTAMENTO: o QR é pedido com o token da
 * própria instância (nunca o de administrador), QR expirado NÃO apaga nem arquiva nada, nenhuma
 * instância é criada, a organização errada não enxerga a conexão, a conclusão grava `WORKING` uma vez
 * só, confere a volta das mensagens, fecha o aviso de conexão caída e sinaliza número diferente.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("@/lib/automation/outbound-url", () => ({ assertSafeOutboundUrl: () => undefined }));
vi.mock("@/lib/automation/outbound-ip", () => ({ assertDestinoResolvidoSeguro: async () => undefined }));
vi.mock("@/lib/env", () => ({ env: { IA_DESTINOS_INTERNOS_PERMITIDOS: "" } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
// O e-mail de "voltou" é efeito externo (Resend); aqui só importa que o aviso da Central fecha.
const avisoPorEmail = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/channels/aviso-por-email", () => ({ avisarConexaoPorEmail: avisoPorEmail }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async (_a: unknown, texto: string) => `\\xenc(${texto})`,
  decryptWebhookSecret: async (_a: unknown, cifrado: string) => {
    const m = /^\\xenc\((.*)\)$/.exec(cifrado);
    return m ? m[1]! : null;
  },
}));

import { iniciarReconexao, verificarReconexao } from "@/lib/channels/reconexao";

const SERVIDOR = "https://cliente.exemplo.com";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const TOKEN = "tok-instancia-abc";
const QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const URL_DO_WEBHOOK = (p: string) => `https://crm.exemplo.com/api/v1/webhooks/channel/${p}`;

function resposta(status: number, json: unknown = {}) {
  return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

/** O que `GET /instance/status` responde. */
let estadoNoServidor: Record<string, unknown>;
let respostaDoConnect: () => Response;

type Chamada = { url: string; metodo: string; cabecalhos: Record<string, string>; corpo: Record<string, unknown> | null };
const chamadas = (): Chamada[] =>
  fetchMock.mock.calls.map(([url, init]) => {
    const i = init as { method?: string; headers?: Record<string, string>; body?: string };
    return {
      url: String(url).replace(SERVIDOR, ""),
      metodo: i.method ?? "GET",
      cabecalhos: i.headers ?? {},
      corpo: i.body ? JSON.parse(i.body) : null,
    };
  });
const so = (metodo: string, url: string) => chamadas().filter((c) => c.metodo === metodo && c.url === url);

function instalarServidor() {
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = String(input).replace(SERVIDOR, "");
    const metodo = init?.method ?? "GET";
    if (metodo === "GET" && url === "/instance/status") return resposta(200, { instance: { id: "inst-1", ...estadoNoServidor } });
    if (metodo === "POST" && url === "/instance/connect") return respostaDoConnect();
    if (url === "/webhook" && metodo === "GET") return resposta(200, []);
    if (url === "/webhook" && metodo === "POST") {
      return resposta(200, [{ id: "wh-1", url: (JSON.parse(String(init?.body)) as { url: string }).url }]);
    }
    throw new Error(`rota não prevista: ${metodo} ${url}`);
  });
}

let banco: BancoEmMemoria;
let falharAoEscrever: ((patch: Linha) => { message: string; code?: string } | null) | null;

function conexaoCaida(extra: Linha = {}): Linha {
  return {
    id: ID,
    organization_id: ORG_A,
    provider: "uazapi",
    status: "SCAN_QR_CODE",
    display_name: "Comercial",
    phone_number: "+5511988887777",
    uazapi_base_url: SERVIDOR,
    uazapi_instance_id: "inst-1",
    uazapi_token_encrypted: `\\xenc(${TOKEN})`,
    webhook_path_token: "tokendecaminho",
    archived_at: null,
    pareamento_qr_estado: null,
    metadata: { ai_gate: "allowlist" },
    ...extra,
  };
}

function novoBanco(linhas: Linha[], extra: Record<string, Linha[]> = {}) {
  falharAoEscrever = null;
  banco = criarBancoEmMemoria(
    { channel_sessions: linhas, channel_session_health: [], agent_inbox_items: [], ...extra },
    {
      aoEscrever: {
        channel_sessions: (modo, _l, patch) => (modo === "update" && patch && falharAoEscrever ? falharAoEscrever(patch) : null),
      },
    },
  );
}
const admin = () => banco as unknown as Parameters<typeof iniciarReconexao>[0];
const linha = () => banco.tabelas.channel_sessions!.find((l) => l.id === ID)!;

beforeEach(() => {
  fetchMock.mockReset();
  avisoPorEmail.mockClear();
  estadoNoServidor = { status: "disconnected", qrcode: "", owner: "5511988887777", profileName: "Loja" };
  respostaDoConnect = () => resposta(200, { instance: { status: "connecting", qrcode: QR } });
  instalarServidor();
  novoBanco([conexaoCaida()]);
});

describe("gerar o QR", () => {
  it("pede o QR na MESMA instância, com o token dela e nunca o de administrador; não cria nem apaga nada", async () => {
    const antes = structuredClone(linha());
    const r = await iniciarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });

    expect(r).toEqual({ id: ID, estado: "aguardando", qr: QR, codigo: null });
    const connect = so("POST", "/instance/connect");
    expect(connect).toHaveLength(1);
    expect(connect[0]!.cabecalhos.token).toBe(TOKEN);
    expect(connect[0]!.corpo).toEqual({});
    expect(chamadas().some((c) => c.cabecalhos.admintoken !== undefined)).toBe(false);
    expect(chamadas().some((c) => c.metodo === "DELETE" || c.url === "/instance/create")).toBe(false);
    // Pedir o QR não muda a linha.
    expect(linha()).toEqual(antes);
  });

  it("com o número, pede o código de pareamento (só dígitos) e o devolve", async () => {
    respostaDoConnect = () => resposta(200, { instance: { status: "connecting", paircode: "ABCD-1234" } });
    const r = await iniciarReconexao(admin(), {
      organizationId: ORG_A,
      id: ID,
      telefone: "+55 (11) 98888-7777",
      urlDoWebhook: URL_DO_WEBHOOK,
    });
    expect(r).toMatchObject({ estado: "aguardando", codigo: "ABCD-1234" });
    expect(so("POST", "/instance/connect")[0]!.corpo).toEqual({ phone: "5511988887777" });
  });

  it("número inválido: 422 sem falar com o servidor", async () => {
    const r = await iniciarReconexao(admin(), { organizationId: ORG_A, id: ID, telefone: "123", urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("o servidor recusa: 502 com frase fixa, e a linha fica como estava", async () => {
    respostaDoConnect = () => resposta(500, { error: "detalhe interno do servidor" });
    const antes = structuredClone(linha());
    const r = await iniciarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ ok: false, status: 502, codigo: "upstream_unavailable" });
    expect(JSON.stringify(r)).not.toContain("detalhe interno");
    expect(linha()).toEqual(antes);
  });

  it("sem saber o estado (o /status falhou): 502 e NÃO pede conexão — falha fechado", async () => {
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input).replace(SERVIDOR, "");
      if ((init?.method ?? "GET") === "GET" && url === "/instance/status") return resposta(500, {});
      if (url === "/instance/connect") return respostaDoConnect();
      throw new Error(`rota não prevista: ${url}`);
    });
    const antes = structuredClone(linha());
    const r = await iniciarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ ok: false, status: 502, codigo: "upstream_unavailable" });
    expect(so("POST", "/instance/connect")).toHaveLength(0);
    expect(linha()).toEqual(antes);

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("rede"));
    const porRede = await iniciarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(porRede).toMatchObject({ ok: false, status: 502 });
    expect(so("POST", "/instance/connect")).toHaveLength(0);
  });

  it("o número já voltou sozinho: conclui sem pedir QR", async () => {
    estadoNoServidor = { status: "connected", owner: "5511988887777", profileName: "Loja" };
    const r = await iniciarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ estado: "conectado", concluiuAgora: true, numeroMudou: false });
    expect(so("POST", "/instance/connect")).toHaveLength(0);
    expect(linha().status).toBe("WORKING");
  });
});

describe("a conexão é só da organização da sessão", () => {
  it.each([
    ["id de outra organização", () => novoBanco([conexaoCaida({ organization_id: ORG_B })])],
    ["conexão arquivada", () => novoBanco([conexaoCaida({ archived_at: "2026-11-01T00:00:00Z" })])],
    ["pareamento novo ainda pendente (é do outro fluxo)", () => novoBanco([conexaoCaida({ pareamento_qr_estado: "pendente" })])],
    ["conexão de outro canal", () => novoBanco([conexaoCaida({ provider: "meta_cloud" })])],
    ["id que não existe", () => novoBanco([])],
  ])("%s: 404 nas duas pontas, sem tocar o servidor", async (_nome, preparar) => {
    preparar();
    const a = await iniciarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    const b = await verificarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(a).toMatchObject({ ok: false, status: 404, codigo: "not_found" });
    expect(b).toMatchObject({ ok: false, status: 404, codigo: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sem token guardado: 409 que explica, sem tocar o servidor", async () => {
    novoBanco([conexaoCaida({ uazapi_token_encrypted: null })]);
    const r = await iniciarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ ok: false, status: 409, codigo: "state_conflict" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("verificar", () => {
  it("aguardando: devolve o QR atualizado e não escreve nada", async () => {
    estadoNoServidor = { status: "connecting", qrcode: QR, owner: "" };
    const antes = structuredClone(linha());
    const r = await verificarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toEqual({ id: ID, estado: "aguardando", qr: QR, codigo: null });
    expect(linha()).toEqual(antes);
  });

  it("expirado: NÃO apaga a instância nem arquiva a linha; nada muda", async () => {
    estadoNoServidor = { status: "disconnected", qrcode: "", owner: "" };
    const antes = structuredClone(linha());
    const r = await verificarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toEqual({ id: ID, estado: "expirado", qr: null, codigo: null });
    expect(chamadas().some((c) => c.metodo === "DELETE")).toBe(false);
    expect(chamadas().map((c) => `${c.metodo} ${c.url}`)).toEqual(["GET /instance/status"]);
    expect(linha()).toEqual(antes);
    expect(linha().archived_at).toBeNull();
  });

  it("conectou: grava WORKING uma vez só, mantém o apelido, liga a volta e a repetição não conclui de novo", async () => {
    estadoNoServidor = { status: "connected", owner: "5511988887777", profileName: "Perfil do WhatsApp" };
    const r = await verificarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });

    expect(r).toMatchObject({
      estado: "conectado",
      concluiuAgora: true,
      numeroMudou: false,
      conexao: { id: ID, displayName: "Comercial", phoneNumber: "+5511988887777", status: "WORKING" },
      webhook: { registrado: true, aviso: null },
    });
    expect(linha()).toMatchObject({ status: "WORKING", display_name: "Comercial", phone_number: "+5511988887777", archived_at: null });
    expect((linha().metadata as Record<string, unknown>).uazapi_webhook_id).toBe("wh-1");
    // O resto do metadata (acesso da IA) continua.
    expect((linha().metadata as Record<string, unknown>).ai_gate).toBe("allowlist");
    const registro = so("POST", "/webhook");
    expect(registro).toHaveLength(1);
    expect(registro[0]!.corpo).toMatchObject({ action: "add", url: URL_DO_WEBHOOK("tokendecaminho") });

    const repeticao = await verificarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(repeticao).toMatchObject({ estado: "conectado", concluiuAgora: false });
  });

  it("sem apelido, o nome do perfil entra no lugar", async () => {
    novoBanco([conexaoCaida({ display_name: null })]);
    estadoNoServidor = { status: "connected", owner: "5511988887777", profileName: "Loja da Ana" };
    await verificarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(linha().display_name).toBe("Loja da Ana");
  });

  it("sem endereço público: conclui e avisa que a volta não foi ligada, sem registrar webhook", async () => {
    estadoNoServidor = { status: "connected", owner: "5511988887777" };
    const r = await verificarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: null });
    expect(r).toMatchObject({ estado: "conectado", webhook: { registrado: false } });
    expect((r as { webhook: { aviso: string | null } }).webhook.aviso).toBeTruthy();
    expect(so("POST", "/webhook")).toHaveLength(0);
    expect(linha().status).toBe("WORKING");
  });

  it("número diferente do gravado: conclui, grava o novo e sinaliza", async () => {
    estadoNoServidor = { status: "connected", owner: "5521977776666", profileName: "Outro" };
    const r = await verificarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ estado: "conectado", numeroMudou: true, conexao: { phoneNumber: "+5521977776666" } });
    expect(linha().phone_number).toBe("+5521977776666");
  });

  it("fecha o aviso aberto de conexão caída (Central) e o episódio de saúde", async () => {
    novoBanco([conexaoCaida()], {
      channel_session_health: [
        { organization_id: ORG_A, channel_session_id: ID, status: "SCAN_QR_CODE", escalated_status: "PUSH:SCAN_QR_CODE" },
      ],
      agent_inbox_items: [
        { id: "av-1", organization_id: ORG_A, ref_kind: "channel_session", ref_id: ID, status: "open" },
        { id: "av-2", organization_id: ORG_A, ref_kind: "channel_session", ref_id: "outra-conexao", status: "open" },
      ],
    });
    estadoNoServidor = { status: "connected", owner: "5511988887777" };
    await verificarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });

    const avisos = banco.tabelas.agent_inbox_items!;
    expect(avisos.find((a) => a.id === "av-1")!.status).toBe("resolved");
    // O aviso de OUTRA conexão segue aberto.
    expect(avisos.find((a) => a.id === "av-2")!.status).toBe("open");
    // O dublê trata `upsert` como insert: o episódio gravado por último é o que vale.
    expect(banco.tabelas.channel_session_health!.at(-1)!.escalated_status).toBeNull();
  });

  it("o número já está em outra conexão da empresa (23505): 409, e nada é desfeito", async () => {
    estadoNoServidor = { status: "connected", owner: "5521977776666" };
    falharAoEscrever = (patch) => (patch.status === "WORKING" ? { message: "duplicate", code: "23505" } : null);
    const r = await verificarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ ok: false, status: 409, codigo: "state_conflict" });
    expect(chamadas().some((c) => c.metodo === "DELETE")).toBe(false);
    expect(linha().archived_at).toBeNull();
  });

  it("servidor fora: 502 e nada muda", async () => {
    fetchMock.mockRejectedValue(new Error("rede"));
    const antes = structuredClone(linha());
    const r = await verificarReconexao(admin(), { organizationId: ORG_A, id: ID, urlDoWebhook: URL_DO_WEBHOOK });
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(linha()).toEqual(antes);
  });
});
