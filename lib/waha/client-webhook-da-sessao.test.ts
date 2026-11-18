/**
 * Webhook POR SESSÃO no corpo que o cliente manda ao WAHA (servidor HTTP real,
 * corpo lido do fio).
 *
 * - criação com webhook: `config.webhooks` leva a URL e `hmac.key` pedidos;
 * - criação sem webhook: o corpo é o de sempre (sem `webhooks`);
 * - convergência: acrescenta/atualiza a entrada do CRM, preserva as alheias, e
 *   NÃO faz PUT (que reinicia a sessão) quando já está igual;
 * - convergência sem a opção (PATCH /acervo) não toca no `webhooks` existente.
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
