/**
 * Webhook POR SESSÃO no corpo que o cliente manda ao WAHA (servidor HTTP real,
 * corpo lido do fio).
 *
 * - criação com webhook: `config.webhooks` leva a URL e `hmac.key` pedidos;
 * - criação sem webhook: o corpo é o de sempre (sem `webhooks`);
 * - convergência: acrescenta/atualiza a entrada do CRM, preserva as alheias, e
 *   NÃO faz PUT (que reinicia a sessão) quando já está igual;
 * - convergência sem a opção não toca no `webhooks` existente;
 * - chave mascarada no GET: não reinicia a sessão e o PUT leva a chave do banco;
 * - a entrada do CRM é reconhecida pelo sufixo com o token (troca de base).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";
import { EVENTOS_DO_WEBHOOK_DA_SESSAO, WahaClient, entradaDoWebhookDaSessao } from "./client";

type Passo = { method: string; path: string; status: number; body?: unknown };
type Recebido = { method: string; path: string; body: unknown };

const NOME = "org_sessao";
const CAMINHO = `/api/sessions/${NOME}`;
const WEBHOOK = { url: "https://crm.exemplo.com.br/api/v1/webhooks/waha/token-atual", hmacKey: "k".repeat(64) };
const FILTRO = { ignore: { status: true, broadcast: true, channels: true, groups: true } };
const sessao = (status = "STOPPED", config: Record<string, unknown> = FILTRO) =>
  ({ name: NOME, status, config, engine: { engine: "NOWEB" } });

async function servidor(passos: Passo[], rodar: (c: WahaClient) => Promise<void>): Promise<Recebido[]> {
  const recebidos: Recebido[] = [];
  const inesperados: string[] = [];
  const srv = createServer((req, res) => {
    let bruto = "";
    req.on("data", (c) => { bruto += c; });
    req.on("end", () => {
      recebidos.push({ method: req.method!, path: req.url!, body: bruto ? JSON.parse(bruto) : null });
      const p = passos.shift();
      if (!p || p.method !== req.method || p.path !== req.url) {
        inesperados.push(`${req.method} ${req.url}`);
        res.writeHead(500).end();
        return;
      }
      res.writeHead(p.status, { "content-type": "application/json" });
      res.end(JSON.stringify(p.body ?? {}));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await rodar(new WahaClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, "chave-local"));
    expect(inesperados).toEqual([]);
    expect(passos).toEqual([]);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
  return recebidos;
}

describe("createSession: webhook por sessão no corpo", () => {
  it("com webhook, `config.webhooks` leva a URL do token e hmac.key = segredo da sessão", async () => {
    const recebidos = await servidor(
      [{ method: "POST", path: "/api/sessions", status: 201 }, { method: "GET", path: CAMINHO, status: 200, body: sessao() }],
      async (c) => { await c.createSession(NOME, { webhook: WEBHOOK }); },
    );
    const corpo = recebidos[0]!.body as { config: { webhooks: Array<Record<string, unknown>> } };
    expect(corpo.config.webhooks).toHaveLength(1);
    expect(corpo.config.webhooks[0]!).toMatchObject({
      url: WEBHOOK.url,
      hmac: { key: WEBHOOK.hmacKey },
      events: [...EVENTOS_DO_WEBHOOK_DA_SESSAO],
    });
    expect(corpo.config.webhooks[0]!.retries).toMatchObject({ policy: expect.any(String), attempts: expect.any(Number) });
  });

  it("sem webhook, o corpo não leva `webhooks` (comportamento de antes)", async () => {
    const recebidos = await servidor(
      [{ method: "POST", path: "/api/sessions", status: 201 }, { method: "GET", path: CAMINHO, status: 200, body: sessao() }],
      async (c) => { await c.createSession(NOME); },
    );
    const corpo = recebidos[0]!.body as { config: Record<string, unknown> };
    expect(corpo.config).not.toHaveProperty("webhooks");
  });
});

describe("convergirConfigDaSessao: webhook por sessão", () => {
  it("acrescenta a entrada quando falta, preservando webhooks alheios", async () => {
    const alheio = { url: "https://outro.exemplo/hook", events: ["message"] };
    const recebidos = await servidor(
      [
        { method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING", { ...FILTRO, webhooks: [alheio] }) },
        { method: "PUT", path: CAMINHO, status: 200, body: sessao("WORKING") },
      ],
      async (c) => { await expect(c.convergirConfigDaSessao(NOME, { webhook: WEBHOOK })).resolves.toBe(true); },
    );
    const put = recebidos[1]!.body as { config: { webhooks: Array<Record<string, unknown>> } };
    expect(put.config.webhooks).toEqual([alheio, entradaDoWebhookDaSessao(WEBHOOK)]);
  });

  it("troca a entrada do CRM com token antigo pela do token atual", async () => {
    const antiga = entradaDoWebhookDaSessao({ url: "https://crm.exemplo.com.br/api/v1/webhooks/waha/token-velho", hmacKey: WEBHOOK.hmacKey });
    const recebidos = await servidor(
      [
        { method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING", { ...FILTRO, webhooks: [antiga] }) },
        { method: "PUT", path: CAMINHO, status: 200, body: sessao("WORKING") },
      ],
      async (c) => { await c.convergirConfigDaSessao(NOME, { webhook: WEBHOOK }); },
    );
    const put = recebidos[1]!.body as { config: { webhooks: Array<Record<string, unknown>> } };
    expect(put.config.webhooks).toEqual([entradaDoWebhookDaSessao(WEBHOOK)]);
  });

  it("troca a chave quando a da sessão mudou", async () => {
    const outraChave = entradaDoWebhookDaSessao({ url: WEBHOOK.url, hmacKey: "z".repeat(64) });
    const recebidos = await servidor(
      [
        { method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING", { ...FILTRO, webhooks: [outraChave] }) },
        { method: "PUT", path: CAMINHO, status: 200, body: sessao("WORKING") },
      ],
      async (c) => { await c.convergirConfigDaSessao(NOME, { webhook: WEBHOOK }); },
    );
    const put = recebidos[1]!.body as { config: { webhooks: Array<{ hmac: { key: string } }> } };
    expect(put.config.webhooks[0]!.hmac.key).toBe(WEBHOOK.hmacKey);
  });

  it("já igual (eventos noutra ordem, campos extras do WAHA): NÃO faz PUT — não reinicia a sessão", async () => {
    const igual = {
      ...entradaDoWebhookDaSessao(WEBHOOK),
      events: [...EVENTOS_DO_WEBHOOK_DA_SESSAO].reverse(),
      customHeaders: null,
    };
    await servidor(
      [{ method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING", { ...FILTRO, webhooks: [igual] }) }],
      async (c) => { await expect(c.convergirConfigDaSessao(NOME, { webhook: WEBHOOK })).resolves.toBe(true); },
    );
  });

  it("sem a opção de webhook (PATCH /acervo), o `webhooks` existente vai intacto no PUT", async () => {
    const existente = entradaDoWebhookDaSessao(WEBHOOK);
    const recebidos = await servidor(
      [
        { method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING", { ...FILTRO, webhooks: [existente] }) },
        { method: "PUT", path: CAMINHO, status: 200, body: sessao("WORKING") },
      ],
      async (c) => { await c.convergirConfigDaSessao(NOME, { guardarHistorico: true }); },
    );
    const put = recebidos[1]!.body as { config: { webhooks: unknown[] } };
    expect(put.config.webhooks).toEqual([existente]);
  });

  it("startSession em sessão existente sem o webhook converge (PUT) antes de iniciar", async () => {
    const duplicada = { statusCode: 422, error: "Unprocessable Entity", message: `Session '${NOME}' already exists. Use PUT to update it.` };
    const recebidos = await servidor(
      [
        { method: "POST", path: "/api/sessions", status: 422, body: duplicada },
        { method: "GET", path: CAMINHO, status: 200, body: sessao() },
        { method: "GET", path: CAMINHO, status: 200, body: sessao() },
        { method: "PUT", path: CAMINHO, status: 200, body: sessao() },
        { method: "POST", path: `${CAMINHO}/start`, status: 201, body: sessao("STARTING") },
        { method: "GET", path: CAMINHO, status: 200, body: sessao("SCAN_QR_CODE") },
      ],
      async (c) => { await c.startSession(NOME, { webhook: WEBHOOK }); },
    );
    const put = recebidos.find((r) => r.method === "PUT")!.body as { config: { webhooks: unknown[] } };
    expect(put.config.webhooks).toEqual([entradaDoWebhookDaSessao(WEBHOOK)]);
  });

  it("PUT recusado com webhook pedido fica no log — sem URL nem chave", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      await servidor(
        [
          { method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING") },
          { method: "PUT", path: CAMINHO, status: 400 },
        ],
        async (c) => { await expect(c.convergirConfigDaSessao(NOME, { webhook: WEBHOOK })).resolves.toBe(false); },
      );
      const logado = JSON.stringify(aviso.mock.calls);
      expect(logado).toContain("webhook_pedido");
      expect(logado).not.toContain(WEBHOOK.hmacKey);
      expect(logado).not.toContain("token-atual");
    } finally {
      aviso.mockRestore();
    }
  });
});

/**
 * O WAHA pode MASCARAR `hmac.key` no GET (asteriscos, vazia ou ausente). Dois
 * riscos: (a) todo PUT por spread do `config.webhooks` lido regravaria a máscara
 * como chave; (b) comparar a chave literalmente faria toda reconexão reiniciar
 * a sessão. E a entrada do CRM é reconhecida pelo SUFIXO com o token desta
 * linha, para trocar a base pública não deixar a entrada antiga viva.
 */
