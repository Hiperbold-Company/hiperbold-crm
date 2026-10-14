/**
 * Cupom de desconto na camada da AÇÃO (`app/actions/settings/compraDoPlano.ts`, migration 0955):
 * `iniciarAssinatura` com `cupom` e `simularCupom`. O que se mede é a camada da ação: o mesmo gate de
 * `iniciarAssinatura` (sessão, papel, as duas chaves da compra), o código repassado sem mais nada, a
 * auditoria só com código e desconto, o teto de tentativas por usuário e a tradução da simulação.
 *
 * O limitador é o REAL (`authRateLimited`, com a regra de chaves e janela de verdade); só o contador por baixo
 * dele é trocado por um em memória, porque o `.env.local` de quem desenvolve pode apontar para um Redis vivo.
 * Nenhuma chamada ao Asaas: `iniciarCompra` e o banco são dublês.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const OUTRO_USER = "55555555-5555-4555-8555-555555555555";
const CHAVE = "44444444-4444-4444-8444-444444444444";

let papel = "admin";
let habilitado = true;
let compraLigadaValor = true;
let usuarioAtual = USER;

const auditadas: Array<Record<string, unknown>> = [];
const chamadasIniciar: Array<Record<string, unknown>> = [];
const chamadasSimular: Array<Record<string, unknown>> = [];
const contadores = new Map<string, number>();

let resultadoIniciar: unknown = { tipo: "redirecionar", url: "https://sandbox.asaas.com/i/fake" };
let respostaSimulacao: { data: unknown; error: unknown } = { data: null, error: null };

vi.mock("next/headers", () => ({
  headers: async () => new Map<string, string>([["x-request-id", "req-teste"]]),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditadas.push(e);
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: vi.fn(() => null) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: usuarioAtual, is_platform_admin: false, support: null })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org Teste", role: papel })),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ marca: "admin-falso" }) }));
vi.mock("@/lib/billing/asaas/db-compra-supabase", () => ({
  dbCompraSupabase: vi.fn(() => ({
    simularCupom: vi.fn(async (args: Record<string, unknown>) => {
      chamadasSimular.push(args);
      return respostaSimulacao;
    }),
  })),
}));
vi.mock("@/lib/billing/asaas/cliente", () => ({ criarClienteAsaas: vi.fn(() => ({ marca: "asaas-falso" })) }));
vi.mock("@/lib/billing/asaas/config", () => ({
  configDoAsaas: vi.fn(() => ({
    habilitado,
    baseUrl: "https://api-sandbox.asaas.com/v3",
    apiKey: "$aact_hmlg_x",
    webhookToken: "t",
    webhookId: "",
    ambiente: "sandbox" as const,
  })),
  compraLigada: vi.fn(async () => compraLigadaValor),
}));
vi.mock("@/lib/billing/asaas/compra", () => ({
  iniciarCompra: vi.fn(async (_deps: unknown, entrada: Record<string, unknown>) => {
    chamadasIniciar.push(entrada);
    return resultadoIniciar;
  }),
  cancelarAssinaturaDoCliente: vi.fn(),
}));
// O contador por baixo do limitador real: janela fixa em memória, sem rede.
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async (chave: string, limite: number) => {
    const n = (contadores.get(chave) ?? 0) + 1;
    contadores.set(chave, n);
    return { allowed: n <= limite, count: n };
  }),
  peekRateLimit: vi.fn(async (chave: string) => contadores.get(chave) ?? 0),
}));

import { iniciarAssinatura, simularCupom } from "@/app/actions/settings/compraDoPlano";
import { VERSAO_DOS_TERMOS } from "@/lib/legal/versao-dos-termos";

const ENTRADA = {
  planCode: "pro",
  ciclo: "semiannual" as const,
  metodo: "CREDIT_CARD" as const,
  chave: CHAVE,
  termosVersao: VERSAO_DOS_TERMOS,
};

const SIMULACAO = { codigo: "PCT10", planCode: "pro", ciclo: "semiannual" as const, metodo: "CREDIT_CARD" as const };

const OK_DO_BANCO = {
  ok: true,
  codigo: "PCT10",
  tipo: "percentual",
  valor: 10,
  preco_cheio_cents: 104900,
  desconto_cents: 10490,
  total_cents: 94410,
  parcelas: 1,
  total_final_cents: 94410,
};

beforeEach(() => {
  papel = "admin";
  habilitado = true;
  compraLigadaValor = true;
  usuarioAtual = USER;
  auditadas.length = 0;
  chamadasIniciar.length = 0;
  chamadasSimular.length = 0;
  contadores.clear();
  resultadoIniciar = { tipo: "redirecionar", url: "https://sandbox.asaas.com/i/fake" };
  respostaSimulacao = { data: OK_DO_BANCO, error: null };
});

describe("iniciarAssinatura com cupom", () => {
  it("repassa só o código (sem espaços nas pontas) a iniciarCompra", async () => {
    await iniciarAssinatura({ ...ENTRADA, cupom: "  PCT10 " });
    expect(chamadasIniciar).toHaveLength(1);
    expect(chamadasIniciar[0]).toMatchObject({ cupom: "PCT10", organizationId: ORG, actorId: USER });
  });

  it("sem cupom (ou em branco) a entrada não leva a chave cupom", async () => {
    await iniciarAssinatura(ENTRADA);
    await iniciarAssinatura({ ...ENTRADA, cupom: "   " });
    expect(chamadasIniciar).toHaveLength(2);
    for (const entrada of chamadasIniciar) expect("cupom" in entrada).toBe(false);
  });

  it("código fora do formato é recusado com a frase de cupom inválido, sem chamar iniciarCompra", async () => {
    for (const ruim of ["ab", "com espaço", "x".repeat(41), "ç$%&"]) {
      const r = await iniciarAssinatura({ ...ENTRADA, cupom: ruim });
      expect(r, ruim).toEqual({ tipo: "erro", mensagem: "Cupom inválido ou indisponível para esta compra." });
    }
    expect(chamadasIniciar).toEqual([]);
  });

  it("um defeito que não é só do cupom segue a frase genérica", async () => {
    const r = await iniciarAssinatura({ ...ENTRADA, chave: "nao-e-uuid", cupom: "ab" });
    expect(r).toEqual({ tipo: "erro", mensagem: "Dados inválidos. Confira o formulário e tente de novo." });
  });

  it("a organização é sempre da sessão: o campo organizationId da entrada é ignorado", async () => {
    await iniciarAssinatura({ ...ENTRADA, cupom: "PCT10", organizationId: "99999999-9999-4999-8999-999999999999" } as never);
    expect(chamadasIniciar[0]).toMatchObject({ organizationId: ORG });
  });

  it("papel sem poder não chega a gastar tentativa de cupom nem a chamar iniciarCompra", async () => {
    papel = "agent";
    const r = await iniciarAssinatura({ ...ENTRADA, cupom: "PCT10" });
    expect(r.tipo).toBe("erro");
    expect(chamadasIniciar).toEqual([]);
    expect(contadores.size).toBe(0);
  });

  it("a auditoria leva o código e o desconto do cupom, e nunca o pagador", async () => {
    resultadoIniciar = {
      tipo: "redirecionar",
      url: "https://sandbox.asaas.com/i/fake",
      cupom: { codigo: "PCT10", descontoCents: 10490 },
    };
    await iniciarAssinatura({
      ...ENTRADA,
      cupom: "pct10",
      pagador: { nome: "Fulano de Tal", documento: "111.444.777-35", email: "fulano@example.com" },
    });
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0]?.action).toBe("billing.order_created");
    const metadata = auditadas[0]?.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({ cupom: "PCT10", desconto_cents: 10490, plan_code: "pro" });
    expect(JSON.stringify(metadata)).not.toMatch(/Fulano|111\.444|fulano@/);
  });

  it("sem cupom na resposta, a auditoria não ganha campos de cupom", async () => {
    await iniciarAssinatura(ENTRADA);
    const metadata = auditadas[0]?.metadata as Record<string, unknown>;
    expect("cupom" in metadata).toBe(false);
    expect("desconto_cents" in metadata).toBe(false);
  });

  it("teto de tentativas por usuário: depois de 20 com cupom na janela, a próxima é barrada antes de iniciarCompra", async () => {
    for (let i = 0; i < 20; i += 1) {
      await iniciarAssinatura({ ...ENTRADA, cupom: "PCT10" });
    }
    expect(chamadasIniciar).toHaveLength(20);
    const r = await iniciarAssinatura({ ...ENTRADA, cupom: "PCT10" });
    expect(r).toEqual({ tipo: "erro", mensagem: "Muitas tentativas com cupom. Aguarde alguns minutos e tente de novo." });
    expect(chamadasIniciar).toHaveLength(20);
    // Outro usuário não é afetado, e a compra SEM cupom também não gasta tentativa.
    usuarioAtual = OUTRO_USER;
    expect((await iniciarAssinatura({ ...ENTRADA, cupom: "PCT10" })).tipo).toBe("redirecionar");
    usuarioAtual = USER;
    expect((await iniciarAssinatura(ENTRADA)).tipo).toBe("redirecionar");
  });
});

describe("simularCupom", () => {
  it("devolve a simulação do banco em reais e centavos, com a organização da sessão", async () => {
    const r = await simularCupom(SIMULACAO);
    expect(r).toEqual({
      tipo: "ok",
      codigo: "PCT10",
      tipoDoDesconto: "percentual",
      valor: 10,
      precoCheioCents: 104900,
      descontoCents: 10490,
      totalCents: 94410,
      parcelas: 1,
      totalFinalCents: 94410,
    });
    expect(chamadasSimular).toEqual([{ org: ORG, codigo: "PCT10", planCode: "pro", ciclo: "semiannual", parcelas: 1 }]);
  });

  it("parcelado: manda as parcelas e devolve o total com juros do banco", async () => {
    respostaSimulacao = { data: { ...OK_DO_BANCO, parcelas: 4, total_final_cents: 99000 }, error: null };
    const r = await simularCupom({ ...SIMULACAO, parcelas: 4 });
    expect(r).toMatchObject({ tipo: "ok", parcelas: 4, totalCents: 94410, totalFinalCents: 99000 });
    expect(chamadasSimular[0]).toMatchObject({ parcelas: 4 });
  });

  it("parcelas no Pix são recusadas antes de ir ao banco", async () => {
    const r = await simularCupom({ ...SIMULACAO, metodo: "PIX", parcelas: 4 });
    expect(r.tipo).toBe("erro");
    expect(chamadasSimular).toEqual([]);
  });

  it("cada erro do banco vira a sua frase", async () => {
    const casos: Array<[string, string]> = [
      ["billing_cupom_invalido", "Cupom inválido ou indisponível para esta compra."],
      ["billing_cupom_expirado", "Cupom inválido ou indisponível para esta compra."],
      ["billing_cupom_esgotado", "Cupom inválido ou indisponível para esta compra."],
      ["billing_cupom_nao_vale_para_o_plano", "Cupom inválido ou indisponível para esta compra."],
      ["billing_cupom_nao_vale_para_o_ciclo", "Cupom inválido ou indisponível para esta compra."],
      ["billing_cupom_ja_usado", "Este cupom já foi utilizado por você ou pela sua organização."],
      ["billing_cupom_sem_desconto", "Este cupom não dá desconto neste plano."],
      ["billing_cupom_parcela_minima", "Com este desconto, escolha menos parcelas."],
      ["plano_nao_encontrado_ou_inativo", "Oferta não encontrada."],
      ["billing_plano_fora_de_venda", "Este plano não está disponível para compra no momento."],
    ];
    for (const [erro, frase] of casos) {
      respostaSimulacao = { data: { ok: false, erro }, error: null };
      expect(await simularCupom(SIMULACAO), erro).toEqual({ tipo: "erro", mensagem: frase });
    }
  });

  it("falha de banco ou erro desconhecido dá a frase genérica da simulação, nunca o texto cru", async () => {
    respostaSimulacao = { data: null, error: { code: "XX000", message: "connection refused to 10.0.0.5" } };
    const r = await simularCupom(SIMULACAO);
    expect(r).toEqual({ tipo: "erro", mensagem: "Não foi possível conferir o cupom agora. Tente novamente em instantes." });
    respostaSimulacao = { data: { ok: false, erro: "algo_novo" }, error: null };
    expect((await simularCupom(SIMULACAO)).tipo).toBe("erro");
  });

  it("mesmo gate da compra: papel sem poder, compra desligada e Asaas desligado", async () => {
    papel = "viewer";
    expect((await simularCupom(SIMULACAO)).tipo).toBe("erro");
    papel = "admin";
    compraLigadaValor = false;
    expect(await simularCupom(SIMULACAO)).toEqual({ tipo: "erro", mensagem: "A compra pela tela ainda não está disponível. Fale com o suporte." });
    compraLigadaValor = true;
    habilitado = false;
    expect((await simularCupom(SIMULACAO)).tipo).toBe("erro");
    expect(chamadasSimular).toEqual([]);
  });

  it("entrada inválida: código fora do formato tem frase própria, o resto a genérica, e nada vai ao banco", async () => {
    expect(await simularCupom({ ...SIMULACAO, codigo: "a" })).toEqual({ tipo: "erro", mensagem: "Cupom inválido ou indisponível para esta compra." });
    expect(await simularCupom({ ...SIMULACAO, ciclo: "semanal" as never })).toEqual({ tipo: "erro", mensagem: "Dados inválidos. Confira o formulário e tente de novo." });
    expect(await simularCupom({ ...SIMULACAO, parcelas: 13 })).toEqual({ tipo: "erro", mensagem: "Dados inválidos. Confira o formulário e tente de novo." });
    expect(chamadasSimular).toEqual([]);
  });

  it("limite de tentativas por usuário: a 21ª simulação na janela é barrada sem ir ao banco, e o limite é por usuário", async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await simularCupom({ ...SIMULACAO, codigo: `CHUTE${i}` })).tipo).toBe("ok");
    }
    expect(chamadasSimular).toHaveLength(20);
    expect(await simularCupom(SIMULACAO)).toEqual({ tipo: "erro", mensagem: "Muitas tentativas com cupom. Aguarde alguns minutos e tente de novo." });
    expect(chamadasSimular).toHaveLength(20);
    usuarioAtual = OUTRO_USER;
    expect((await simularCupom(SIMULACAO)).tipo).toBe("ok");
  });

  it("simulação e compra com cupom dividem o mesmo teto (não há um caminho sem limite para adivinhar códigos)", async () => {
    for (let i = 0; i < 10; i += 1) await simularCupom({ ...SIMULACAO, codigo: `SIM${i}` });
    for (let i = 0; i < 10; i += 1) await iniciarAssinatura({ ...ENTRADA, cupom: `COMPRA${i}` });
    expect(await iniciarAssinatura({ ...ENTRADA, cupom: "UMAMAIS" })).toMatchObject({ tipo: "erro", mensagem: expect.stringContaining("Muitas tentativas") });
    expect((await simularCupom(SIMULACAO)).tipo).toBe("erro");
  });

  it("a chave do limitador não guarda o id do usuário nem o da organização em claro", async () => {
    await simularCupom(SIMULACAO);
    const chaves = [...contadores.keys()];
    expect(chaves.length).toBeGreaterThan(0);
    for (const chave of chaves) {
      expect(chave).not.toContain(USER);
      expect(chave).not.toContain(ORG);
    }
  });

  it("o teto também é por ORGANIZAÇÃO: usuários diferentes da mesma empresa dividem 40 tentativas por janela", async () => {
    const usuarios = [USER, OUTRO_USER];
    for (let i = 0; i < 40; i += 1) {
      usuarioAtual = usuarios[i % 2] as string;
      expect((await simularCupom({ ...SIMULACAO, codigo: `ORG${i}` })).tipo, `tentativa ${i}`).toBe("ok");
    }
    expect(chamadasSimular).toHaveLength(40);
    // Cada usuário gastou só 20 (o teto individual), mas a empresa gastou as 40: a 41ª é barrada para qualquer um.
    usuarioAtual = USER;
    expect(await simularCupom(SIMULACAO)).toEqual({ tipo: "erro", mensagem: "Muitas tentativas com cupom. Aguarde alguns minutos e tente de novo." });
    usuarioAtual = OUTRO_USER;
    expect((await simularCupom(SIMULACAO)).tipo).toBe("erro");
    expect(chamadasSimular).toHaveLength(40);
  });

  it("a compra com cupom também respeita o teto da organização", async () => {
    const usuarios = [USER, OUTRO_USER];
    for (let i = 0; i < 40; i += 1) {
      usuarioAtual = usuarios[i % 2] as string;
      await simularCupom({ ...SIMULACAO, codigo: `ORG${i}` });
    }
    usuarioAtual = USER;
    expect(await iniciarAssinatura({ ...ENTRADA, cupom: "PCT10" })).toMatchObject({ tipo: "erro", mensagem: expect.stringContaining("Muitas tentativas") });
    expect(chamadasIniciar).toEqual([]);
  });

  it("parcela mínima na simulação: a tela recebe a frase para avisar", async () => {
    respostaSimulacao = { data: { ok: false, erro: "billing_cupom_parcela_minima" }, error: null };
    expect(await simularCupom({ ...SIMULACAO, parcelas: 6 })).toEqual({ tipo: "erro", mensagem: "Com este desconto, escolha menos parcelas." });
  });
});
