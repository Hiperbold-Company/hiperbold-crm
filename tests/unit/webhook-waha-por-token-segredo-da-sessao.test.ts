import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rota por token confere a assinatura com o segredo DA SESSÃO do token — não
 * com o de outra sessão, nem de outra organização.
 *
 * O webhook por sessão (lib/channels/webhook-da-sessao-waha.ts) registra no WAHA
 * `hmac.key` = segredo próprio da sessão. Isto prova a outra ponta: um corpo
 * assinado para a sessão da organização B, reenviado ao token da organização A,
 * é recusado (401) e nada é processado.
 *
 * A autenticação NÃO é dublê aqui (`lib/waha/webhook-auth` é o real): o que se
 * mede é a assinatura de verdade contra o segredo decifrado da linha do token.
 */

const SEGREDO_A = "a".repeat(64);
const SEGREDO_B = "b".repeat(64);

const SESSOES: Record<string, Record<string, unknown>> = {
  "token-da-org-a-000001": {
    id: "sess-a", organization_id: "org-a", waha_session_name: "sessao-a",
    webhook_secret_encrypted: "\\xcifrado-a", status: "WORKING", is_warmup_complete: true, warmup_started_at: null,
  },
  "token-da-org-b-000002": {
    id: "sess-b", organization_id: "org-b", waha_session_name: "sessao-b",
    webhook_secret_encrypted: "\\xcifrado-b", status: "WORKING", is_warmup_complete: true, warmup_started_at: null,
  },
};
const DECIFRA: Record<string, string> = { "\\xcifrado-a": SEGREDO_A, "\\xcifrado-b": SEGREDO_B };

const processados: unknown[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "webhook_events_log") {
        return { insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "log-1" }, error: null }) }) }) };
      }
      let token: unknown = null;
      const b = {
        select: () => b,
        eq: (coluna: string, valor: unknown) => { if (coluna === "webhook_path_token") token = valor; return b; },
        is: () => b,
        maybeSingle: async () => ({ data: SESSOES[String(token)] ?? null, error: null }),
      };
      return b;
    },
    rpc: async (_nome: string, args: { ciphertext: string }) => ({ data: DECIFRA[args.ciphertext] ?? null, error: null }),
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/instalacao/comportamento-servidor", () => ({ carregarComportamentoDaInstalacao: async () => undefined }));
vi.mock("@/lib/waha/desfecho-do-webhook", () => ({
  REENTREGA_EM_SEGUNDOS: 5,
  processarEventoWaha: async (_a: unknown, sessao: unknown) => { processados.push(sessao); return "processado"; },
}));

import { POST } from "@/app/api/v1/webhooks/waha/[token]/route";
import { limparMemoriaDeSessoes } from "@/lib/waha/sessao-do-webhook";

const assinar = (corpo: string, segredo: string) => createHmac("sha512", segredo).update(corpo, "utf8").digest("hex");

function entregar(token: string, corpo: string, assinatura: string) {
  const req = {
    body: new Response(corpo).body,
    text: async () => corpo,
    headers: new Headers({ "x-webhook-hmac": assinatura, "x-webhook-hmac-algorithm": "sha512" }),
  } as never;
  return POST(req, { params: Promise.resolve({ token }) });
}

const evento = (sessao: string) => JSON.stringify({
  event: "message.any", session: sessao,
  payload: { id: "false_5531988887777@c.us_ABC", from: "5531988887777@c.us", fromMe: false, body: "oi", timestamp: 1763400000 },
});

beforeEach(() => {
  limparMemoriaDeSessoes();
  processados.length = 0;
});

describe("rota por token: assinatura com o segredo da própria sessão", () => {
  it("aceita evento assinado com o segredo da sessão do token", async () => {
    const corpo = evento("sessao-a");
    const res = await entregar("token-da-org-a-000001", corpo, assinar(corpo, SEGREDO_A));
    expect(res.status).toBe(200);
    expect(processados).toHaveLength(1);
    expect(processados[0]).toMatchObject({ id: "sess-a", organization_id: "org-a" });
  });

  it("recusa (401) corpo assinado com o segredo de OUTRA sessão/organização e não processa nada", async () => {
    const corpo = evento("sessao-a");
    const res = await entregar("token-da-org-a-000001", corpo, assinar(corpo, SEGREDO_B));
    expect(res.status).toBe(401);
    expect(processados).toHaveLength(0);
  });

  it("controle: o mesmo corpo assinado com o segredo de B passa no token de B quando a sessão é a de B", async () => {
    const corpo = evento("sessao-b");
    const res = await entregar("token-da-org-b-000002", corpo, assinar(corpo, SEGREDO_B));
    expect(res.status).toBe(200);
    expect(processados[0]).toMatchObject({ id: "sess-b", organization_id: "org-b" });
  });
});