describe("webhook por sessão: chave mascarada no GET e troca de base", () => {
  const ALHEIO = { url: "https://n8n.exemplo.com/webhook/x", events: ["message"], hmac: { key: "****" } };
  const mascarada = (key: unknown) => {
    const e = entradaDoWebhookDaSessao(WEBHOOK) as Record<string, unknown>;
    return key === undefined ? { ...e, hmac: {} } : { ...e, hmac: { key } };
  };

  it.each([["asteriscos", "********"], ["vazia", ""], ["ausente", undefined]])(
    "chave %s com url, eventos e retries iguais: conferido, SEM PUT (não reinicia a sessão)",
    async (_nome, key) => {
      await servidor(
        [{ method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING", { ...FILTRO, webhooks: [mascarada(key)] }) }],
        async (c) => { await expect(c.convergirConfigDaSessao(NOME, { webhook: WEBHOOK })).resolves.toBe(true); },
      );
    },
  );

  it("chave mascarada + filtro divergente: o PUT leva a chave do BANCO, nunca a máscara", async () => {
    const recebidos = await servidor(
      [
        { method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING", { ignore: { status: false }, webhooks: [ALHEIO, mascarada("********")] }) },
        { method: "PUT", path: CAMINHO, status: 200, body: sessao("WORKING") },
      ],
      async (c) => { await c.convergirConfigDaSessao(NOME, { webhook: WEBHOOK }); },
    );
    const put = recebidos[1]!.body as { config: { webhooks: Array<Record<string, unknown>> } };
    expect(put.config.webhooks).toEqual([ALHEIO, entradaDoWebhookDaSessao(WEBHOOK)]);
  });

  it("trocou WAHA_WEBHOOK_BASE_URL: a entrada da base ANTIGA com o mesmo token é substituída, não preservada como alheia", async () => {
    const antiga = entradaDoWebhookDaSessao({ url: "https://antigo.exemplo.net/api/v1/webhooks/waha/token-atual", hmacKey: WEBHOOK.hmacKey });
    const recebidos = await servidor(
      [
        { method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING", { ...FILTRO, webhooks: [ALHEIO, antiga] }) },
        { method: "PUT", path: CAMINHO, status: 200, body: sessao("WORKING") },
      ],
      async (c) => { await c.convergirConfigDaSessao(NOME, { webhook: WEBHOOK }); },
    );
    const put = recebidos[1]!.body as { config: { webhooks: unknown[] } };
    expect(put.config.webhooks).toEqual([ALHEIO, entradaDoWebhookDaSessao(WEBHOOK)]);
  });

  it("definirRecebimentoDeGrupos com o webhook da sessão: o PUT reaplica a entrada com a chave do banco", async () => {
    const recebidos = await servidor(
      [
        { method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING", { ...FILTRO, webhooks: [ALHEIO, mascarada("****")] }) },
        { method: "PUT", path: CAMINHO, status: 200, body: sessao("WORKING") },
        { method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING", { ignore: { ...FILTRO.ignore, groups: false } }) },
      ],
      async (c) => { await expect(c.definirRecebimentoDeGrupos(NOME, true, WEBHOOK)).resolves.toBe(true); },
    );
    const put = recebidos[1]!.body as { config: { webhooks: unknown[] } };
    expect(put.config.webhooks).toEqual([ALHEIO, entradaDoWebhookDaSessao(WEBHOOK)]);
  });

  it("definirRecebimentoDeGrupos SEM o webhook: preserva a lista como veio (comportamento de antes)", async () => {
    const recebidos = await servidor(
      [
        { method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING", { ...FILTRO, webhooks: [ALHEIO] }) },
        { method: "PUT", path: CAMINHO, status: 200, body: sessao("WORKING") },
        { method: "GET", path: CAMINHO, status: 200, body: sessao("WORKING", { ignore: { ...FILTRO.ignore, groups: false } }) },
      ],
      async (c) => { await expect(c.definirRecebimentoDeGrupos(NOME, true)).resolves.toBe(true); },
    );
    const put = recebidos[1]!.body as { config: { webhooks: unknown[] } };
    expect(put.config.webhooks).toEqual([ALHEIO]);
  });
});
