import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A rota por token, com o segredo próprio da sessão, NÃO cai no segredo global
 * da instalação (`WAHA_HMAC_SECRET`) nem aceita entrega sem assinatura — qualquer
 * que seja o interruptor do banco ou o `.env`.
 *
 *  - sessão com segredo próprio + POST sem assinatura ⇒ 401 (antes: 200 com a
 *    exigência desligada);
 *  - RPC de decifra falhando ⇒ 503 retentável (antes: conferia com o global);
 *  - placeholder (sessão antiga, ou sentinela que a decifra devolve NULL) ⇒
 *    regra de antes: o global confere.
 *
 * A autenticação é a real (`lib/waha/webhook-auth`); só banco e efeitos são dublês.
 */

const GLOBAL = "e".repeat(64);
const PROPRIO = "f".repeat(64);

const { envMock } = vi.hoisted(() => ({ envMock: { WAHA_HMAC_SECRET: "", WAHA_WEBHOOK_REQUIRE_SIGNATURE: "false" } }));
vi.mock("@/lib/env", async (importOriginal) => {
  const original = (await importOriginal()) as { env: Record<string, unknown> };
  return { env: new Proxy(original.env, { get: (alvo, k: string) => (k in envMock ? envMock[k as keyof typeof envMock] : alvo[k]) }) };
});

const linha = (cifrado: string) => ({
  id: "sess-a", organization_id: "org-a", waha_session_name: "sessao-a",
  webhook_secret_encrypted: cifrado, status: "WORKING", is_warmup_complete: true, warmup_started_at: null,
});

const estado = { cifrado: "\\xc30d-proprio", decifra: "ok" as "ok" | "erro" | "nulo" };
const processados: unknown[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "webhook_events_log") {
        return { insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "log-1" }, error: null }) }) }) };
      }
      const b = {
        select: () => b,
        eq: () => b,
        is: () => b,
        maybeSingle: async () => ({ data: linha(estado.cifrado), error: null }),
      };
      return b;
    },
    rpc: async (_nome: string, args: { ciphertext: string }) => {
      if (estado.decifra === "erro") return { data: null, error: { message: "banco fora" } };
      if (estado.decifra === "nulo" || /^\\x0*$/.test(args.ciphertext)) return { data: null, error: null };
      return { data: PROPRIO, error: null };
    },
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
const corpo = JSON.stringify({
  event: "message.any", session: "sessao-a",
  payload: { id: "false_5531988887777@c.us_ABC", from: "5531988887777@c.us", fromMe: false, body: "oi", timestamp: 1763400000 },
});

function entregar(assinatura: string | null) {
  const headers = new Headers(assinatura ? { "x-webhook-hmac": assinatura, "x-webhook-hmac-algorithm": "sha512" } : {});
  const req = { body: new Response(corpo).body, text: async () => corpo, headers } as never;
  return POST(req, { params: Promise.resolve({ token: "token-da-org-a-000001" }) });
}

beforeEach(() => {
  limparMemoriaDeSessoes();
  processados.length = 0;
  envMock.WAHA_HMAC_SECRET = GLOBAL;
  envMock.WAHA_WEBHOOK_REQUIRE_SIGNATURE = "false";
  estado.cifrado = "\\xc30d-proprio";
  estado.decifra = "ok";
});

describe("rota por token: segredo próprio exige assinatura, sem queda para o global", () => {
  it("segredo próprio + POST SEM assinatura, exigência desligada ⇒ 401 e nada processado", async () => {
    const res = await entregar(null);
    expect(res.status).toBe(401);
    expect(processados).toHaveLength(0);
  });

  it("controle: segredo próprio + assinatura certa ⇒ 200", async () => {
    const res = await entregar(assinar(corpo, PROPRIO));
    expect(res.status).toBe(200);
    expect(processados).toHaveLength(1);
  });

  it("RPC de decifra falhando + assinatura com o GLOBAL ⇒ 503 com Retry-After, nada processado", async () => {
    estado.decifra = "erro";
    const res = await entregar(assinar(corpo, GLOBAL));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(processados).toHaveLength(0);
  });

  it("cifrado que decifra para NULL (sentinela de rota antiga) ⇒ regra antiga: o global confere", async () => {
    estado.decifra = "nulo";
    const res = await entregar(assinar(corpo, GLOBAL));
    expect(res.status).toBe(200);
  });

  it("placeholder (sessão antiga, ainda não reconectada) ⇒ o global ainda confere, como antes", async () => {
    estado.cifrado = "\\x00";
    const res = await entregar(assinar(corpo, GLOBAL));
    expect(res.status).toBe(200);
    expect(processados).toHaveLength(1);
  });
});
