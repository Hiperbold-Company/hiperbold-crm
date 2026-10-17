/**
 * D-215, proteção contra reenvio na captação assinada (`POST /api/v1/webhooks/in/[token]`).
 *
 * Um envio assinado que alguém capturou podia ser reenviado para sempre: o HMAC cobria só o corpo. Agora o envio
 * pode levar `X-HiperCRM-Timestamp` (segundos Unix) e a assinatura passa a cobrir `${carimbo}.${corpo}`, com
 * janela de 300 s. A fonte liga sozinha a exigência do carimbo (`exige_carimbo`) no primeiro envio válido com
 * carimbo, para o n8n que assina sem carimbo não quebrar no dia da atualização.
 *
 * A rota roda de verdade sobre o banco em memória; só as bordas são simuladas (segredo, lead, limite por IP).
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria } from "../helpers/banco-em-memoria";

const ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN = "token-da-fonte-assinada";
const SEGREDO = "segredo-da-fonte-de-teste";
const CORPO = JSON.stringify({ name: "Maria", phone: "+5511999990000" });

let banco: BancoEmMemoria;
let seqLead = 0;
const auditorias: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (entrada: Record<string, unknown>) => {
    auditorias.push(entrada);
  }),
}));
vi.mock("@/lib/logger", () => {
  const nada = () => undefined;
  return { logger: { info: nada, warn: nada, error: nada, debug: nada } };
});
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => SEGREDO) }));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefoneComNome: vi.fn(async () => null),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: vi.fn(async (_admin: unknown, _ctx: unknown, input: Record<string, unknown>) => {
    seqLead += 1;
    const lead = { id: `lead-${seqLead}`, organization_id: ORG, ...input };
    banco.tabelas["crm_leads"]!.push(lead);
    return { id: lead.id };
  }),
}));
vi.mock("@/lib/leads/aviso-limite-de-leads", () => ({ avisarLimiteDeLeadsAtingido: vi.fn(async () => undefined) }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: vi.fn(async () => undefined) }));

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

const agora = () => Math.floor(Date.now() / 1000);
const hmac = (texto: string) => createHmac("sha256", SEGREDO).update(texto).digest("hex");

function montar(exigeCarimbo: boolean) {
  banco = criarBancoEmMemoria({
    webhook_sources: [
      {
        id: "fonte-1",
        name: "Landing",
        organization_id: ORG,
        path_token: TOKEN,
        secret_encrypted: "cifrado",
        exige_carimbo: exigeCarimbo,
        default_pipeline_id: "funil-1",
        default_stage_id: "etapa-1",
        field_map: {},
        redirect_to: null,
        is_active: true,
      },
    ],
    webhook_events_log: [],
    crm_leads: [],
    crm_lead_activities: [],
    webhook_lead_captures: [],
    agent_inbox_items: [],
    contacts: [],
  });
}

const exige = () => banco.tabelas["webhook_sources"]![0]!.exige_carimbo;

/** Manda `CORPO` com a assinatura e os cabeçalhos pedidos. */
function enviar(cabecalhos: Record<string, string>) {
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...cabecalhos },
    body: CORPO,
  });
  return POST(req, { params: Promise.resolve({ token: TOKEN }) });
}

/** Envio no formato novo: carimbo + assinatura de `${carimbo}.${corpo}`. */
const comCarimbo = (carimbo: number, assinadoCom: number = carimbo) =>
  enviar({
    "x-hipercrm-timestamp": String(carimbo),
    "x-hipercrm-signature": hmac(`${assinadoCom}.${CORPO}`),
  });

/** Envio no formato antigo: só o corpo assinado. */
const semCarimbo = () => enviar({ "x-hipercrm-signature": hmac(CORPO) });

beforeEach(() => {
  seqLead = 0;
  auditorias.length = 0;
});

