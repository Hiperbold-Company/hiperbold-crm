/**
 * Cupom (migration 0955): o método novo do cliente HTTP do Asaas (`atualizarValorDaCobranca`, `POST
 * /payments/{id}`) e as peças puras de `lib/billing/asaas/cupom.ts`. Nenhuma chamada real: `fetch` é um dublê.
 */
import { describe, expect, it } from "vitest";

import { criarClienteAsaas, type FetchAsaas } from "@/lib/billing/asaas/cliente";
import type { ConfigAsaas } from "@/lib/billing/asaas/config";
import {
  FORMATO_DO_CODIGO_DE_CUPOM,
  impressaoDoPagador,
  mensagemDoErroDeCupom,
  mesmoCodigoDeCupom,
  normalizarCodigoDeCupom,
} from "@/lib/billing/asaas/cupom";
import { ErroAsaasException } from "@/lib/billing/asaas/erros";

const CONFIG: ConfigAsaas = {
  habilitado: true,
  baseUrl: "https://api-sandbox.asaas.com/v3",
  apiKey: "$aact_hmlg_" + "testeNuncaEUmaChaveReal000111222",
  webhookToken: "token-de-teste-nunca-real",
  webhookId: "",
  ambiente: "sandbox",
};

const COBRANCA = {
  id: "pay_abc123",
  customer: "cus_abc123",
  subscription: "sub_abc123",
  status: "PENDING",
  billingType: "CREDIT_CARD",
  value: 944.1,
  dueDate: "2026-10-14",
  invoiceUrl: "https://sandbox.asaas.com/i/abc123",
};

function montar(respostas: Response[]) {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchFalso = (async (url: string | URL, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    const r = respostas[i];
    i += 1;
    if (!r) throw new Error("fetch sem resposta programada");
    return r;
  }) as FetchAsaas;
  const cliente = criarClienteAsaas({
    fetch: fetchFalso,
    config: CONFIG,
    logger: { warn: () => undefined, error: () => undefined },
  });
  return { cliente, chamadas };
}

const json = (status: number, corpo: unknown) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

describe("cliente Asaas: atualizarValorDaCobranca", () => {
  it("faz POST /payments/{id} só com o valor, com o access_token, e devolve a cobrança lida", async () => {
    const { cliente, chamadas } = montar([json(200, COBRANCA)]);

    const r = await cliente.atualizarValorDaCobranca("pay_abc123", { value: 944.1 });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.url).toBe("https://api-sandbox.asaas.com/v3/payments/pay_abc123");
    expect(chamadas[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(chamadas[0]?.init.body))).toEqual({ value: 944.1 });
    expect((chamadas[0]?.init.headers as Record<string, string>).access_token).toBe(CONFIG.apiKey);
    expect(r.value).toBe(944.1);
    expect(r.invoiceUrl).toBe("https://sandbox.asaas.com/i/abc123");
  });

  it("recusa valor zero, negativo ou ausente antes de qualquer chamada", async () => {
    const { cliente, chamadas } = montar([]);
    await expect(cliente.atualizarValorDaCobranca("pay_abc123", { value: 0 })).rejects.toThrow();
    await expect(cliente.atualizarValorDaCobranca("pay_abc123", { value: -5 })).rejects.toThrow();
    await expect(cliente.atualizarValorDaCobranca("pay_abc123", {} as never)).rejects.toThrow();
    expect(chamadas).toEqual([]);
  });

  it("só o valor viaja: campo a mais na entrada não vai no corpo", async () => {
    const { cliente, chamadas } = montar([json(200, COBRANCA)]);
    await cliente.atualizarValorDaCobranca("pay_abc123", { value: 90, dueDate: "2030-01-01", billingType: "PIX" } as never);
    expect(JSON.parse(String(chamadas[0]?.init.body))).toEqual({ value: 90 });
  });

  it("POST nunca repete sozinho: 503 vira erro inconclusivo com uma única chamada", async () => {
    const { cliente, chamadas } = montar([json(503, {}), json(200, COBRANCA)]);
    const erro = await cliente.atualizarValorDaCobranca("pay_abc123", { value: 90 }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroAsaasException);
    expect((erro as ErroAsaasException).erro.inconclusivo).toBe(true);
    expect(chamadas).toHaveLength(1);
  });

  it("400 de validação vira erro de validação, sem texto cru", async () => {
    const { cliente } = montar([json(400, { errors: [{ code: "invalid_value", description: "texto com dado" }] })]);
    const erro = (await cliente.atualizarValorDaCobranca("pay_abc123", { value: 90 }).catch((e: unknown) => e)) as ErroAsaasException;
    expect(erro.erro.tipo).toBe("validacao");
    expect(JSON.stringify(erro.erro)).not.toContain("texto com dado");
  });

  it("o id vai codificado no caminho (sem injeção de caminho)", async () => {
    const { cliente, chamadas } = montar([json(200, COBRANCA)]);
    await cliente.atualizarValorDaCobranca("pay_abc/../customers", { value: 90 });
    expect(chamadas[0]?.url).toBe("https://api-sandbox.asaas.com/v3/payments/pay_abc%2F..%2Fcustomers");
  });
});

