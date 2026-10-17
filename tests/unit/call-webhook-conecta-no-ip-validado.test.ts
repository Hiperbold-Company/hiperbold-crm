import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { executeCallWebhook } from "@/lib/automation/actions/call-webhook";
import type { ActionCtx } from "@/lib/automation/types";

/**
 * `call_webhook` conecta no IP que a guarda VALIDOU (D-168, como o MCP externo) e
 * repete a conferência a cada tentativa do laço. Só a rede e o DNS são trocados;
 * a régua (`resolverDestinoSeguro`) é a de verdade nos casos de IP literal.
 */
function ctx(): ActionCtx {
  return {
    admin: {} as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
    ruleName: "Regra",
    requestId: "req-1",
    event: {
      id: "evt-1",
      organization_id: "org-1",
      event_type: "lead.created",
      entity_kind: "crm_lead",
      entity_id: "lead-1",
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    },
    context: {},
  };
}

type Chamada = { url: URL; opcoes: Record<string, unknown> };

function redeFalsa(status: number | (() => number)) {
  const chamadas: Chamada[] = [];
  const requisitar = vi.fn((url: URL, opcoes: Record<string, unknown>, cb: (res: unknown) => void) => {
    chamadas.push({ url, opcoes });
    const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void };
    req.write = () => {};
    req.end = () => {
      const res = new PassThrough() as PassThrough & { statusCode: number; statusMessage: string; headers: object };
      res.statusCode = typeof status === "function" ? status() : status;
      res.statusMessage = "";
      res.headers = {};
      cb(res);
      res.end("");
    };
    return req;
  });
  return { requisitar: requisitar as never, chamadas };
}

function lookupDe(chamada: Chamada): string {
  const lookup = chamada.opcoes.lookup as (n: string, o: unknown, cb: (...a: unknown[]) => void) => void;
  const cb = vi.fn();
  lookup(chamada.url.hostname, {}, cb);
  return cb.mock.calls[0]![1] as string;
}

describe("call_webhook: a conexão abre no endereço conferido", () => {
  it("conecta no IP validado, com o nome original no SNI e no host da URL", async () => {
    const { requisitar, chamadas } = redeFalsa(200);
    const r = await executeCallWebhook(
      ctx(),
      { url: "https://cliente.exemplo.com/hook" },
      { resolverHost: async () => ["93.184.216.34"], requisitar, retryDelaysMs: [] },
    );
    expect(r.status).toBe("success");
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url.hostname).toBe("cliente.exemplo.com");
    expect(chamadas[0]!.opcoes.servername).toBe("cliente.exemplo.com");
    // O socket só conhece o endereço validado: o DNS não é consultado de novo.
    expect(lookupDe(chamadas[0]!)).toBe("93.184.216.34");
  });

  it("rebinding entre conferência e conexão: o DNS passa a devolver IP interno e a conexão NÃO o segue", async () => {
    // Primeira (e única, na tentativa 1) resolução: público. Qualquer resolução
    // POSTERIOR devolveria o endereço de metadados da nuvem.
    let resolucoes = 0;
    const resolverHost = vi.fn(async () => {
      resolucoes += 1;
      return resolucoes === 1 ? ["93.184.216.34"] : ["169.254.169.254"];
    });
    const { requisitar, chamadas } = redeFalsa(200);
    const r = await executeCallWebhook(
      ctx(),
      { url: "https://rebinding.exemplo.com/hook" },
      { resolverHost, requisitar, retryDelaysMs: [] },
    );
    expect(r.status).toBe("success");
    expect(resolverHost).toHaveBeenCalledTimes(1);
    expect(chamadas.map(lookupDe)).toEqual(["93.184.216.34"]);
  });

  it("a conferência se repete a CADA tentativa: DNS que vira IP interno no retry é recusado sem conectar", async () => {
    let resolucoes = 0;
    const resolverHost = vi.fn(async (_h: string) => {
      resolucoes += 1;
      if (resolucoes === 1) return ["93.184.216.34"];
      throw new Error("unsafe_url:private_ip");
    });
    const { requisitar, chamadas } = redeFalsa(500);
    const r = await executeCallWebhook(
      ctx(),
      { url: "https://rebinding.exemplo.com/hook" },
      { resolverHost, requisitar, retryDelaysMs: [0, 0] },
    );
    expect(resolverHost).toHaveBeenCalledTimes(2);
    expect(chamadas).toHaveLength(1); // só a primeira tentativa chegou à rede
    expect(r.status).toBe("failed");
    // Mesmo código único que a organização enxerga (D-084), não o motivo cru.
    expect(r.error).not.toBe("http_500");
    expect(r.error).not.toContain("private_ip");
  });

  it("cada tentativa conecta no que a resolução DAQUELA tentativa devolveu", async () => {
    const ips = ["93.184.216.34", "93.184.216.35"];
    const resolverHost = vi.fn(async () => [ips.shift()!]);
    let n = 0;
    const { requisitar, chamadas } = redeFalsa(() => (++n === 1 ? 500 : 200));
    const r = await executeCallWebhook(
      ctx(),
      { url: "https://cliente.exemplo.com/hook" },
      { resolverHost, requisitar, retryDelaysMs: [0] },
    );
    expect(r.status).toBe("success");
    expect(chamadas.map(lookupDe)).toEqual(["93.184.216.34", "93.184.216.35"]);
  });

  it("destino interno (resolução de verdade, IP literal) nem chega à rede", async () => {
    const { requisitar, chamadas } = redeFalsa(200);
    const r = await executeCallWebhook(ctx(), { url: "https://169.254.169.254/hook" }, { requisitar, retryDelaysMs: [] });
    expect(r.status).toBe("failed");
    expect(chamadas).toHaveLength(0);
  });

  it("3xx continua sendo falha comum (redirect não seguido)", async () => {
    const { requisitar } = redeFalsa(302);
    const r = await executeCallWebhook(
      ctx(),
      { url: "https://cliente.exemplo.com/hook" },
      { resolverHost: async () => ["93.184.216.34"], requisitar, retryDelaysMs: [] },
    );
    expect(r).toMatchObject({ status: "failed", error: "redirect_not_followed" });
  });
});
