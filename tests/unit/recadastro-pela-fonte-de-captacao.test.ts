/**
 * RECADASTRO pela fonte de captação (decisão do dono do produto, 16/10/2026):
 * `POST /api/v1/webhooks/in/[token]` não cria um segundo lead para quem já tem
 * um ABERTO no funil padrão da fonte.
 *
 * A rota, a decisão, o registro de captação e a atividade da timeline rodam de
 * verdade sobre um banco em memória com a semântica de filtro do PostgREST. Só
 * as bordas são simuladas: a criação do lead (`createLeadHandler`, que aqui só
 * grava a linha em `crm_leads` para o próximo envio enxergá-la), o limite por
 * IP, o segredo da fonte, o audit e o motor local de eventos.
 *
 * O que se prova é o COMPORTAMENTO: quantos leads existem depois, em que etapa
 * ficaram, o que a timeline e o histórico de captação registraram, o que a
 * resposta devolveu e o que NÃO disparou.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { criarBancoEmMemoria, type BancoEmMemoria, type Linha } from "../helpers/banco-em-memoria";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const TOKEN = "token-publico-da-landing";
const FUNIL = "funil-da-fonte";
const ETAPA_ENTRADA = "etapa-entrada";
const OUTRO_FUNIL = "outro-funil";
const TELEFONE = "+5511999990000";

let banco: BancoEmMemoria;
let sequencia = 0;
let seqLead = 0;
let planoNoLimite = false;
const leadsCriados: Array<Record<string, unknown>> = [];
const auditorias: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (entrada: Record<string, unknown>) => {
    auditorias.push(entrada);
  }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => null) }));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefoneComNome: vi.fn(async (_admin: unknown, org: string, telefone: string) => {
    const achado = (banco.tabelas["contacts"] ?? []).find(
      (c) => c.organization_id === org && c.phone_number === telefone && c.is_merged_into == null,
    );
    return achado ? { id: achado.id as string, name: achado.name as string } : null;
  }),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: vi.fn(async (_admin: unknown, _ctx: unknown, input: Record<string, unknown>) => {
    if (planoNoLimite) throw new ApiError(402, "plan_limit", undefined, "req", "limite do plano");
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
import { kickLocalPipeline } from "@/lib/dev/kick-local-pipeline";

function chamar(campos: Record<string, string>, opts: { formulario?: boolean } = {}) {
  const corpo = opts.formulario ? new URLSearchParams(campos).toString() : JSON.stringify(campos);
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    headers: {
      "content-type": opts.formulario ? "application/x-www-form-urlencoded" : "application/json",
      "x-forwarded-for": "203.0.113.7",
    },
    body: corpo,
  });
  return POST(req, { params: Promise.resolve({ token: TOKEN }) });
}

function leadExistente(parcial: Linha): Linha {
  return {
    organization_id: ORG,
    contact_id: "contato-1",
    pipeline_id: FUNIL,
    stage_id: "etapa-meio",
    status: "open",
    source: "manual",
    external_id: null,
    last_activity_at: null,
    created_at: "2026-10-01T10:00:00.000Z",
    ...parcial,
  };
}

const leads = () => banco.tabelas["crm_leads"]!;
const atividades = () => banco.tabelas["crm_lead_activities"] ?? [];
const captacoes = () => banco.tabelas["webhook_lead_captures"] ?? [];

function montar(extras: { leads?: Linha[]; contatos?: Linha[]; redirect_to?: string | null } = {}) {
  banco = criarBancoEmMemoria(
    {
      webhook_sources: [
        {
          id: "fonte-1",
          name: "Landing de Outubro",
          organization_id: ORG,
          path_token: TOKEN,
          secret_encrypted: null,
          default_pipeline_id: FUNIL,
          default_stage_id: ETAPA_ENTRADA,
          field_map: {},
          redirect_to: extras.redirect_to ?? null,
          is_active: true,
        },
      ],
      webhook_events_log: [],
      crm_leads: extras.leads ?? [],
      crm_lead_activities: [],
      webhook_lead_captures: [],
      contacts: extras.contatos ?? [
        { id: "contato-1", organization_id: ORG, name: "Maria", phone_number: TELEFONE, is_merged_into: null },
      ],
    },
    {
      aoEscrever: {
        // O banco real gera o id do contato novo; o em memória não.
        contacts: (_modo, linhas) => {
          for (const l of linhas) l.id ??= `contato-novo-${++sequencia}`;
          return null;
        },
      },
    },
  );
}

beforeEach(() => {
  sequencia = 0;
  seqLead = 0;
  planoNoLimite = false;
  leadsCriados.length = 0;
  auditorias.length = 0;
  vi.mocked(kickLocalPipeline).mockClear();
});

describe("recadastro: lead ABERTO do contato no funil da fonte", () => {
  beforeEach(() => {
    montar({ leads: [leadExistente({ id: "lead-aberto" })] });
  });

  it("não cria lead, não mexe na etapa e responde 200 com o lead que já existe", async () => {
    const r = await chamar({ nome: "Maria Souza", telefone: "11999990000", email: "maria@exemplo.com" });

    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ lead_id: "lead-aberto" });
    expect(leadsCriados).toHaveLength(0);
    expect(leads()).toHaveLength(1);
    expect(leads()[0]).toMatchObject({ id: "lead-aberto", stage_id: "etapa-meio", status: "open" });
  });

  it("registra o recadastro na timeline do lead com o que chegou, sem PII no texto", async () => {
    await chamar({ nome: "Maria Souza", telefone: "11999990000", email: "maria@exemplo.com", cidade: "Varginha" });

    expect(atividades()).toHaveLength(1);
    const a = atividades()[0]!;
    expect(a).toMatchObject({
      organization_id: ORG,
      lead_id: "lead-aberto",
      contact_id: "contato-1",
      type: "lead_reregistered",
      source_module: "webhook",
      source_id: "fonte-1",
    });
    expect(a.reason).toBe("Cadastrou-se de novo pela fonte Landing de Outubro.");
    expect(a.reason).not.toContain("maria@exemplo.com");
    expect(a.payload).toMatchObject({
      webhook_source_id: "fonte-1",
      source_name: "Landing de Outubro",
      recebido: {
        nome: "Maria Souza",
        telefone: TELEFONE,
        email: "maria@exemplo.com",
        campos: { cidade: "Varginha" },
      },
    });
  });

  it("grava no histórico de captação o desfecho `recadastro`, ligado ao lead e ao contato", async () => {
    await chamar({ nome: "Maria", telefone: "11999990000" });

    expect(captacoes()).toHaveLength(1);
    expect(captacoes()[0]).toMatchObject({
      outcome: "recadastro",
      lead_id: "lead-aberto",
      contact_id: "contato-1",
      source_name: "Landing de Outubro",
      captured_phone: TELEFONE,
    });
  });

  it("audita `webhook.lead_reregistered` (e não `lead_received`) e marca o recebimento da fonte", async () => {
    await chamar({ nome: "Maria", telefone: "11999990000" });

    expect(auditorias.map((a) => a.action)).toEqual(["webhook.lead_reregistered"]);
    expect(auditorias[0]).toMatchObject({ organizationId: ORG, resourceType: "crm_lead", resourceId: "lead-aberto" });
    expect(banco.tabelas["webhook_sources"]![0]!.last_received_at).toBeTruthy();
  });

  it("não dispara o que é de lead novo: nenhuma criação, nenhum motor de evento de 1º toque", async () => {
    await chamar({ nome: "Maria", telefone: "11999990000" });

    expect(leadsCriados).toHaveLength(0);
    expect(kickLocalPipeline).not.toHaveBeenCalled();
  });

  it("o limite de leads do plano não barra o recadastro: nenhum lead novo é contado", async () => {
    planoNoLimite = true;

    const r = await chamar({ nome: "Maria", telefone: "11999990000" });

    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ lead_id: "lead-aberto" });
    expect(captacoes()[0]).toMatchObject({ outcome: "recadastro" });
  });

  it("envio de formulário HTML com redirect_to continua redirecionando (303)", async () => {
    montar({ leads: [leadExistente({ id: "lead-aberto" })], redirect_to: "https://exemplo.com/obrigado" });

    const r = await chamar({ nome: "Maria", telefone: "11999990000" }, { formulario: true });

    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://exemplo.com/obrigado");
    expect(leadsCriados).toHaveLength(0);
    expect(captacoes()[0]).toMatchObject({ outcome: "recadastro" });
  });

  it("a mesma entrega repetida (mesmo external_id) vira `duplicado` e não escreve outra linha na timeline", async () => {
    const r1 = await chamar({ nome: "Maria", telefone: "11999990000", external_id: "evt-1" });
    const r2 = await chamar({ nome: "Maria", telefone: "11999990000", external_id: "evt-1" });

    expect((await r1.json()).data).toEqual({ lead_id: "lead-aberto" });
    expect((await r2.json()).data).toEqual({ lead_id: "lead-aberto" });
    expect(atividades()).toHaveLength(1);
    expect(captacoes().map((c) => c.outcome)).toEqual(["recadastro", "duplicado"]);
  });

  it("external_id DIFERENTE é outro recadastro: ganha a própria linha na timeline", async () => {
    await chamar({ nome: "Maria", telefone: "11999990000", external_id: "evt-1" });
    await chamar({ nome: "Maria", telefone: "11999990000", external_id: "evt-2" });

    expect(atividades()).toHaveLength(2);
    expect(captacoes().map((c) => c.outcome)).toEqual(["recadastro", "recadastro"]);
    expect(leads()).toHaveLength(1);
  });
});

describe("recadastro: quando NÃO se aplica, o lead novo nasce como sempre", () => {
  it("só há lead ganho e perdido no funil: cria lead novo na etapa padrão da fonte", async () => {
    montar({
      leads: [
        leadExistente({ id: "lead-ganho", status: "won" }),
        leadExistente({ id: "lead-perdido", status: "lost" }),
      ],
    });

    const r = await chamar({ nome: "Maria", telefone: "11999990000" });

    expect(r.status).toBe(200);
    expect(leadsCriados).toHaveLength(1);
    expect(leadsCriados[0]).toMatchObject({ pipeline_id: FUNIL, stage_id: ETAPA_ENTRADA, contact_id: "contato-1" });
    expect((await r.json()).data.lead_id).toBe("lead-novo-1");
    expect(atividades()).toHaveLength(0);
    expect(captacoes()[0]).toMatchObject({ outcome: "criado" });
    expect(auditorias.map((a) => a.action)).toEqual(["webhook.lead_received"]);
  });

  it("o lead aberto está em OUTRO funil: cria lead novo no funil da fonte", async () => {
    montar({ leads: [leadExistente({ id: "lead-em-outro-funil", pipeline_id: OUTRO_FUNIL })] });

    await chamar({ nome: "Maria", telefone: "11999990000" });

    expect(leadsCriados).toHaveLength(1);
    expect(leadsCriados[0]).toMatchObject({ pipeline_id: FUNIL });
    expect(atividades()).toHaveLength(0);
    expect(captacoes()[0]).toMatchObject({ outcome: "criado" });
  });

  it("o lead aberto é de OUTRA organização: não conta (isolamento)", async () => {
    montar({ leads: [leadExistente({ id: "lead-de-outra-org", organization_id: OUTRA_ORG })] });

    await chamar({ nome: "Maria", telefone: "11999990000" });

    expect(leadsCriados).toHaveLength(1);
    expect(atividades()).toHaveLength(0);
  });

  it("o lead aberto é de OUTRA pessoa: cria lead novo para esta", async () => {
    montar({ leads: [leadExistente({ id: "lead-de-outro", contact_id: "contato-2" })] });

    await chamar({ nome: "Maria", telefone: "11999990000" });

    expect(leadsCriados).toHaveLength(1);
    expect(atividades()).toHaveLength(0);
  });

  it("contato anonimizado (LGPD) com lead aberto: nada novo entra na timeline dele, o lead novo nasce como antes", async () => {
    montar({
      leads: [leadExistente({ id: "lead-aberto" })],
      contatos: [
        {
          id: "contato-1",
          organization_id: ORG,
          name: "Cliente Anonimizado #1",
          phone_number: TELEFONE,
          is_merged_into: null,
          is_anonymized: true,
        },
      ],
    });

    await chamar({ nome: "Maria", telefone: "11999990000" });

    expect(leadsCriados).toHaveLength(1);
    expect(atividades()).toHaveLength(0);
    expect(captacoes()[0]).toMatchObject({ outcome: "criado" });
  });

  it("external_id já capturado pelo lead criado antes continua `duplicado`, sem recadastro", async () => {
    montar({ leads: [leadExistente({ id: "lead-do-webhook", source: "webhook", external_id: "evt-9" })] });

    const r = await chamar({ nome: "Maria", telefone: "11999990000", external_id: "evt-9" });

    expect((await r.json()).data).toEqual({ lead_id: "lead-do-webhook" });
    expect(leadsCriados).toHaveLength(0);
    expect(atividades()).toHaveLength(0);
    expect(captacoes().map((c) => c.outcome)).toEqual(["duplicado"]);
  });

  it("sem telefone não há contato resolvido: cria lead como hoje (só o telefone casa o contato)", async () => {
    montar({ leads: [leadExistente({ id: "lead-aberto" })] });

    await chamar({ nome: "Maria", email: "maria@exemplo.com" });

    expect(leadsCriados).toHaveLength(1);
    expect(atividades()).toHaveLength(0);
  });
});

describe("recadastro: a sequência inteira, com contato novo", () => {
  it("1º envio cria contato e lead; 2º envio do mesmo telefone recadastra; depois de ganhar o lead, o 3º cria outro", async () => {
    montar({ contatos: [] });

    const r1 = await chamar({ nome: "Joana", telefone: "11988887777" });
    const idLead = (await r1.json()).data.lead_id as string;
    expect(leads()).toHaveLength(1);
    expect(captacoes().map((c) => c.outcome)).toEqual(["criado"]);

    const r2 = await chamar({ nome: "Joana", telefone: "11988887777" });
    expect((await r2.json()).data.lead_id).toBe(idLead);
    expect(leads()).toHaveLength(1);
    expect(atividades()).toHaveLength(1);
    expect(captacoes().map((c) => c.outcome)).toEqual(["criado", "recadastro"]);

    leads()[0]!.status = "won";
    const r3 = await chamar({ nome: "Joana", telefone: "11988887777" });
    expect((await r3.json()).data.lead_id).not.toBe(idLead);
    expect(leads()).toHaveLength(2);
    expect(captacoes().map((c) => c.outcome)).toEqual(["criado", "recadastro", "criado"]);
  });
});