describe("captação assinada com carimbo (D-215)", () => {
  it("assinatura de `carimbo.corpo` com carimbo recente é aceita", async () => {
    montar(false);
    const r = await comCarimbo(agora());
    expect(r.status).toBe(200);
    expect(banco.tabelas["crm_leads"]).toHaveLength(1);
  });

  it("carimbo velho (mais de 300 s) é recusado com a recusa neutra e não cria lead", async () => {
    montar(false);
    const r = await comCarimbo(agora() - 301);
    expect(r.status).toBe(401);
    expect((await r.json()).error.message).toBe("invalid_signature");
    expect(banco.tabelas["crm_leads"]).toHaveLength(0);
    expect(auditorias.at(-1)).toMatchObject({
      action: "webhook.inbound_invalid_signature",
      metadata: { motivo: "carimbo_fora_da_janela" },
    });
  });

  it("carimbo do futuro (mais de 300 s adiante) também é recusado", async () => {
    montar(false);
    const r = await comCarimbo(agora() + 400);
    expect(r.status).toBe(401);
    expect(banco.tabelas["crm_leads"]).toHaveLength(0);
  });

  it("carimbo dentro da janela, para os dois lados, é aceito", async () => {
    montar(false);
    expect((await comCarimbo(agora() - 290)).status).toBe(200);
    expect((await comCarimbo(agora() + 290)).status).toBe(200);
  });

  it("carimbo trocado depois de assinado (assinatura não cobre o carimbo enviado) é recusado", async () => {
    montar(false);
    const r = await comCarimbo(agora(), agora() - 10);
    expect(r.status).toBe(401);
  });

  it("carimbo que não é segundos Unix (milissegundos, texto) é recusado", async () => {
    montar(false);
    expect((await comCarimbo(Date.now())).status).toBe(401);
    const r = await enviar({ "x-hipercrm-timestamp": "ontem", "x-hipercrm-signature": hmac(`ontem.${CORPO}`) });
    expect(r.status).toBe(401);
  });

  it("assinatura só do corpo com um carimbo no cabeçalho é recusada (não vale o formato antigo)", async () => {
    montar(false);
    const r = await enviar({ "x-hipercrm-timestamp": String(agora()), "x-hipercrm-signature": hmac(CORPO) });
    expect(r.status).toBe(401);
  });
});

describe("catraca: a fonte passa a exigir o carimbo", () => {
  it("sem carimbo e exige_carimbo=false, o comportamento de hoje continua: aceita e NÃO liga a catraca", async () => {
    montar(false);
    const r = await semCarimbo();
    expect(r.status).toBe(200);
    expect(exige()).toBe(false);
  });

  it("o primeiro envio válido com carimbo liga exige_carimbo", async () => {
    montar(false);
    expect((await comCarimbo(agora())).status).toBe(200);
    expect(exige()).toBe(true);
  });

  it("depois da catraca, a assinatura antiga (só o corpo) é recusada e não cria lead", async () => {
    montar(false);
    expect((await comCarimbo(agora())).status).toBe(200);
    const r = await semCarimbo();
    expect(r.status).toBe(401);
    expect(banco.tabelas["crm_leads"]).toHaveLength(1);
    expect(auditorias.at(-1)).toMatchObject({ metadata: { motivo: "carimbo_ausente" } });
  });

  it("com exige_carimbo=true, o envio com carimbo válido segue aceito", async () => {
    montar(true);
    expect((await comCarimbo(agora())).status).toBe(200);
  });

  it("envio com carimbo e assinatura ERRADA não liga a catraca", async () => {
    montar(false);
    const r = await enviar({ "x-hipercrm-timestamp": String(agora()), "x-hipercrm-signature": "00".repeat(32) });
    expect(r.status).toBe(401);
    expect(exige()).toBe(false);
  });

  it("envio com carimbo velho não liga a catraca", async () => {
    montar(false);
    expect((await comCarimbo(agora() - 1000)).status).toBe(401);
    expect(exige()).toBe(false);
  });
});
