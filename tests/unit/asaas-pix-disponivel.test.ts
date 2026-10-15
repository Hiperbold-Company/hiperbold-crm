/**
 * `lib/billing/asaas/pix.ts`: o Pix só é oferecido quando a conta Asaas tem chave Pix ATIVA.
 *
 * RESTRIÇÃO ABSOLUTA: nenhuma chamada real. Todo `fetch` é um dublê local e a hora é injetada, então o
 * cache (10 min com resposta, 1 min depois de erro) é provado sem esperar de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigAsaas } from "@/lib/billing/asaas/config";
import { esquecerCacheDoPix, pixDisponivel, TTL_PIX_ERRO_MS, TTL_PIX_MS } from "@/lib/billing/asaas/pix";

const CONFIG: ConfigAsaas = {
  habilitado: true,
  baseUrl: "https://api-sandbox.asaas.com/v3",
  apiKey: "$aact_hmlg_testeNuncaEUmaChaveReal000111222",
  webhookToken: "token-de-teste-nunca-real",
  webhookId: "",
  ambiente: "sandbox",
};

const logger = { warn: vi.fn(), error: vi.fn() };

function resposta(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}

/** `fetch` falso que responde na ordem; o último passo se repete. */
function fetchFalso(passos: Array<() => Response>) {
  const chamadas: string[] = [];
  const fn = vi.fn(async (url: string | URL | Request) => {
    chamadas.push(String(url));
    const passo = passos[Math.min(chamadas.length - 1, passos.length - 1)]!;
    return passo();
  });
  return { fn: fn as unknown as typeof fetch, chamadas };
}

const comTotal = (totalCount: number) => () => resposta(200, { object: "list", totalCount, data: [] });
// 403 não repete sozinho (um 5xx repetiria o GET com espera real): o teste mede o cache, não o retry do cliente.
const quebra = () => resposta(403, { errors: [] });

let agora = 1_000_000;
const relogio = () => agora;

function chamar(f: typeof fetch, config: ConfigAsaas = CONFIG) {
  return pixDisponivel({ deps: { fetch: f, config, logger }, agora: relogio });
}

beforeEach(() => {
  esquecerCacheDoPix();
  agora = 1_000_000;
  logger.warn.mockReset();
  logger.error.mockReset();
});

describe("pixDisponivel", () => {
  it("consulta as chaves Pix ATIVAS e devolve true quando há pelo menos uma", async () => {
    const { fn, chamadas } = fetchFalso([comTotal(1)]);
    expect(await chamar(fn)).toBe(true);
    expect(chamadas).toEqual(["https://api-sandbox.asaas.com/v3/pix/addressKeys?status=ACTIVE"]);
  });

  it("devolve false quando a conta não tem chave ativa (conta ainda em aprovação)", async () => {
    const { fn } = fetchFalso([comTotal(0)]);
    expect(await chamar(fn)).toBe(false);
  });

  it("guarda a resposta por 10 minutos: a segunda chamada não vai à rede", async () => {
    const { fn, chamadas } = fetchFalso([comTotal(1)]);
    await chamar(fn);
    agora += TTL_PIX_MS - 1;
    expect(await chamar(fn)).toBe(true);
    expect(chamadas).toHaveLength(1);
  });

  it("depois dos 10 minutos consulta de novo e a chave que apareceu liga o Pix sozinha", async () => {
    const { fn, chamadas } = fetchFalso([comTotal(0), comTotal(2)]);
    expect(await chamar(fn)).toBe(false);
    agora += TTL_PIX_MS;
    expect(await chamar(fn)).toBe(true);
    expect(chamadas).toHaveLength(2);
  });

  it("consultas simultâneas dividem uma só ida à rede", async () => {
    const { fn, chamadas } = fetchFalso([comTotal(1)]);
    const todas = await Promise.all([chamar(fn), chamar(fn), chamar(fn)]);
    expect(todas).toEqual([true, true, true]);
    expect(chamadas).toHaveLength(1);
  });

  it("erro sem valor anterior esconde o Pix (false), avisa uma vez por renovação e tenta de novo em 1 minuto", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fn, chamadas } = fetchFalso([quebra, comTotal(1)]);
    expect(await chamar(fn)).toBe(false);
    expect(chamadas).toHaveLength(1);
    expect(aviso.mock.calls.filter((c) => String(c[0]).includes("asaas_pix_disponivel_falhou"))).toHaveLength(1);

    agora += TTL_PIX_ERRO_MS - 1;
    expect(await chamar(fn)).toBe(false);
    expect(chamadas).toHaveLength(1); // ainda dentro do minuto: sem nova ida, sem novo aviso
    expect(aviso.mock.calls.filter((c) => String(c[0]).includes("asaas_pix_disponivel_falhou"))).toHaveLength(1);

    agora += 1;
    expect(await chamar(fn)).toBe(true); // venceu o minuto: tenta de novo e a chave apareceu
    expect(chamadas).toHaveLength(2);
    aviso.mockRestore();
  });

  it("erro com valor anterior mantém o último valor conhecido", async () => {
    const { fn } = fetchFalso([comTotal(1), quebra]);
    expect(await chamar(fn)).toBe(true);
    agora += TTL_PIX_MS;
    expect(await chamar(fn)).toBe(true);
  });

  it("resposta fora do formato conta como erro (false), não como Pix disponível", async () => {
    const { fn } = fetchFalso([() => resposta(200, { ok: true })]);
    expect(await chamar(fn)).toBe(false);
  });

  it("compra desligada (ASAAS_ENABLED=false) devolve false sem tocar a rede", async () => {
    const { fn, chamadas } = fetchFalso([comTotal(1)]);
    expect(await chamar(fn, { ...CONFIG, habilitado: false })).toBe(false);
    expect(chamadas).toEqual([]);
  });

  it("o aviso de erro não carrega a chave de API", async () => {
    const { fn } = fetchFalso([quebra]);
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    await chamar(fn);
    const escrito = JSON.stringify(aviso.mock.calls);
    expect(escrito).not.toContain("aact_hmlg");
    aviso.mockRestore();
  });
});