describe("cupom.ts: frases e comparação de código", () => {
  it("cada código do banco tem a sua frase, e o prefixo geral cai em cupom inválido", () => {
    // Tudo que não se aplica a esta compra: UMA frase, para ninguém descobrir códigos pela resposta.
    for (const codigo of [
      "billing_cupom_invalido",
      "billing_cupom_expirado",
      "billing_cupom_esgotado",
      "billing_cupom_nao_vale_para_o_plano",
      "billing_cupom_nao_vale_para_o_ciclo",
      "billing_cupom_algo_que_nao_existe",
    ]) {
      expect(mensagemDoErroDeCupom(codigo), codigo).toBe("Cupom inválido ou indisponível para esta compra.");
    }
    // Só estas ficam distintas.
    expect(mensagemDoErroDeCupom("billing_cupom_ja_usado")).toBe("Este cupom já foi utilizado por você ou pela sua organização.");
    expect(mensagemDoErroDeCupom("billing_cupom_sem_desconto")).toBe("Este cupom não dá desconto neste plano.");
    expect(mensagemDoErroDeCupom("billing_cupom_parcela_minima")).toBe("Com este desconto, escolha menos parcelas.");
  });

  it("texto que não é de cupom devolve nulo (quem chamou segue o próprio caminho)", () => {
    expect(mensagemDoErroDeCupom("billing_compra_desligada")).toBeNull();
    expect(mensagemDoErroDeCupom("")).toBeNull();
    expect(mensagemDoErroDeCupom(undefined)).toBeNull();
    expect(mensagemDoErroDeCupom(null)).toBeNull();
  });

  it("o formato do código é o do banco: letras, números, hífen e sublinhado, de 3 a 40", () => {
    for (const bom of ["abc", "ABC-123", "promo_2026", "a".repeat(40)]) expect(FORMATO_DO_CODIGO_DE_CUPOM.test(bom), bom).toBe(true);
    for (const ruim of ["ab", "a".repeat(41), "com espaço", "cupom!", "ç123", ""]) expect(FORMATO_DO_CODIGO_DE_CUPOM.test(ruim), ruim).toBe(false);
  });

  it("impressão do pagador: HMAC de 64 hexadecimais dos dígitos, igual com ou sem formatação, diferente por chave e por documento", () => {
    const a = impressaoDoPagador("111.444.777-35", "chave-1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(impressaoDoPagador("11144477735", "chave-1")).toBe(a);
    expect(impressaoDoPagador("11144477735", "chave-2")).not.toBe(a);
    expect(impressaoDoPagador("52998224725", "chave-1")).not.toBe(a);
    expect(a).not.toContain("11144477735");
    // CNPJ (14 dígitos) também tem impressão.
    expect(impressaoDoPagador("11.222.333/0001-81", "chave-1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sem documento de tamanho válido ou sem chave do servidor, não há impressão (a regra do pagador não vale)", () => {
    expect(impressaoDoPagador("123", "chave-1")).toBeNull();
    expect(impressaoDoPagador("", "chave-1")).toBeNull();
    expect(impressaoDoPagador(null, "chave-1")).toBeNull();
    expect(impressaoDoPagador("11144477735", "")).toBeNull();
    expect(impressaoDoPagador("11144477735", "   ")).toBeNull();
  });

  it("normalizar tira espaços e transforma vazio em ausente; comparar ignora maiúsculas", () => {
    expect(normalizarCodigoDeCupom("  PCT10 ")).toBe("PCT10");
    expect(normalizarCodigoDeCupom("   ")).toBeUndefined();
    expect(normalizarCodigoDeCupom(null)).toBeUndefined();
    expect(mesmoCodigoDeCupom("pct10", " PCT10")).toBe(true);
    expect(mesmoCodigoDeCupom("PCT10", "PCT11")).toBe(false);
    expect(mesmoCodigoDeCupom(null, undefined)).toBe(true);
    expect(mesmoCodigoDeCupom("PCT10", null)).toBe(false);
  });
});
