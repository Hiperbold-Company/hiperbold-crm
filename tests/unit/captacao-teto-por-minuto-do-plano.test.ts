/**
 * D-227: a fonte de dados (`POST /api/v1/webhooks/in/[token]`) recebe por
 * minuto o que o plano diz (`fonte_dados_req_min`: Pro 60, Max 60, Scale 120),
 * POR FONTE (por token), nunca por organização.
 *
 * A ordem que se mede:
 *  - o balde do token conta ANTES de qualquer leitura, e o token que não
 *    existe nunca chega à leitura do plano;
 *  - resolvida a fonte, o MESMO contador do token é comparado com o valor do
 *    plano (`null` = 120, o teto do pré-filtro): o Scale chega a 120 numa
 *    fonte, o Pro para em 60;
 *  - não existe balde por organização: esgotar uma fonte (token público no
 *    HTML) não afeta outra fonte da mesma organização;
 *  - leitura do plano que falha fica em 60 por fonte;
 *  - toda recusa por teto tem a MESMA mensagem (não revela plano nem estado).
 *
 * Dublês só na borda: banco em memória, leitura do plano, contador de janela.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria } from "../helpers/banco-em-memoria";

const ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN = "token-publico-da-landing";
const OUTRO_TOKEN = "token-de-outra-fonte-da-org";

let banco: BancoEmMemoria;
let limitesDoPlano: Record<string, number | null> = {};
let leituraFalha = false;
const baldes = new Map<string, number>();

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/billing/planos/plano-da-organizacao", () => ({
  planoDaOrganizacao: vi.fn(async () => ({
    plano: { code: "x", name: "X", version: 2 },
    contrato: null,
    limites: leituraFalha ? {} : limitesDoPlano,
    leituraFalhou: leituraFalha,
  })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async (chave: string, limite: number) => {
    const n = (baldes.get(chave) ?? 0) + 1;
    baldes.set(chave, n);
    return { allowed: n <= limite, count: n, limit: limite, window_sec: 60, window_start: 0 };
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => null) }));
vi.mock("@/lib/webhooks/captacao", () => ({
  origemDaPagina: () => null,
  registrarCaptacao: vi.fn(async () => undefined),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefoneComNome: vi.fn(async () => ({ id: "contato-1", name: "Maria" })),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: vi.fn(async () => ({ id: "lead-1" })),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/leads/aviso-limite-de-leads", () => ({ avisarLimiteDeLeadsAtingido: vi.fn(async () => undefined) }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: vi.fn(async () => undefined) }));

const { POST } = await import("@/app/api/v1/webhooks/in/[token]/route");
const { planoDaOrganizacao } = await import("@/lib/billing/planos/plano-da-organizacao");
const { checkRateLimit } = await import("@/lib/ai/dispatcher/rate-limit");
const { esquecerTudo } = await import("@/lib/auth/cache-curto");

/** Cada envio de um IP diferente, para o balde por IP (10/min) não interferir. */
let ip = 0;
function chamar(token = TOKEN) {
  ip += 1;
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.${ip >> 8}.${ip & 255}` },
    body: JSON.stringify({ name: "Maria", phone: "+5511999990000" }),
  });
  return POST(req, { params: Promise.resolve({ token }) });
}

/** Põe o contador do token como se `n` envios já tivessem passado nesta janela. */
function jaPassaram(n: number, token = TOKEN) {
  baldes.set(`webhook_in:${token}`, n);
}

beforeEach(() => {
  vi.clearAllMocks();
  esquecerTudo();
  baldes.clear();
  leituraFalha = false;
  limitesDoPlano = {};
  banco = criarBancoEmMemoria({
    webhook_sources: [
      {
        id: "fonte-1",
        name: "Landing",
        organization_id: ORG,
        path_token: TOKEN,
        secret_encrypted: null,
        default_pipeline_id: "p1",
        default_stage_id: "e1",
        field_map: {},
        redirect_to: null,
        is_active: true,
      },
      {
        id: "fonte-2",
        name: "Formulário do site",
        organization_id: ORG,
        path_token: OUTRO_TOKEN,
        secret_encrypted: null,
        default_pipeline_id: "p1",
        default_stage_id: "e1",
        field_map: {},
        redirect_to: null,
        is_active: true,
      },
    ],
    webhook_events_log: [],
    crm_leads: [],
    contacts: [{ id: "contato-1", organization_id: ORG, name: "Maria" }],
  });
});

describe("D-227: teto por minuto da fonte de dados pelo plano", () => {
  it("⭐ Scale (120): o 120º envio de um token só passa, o 121º é 429 com X-RateLimit-*", async () => {
    limitesDoPlano = { fonte_dados_req_min: 120 };
    jaPassaram(119);

    const centesimoVigesimo = await chamar();
    expect(centesimoVigesimo.status).not.toBe(429);

    const seguinte = await chamar();
    expect(seguinte.status).toBe(429);
    expect(seguinte.headers.get("Retry-After")).toBeTruthy();
    expect(seguinte.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it("⭐ Pro (60): o 61º envio do token é 429, com X-RateLimit-Limit 60", async () => {
    limitesDoPlano = { fonte_dados_req_min: 60 };
    jaPassaram(59);

    expect((await chamar()).status).not.toBe(429);
    const seguinte = await chamar();
    expect(seguinte.status).toBe(429);
    expect(seguinte.headers.get("X-RateLimit-Limit")).toBe("60");
  });

  it("⭐ esgotar uma fonte NÃO afeta outra fonte da mesma organização", async () => {
    limitesDoPlano = { fonte_dados_req_min: 60 };
    jaPassaram(60);

    const esgotada = await chamar();
    expect(esgotada.status).toBe(429);

    const outra = await chamar(OUTRO_TOKEN);
    expect(outra.status).not.toBe(429);
    expect(vi.mocked(checkRateLimit).mock.calls.some(([chave]) => chave.startsWith("webhook_in_org:"))).toBe(false);
  });

  it("todas as recusas por teto dizem a mesma coisa, sem revelar plano nem estado", async () => {
    limitesDoPlano = { fonte_dados_req_min: 60 };
    jaPassaram(120);
    const noPreFiltro = await (await chamar()).json();

    jaPassaram(60);
    const noPlano = await (await chamar()).json();

    expect(noPreFiltro.error.message).toBe("Too many requests.");
    expect(noPlano.error.message).toBe("Too many requests.");
  });

  it("⭐ token que não existe não consulta o plano", async () => {
    limitesDoPlano = { fonte_dados_req_min: 60 };
    const r = await chamar("token-que-nao-existe");

    expect(r.status).toBe(404);
    expect(planoDaOrganizacao).not.toHaveBeenCalled();
  });

  it("o balde do token conta antes de qualquer leitura: acima de 120 nem a fonte é lida", async () => {
    const consultas = vi.spyOn(banco, "from");
    jaPassaram(120);

    const r = await chamar();

    expect(r.status).toBe(429);
    expect(consultas).not.toHaveBeenCalled();
    expect(planoDaOrganizacao).not.toHaveBeenCalled();
  });

  it("leitura do plano que falha fica em 60 por fonte", async () => {
    leituraFalha = true;
    jaPassaram(60);

    const r = await chamar();

    expect(r.status).toBe(429);
    expect(r.headers.get("X-RateLimit-Limit")).toBe("60");
  });

  it("plano sem limite (null) vale o teto do pré-filtro: 120 passa, 121 é 429", async () => {
    limitesDoPlano = { fonte_dados_req_min: null };
    jaPassaram(119);

    expect((await chamar()).status).not.toBe(429);
    const seguinte = await chamar();
    expect(seguinte.status).toBe(429);
    expect(seguinte.headers.get("X-RateLimit-Limit")).toBe("120");
  });
});
