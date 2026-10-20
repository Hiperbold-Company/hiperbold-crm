/**
 * Captação (`POST /api/v1/webhooks/in/[token]`): o lead nasce com os campos do funil nas chaves certas.
 *
 * O n8n da CBEXS manda `Empresa`, `Cargo` e `utm_*` com o RÓTULO; o funil declara `empresa`, `cargo`
 * ("Cargo / Posição") e `utm_source`, e a ficha do negócio lê pela `key`. A rota, o mapeador e o encaixe
 * rodam de verdade sobre o banco em memória; só as bordas são simuladas (criação do lead, segredo, limite
 * por IP, audit, logger) — o que se confere é o `custom_fields` que chega à criação do lead.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { criarBancoEmMemoria, type BancoEmMemoria, type Linha } from "../helpers/banco-em-memoria";

const ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN = "token-publico-da-landing";
const FUNIL = "funil-da-fonte";

let banco: BancoEmMemoria;
let seqLead = 0;
const leadsCriados: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => {
  const nada = () => undefined;
  return { logger: { info: nada, warn: nada, error: nada, debug: nada } };
});
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => null) }));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefoneComNome: vi.fn(async () => null),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: vi.fn(async (_admin: unknown, _ctx: unknown, input: Record<string, unknown>) => {
    leadsCriados.push(input);
    seqLead += 1;
    const lead = {
      id: `lead-novo-${seqLead}`,
      organization_id: ORG,
      contact_id: input.contact_id ?? null,
      pipeline_id: input.pipeline_id,
      stage_id: input.stage_id,
      status: "open",
      source: "webhook",
      tags: input.tags ?? [],
      custom_fields: input.custom_fields ?? {},
      external_id: input.external_id ?? null,
      last_activity_at: null,
      created_at: new Date().toISOString(),
    };
    banco.tabelas["crm_leads"]!.push(lead);
    return { id: lead.id };
  }),
}));
vi.mock("@/lib/leads/aviso-limite-de-leads", () => ({ avisarLimiteDeLeadsAtingido: vi.fn(async () => undefined) }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: vi.fn(async () => undefined) }));

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

const CAMPOS_DO_FUNIL = [
  { key: "empresa", label: "Empresa", type: "text" },
  { key: "cargo", label: "Cargo / Posição", type: "text" },
  { key: "utm_source", label: "utm_source", type: "text" },
  { key: "utm_campaign", label: "utm_campaign", type: "text" },
];

function montar(opcoes: { pipelines?: Linha[]; leads?: Linha[] } = {}) {
  banco = criarBancoEmMemoria(
    {
      webhook_sources: [
        {
          id: "fonte-1",
          name: "n8n da CBEXS",
          organization_id: ORG,
          path_token: TOKEN,
          secret_encrypted: null,
          default_pipeline_id: FUNIL,
          default_stage_id: "etapa-entrada",
          field_map: {},
          redirect_to: null,
          is_active: true,
        },
      ],
      crm_pipelines: opcoes.pipelines ?? [
        { id: FUNIL, organization_id: ORG, settings: { fields: CAMPOS_DO_FUNIL } },
      ],
      webhook_events_log: [],
      crm_leads: opcoes.leads ?? [],
      crm_lead_activities: [],
      webhook_lead_captures: [],
      agent_inbox_items: [],
      contacts: [],
    },
    {
      aoEscrever: {
        contacts: (modo, linhas) => {
          if (modo === "insert") for (const l of linhas) l.id ??= `contato-novo-${++seqLead}`;
          return null;
        },
      },
    },
  );
}

function enviar(corpo: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify(corpo),
  });
  return POST(req, { params: Promise.resolve({ token: TOKEN }) });
}

beforeEach(() => {
  seqLead = 0;
  leadsCriados.length = 0;
  montar();
});

describe("captação: campos do funil", () => {
  it("o corpo do n8n grava empresa, cargo e UTMs nas keys do funil, e a origem segue com as UTMs", async () => {
    const r = await enviar({
      nome: "Maria Teste",
      email: "maria@teste.com",
      external_id: "ext-1",
      Empresa: "Hiperbold",
      Cargo: "Diretor",
      utm_source: "teste",
      utm_campaign: "x",
      tags: ["govClin2027"],
    });
    expect(r.status).toBe(200);
    expect(leadsCriados).toHaveLength(1);
    const lead = leadsCriados[0]!;
    expect(lead.custom_fields).toEqual({
      empresa: "Hiperbold",
      cargo: "Diretor",
      utm_source: "teste",
      utm_campaign: "x",
    });
    expect(lead.source_metadata).toMatchObject({ utm_source: "teste", utm_campaign: "x" });
  });

  it("campo sem correspondente no funil entra com a chave como veio", async () => {
    await enviar({ nome: "Maria", email: "maria@teste.com", Empresa: "Hiperbold", Hobby: "xadrez" });
    expect(leadsCriados[0]!.custom_fields).toEqual({ empresa: "Hiperbold", Hobby: "xadrez" });
  });

  it("UTM sem campo declarado fica só na origem", async () => {
    await enviar({ nome: "Maria", email: "maria@teste.com", utm_medium: "cpc" });
    expect(leadsCriados[0]!.custom_fields).toEqual({});
    expect(leadsCriados[0]!.source_metadata).toMatchObject({ utm_medium: "cpc" });
  });

  it("funil sem campos declarados: o lead entra com os campos como vieram (comportamento de antes)", async () => {
    montar({ pipelines: [{ id: FUNIL, organization_id: ORG, settings: {} }] });
    await enviar({ nome: "Maria", email: "maria@teste.com", Empresa: "Hiperbold" });
    expect(leadsCriados[0]!.custom_fields).toEqual({ Empresa: "Hiperbold" });
  });

  it("o funil de outra organização não é lido (filtro por organização)", async () => {
    montar({
      pipelines: [{ id: FUNIL, organization_id: "outra-org", settings: { fields: CAMPOS_DO_FUNIL } }],
    });
    await enviar({ nome: "Maria", email: "maria@teste.com", Empresa: "Hiperbold" });
    expect(leadsCriados[0]!.custom_fields).toEqual({ Empresa: "Hiperbold" });
  });

  it("o histórico de captação guarda o que chegou, do jeito que chegou", async () => {
    await enviar({ nome: "Maria", email: "maria@teste.com", external_id: "ext-2", Empresa: "Hiperbold" });
    const capturas = banco.tabelas["webhook_lead_captures"] ?? [];
    expect(capturas).toHaveLength(1);
    const guardado = JSON.stringify(capturas[0]);
    expect(guardado).toContain('"Empresa"');
    expect(guardado).not.toContain('"empresa"');
    expect(leadsCriados[0]!.custom_fields).toEqual({ empresa: "Hiperbold" });
  });
});
