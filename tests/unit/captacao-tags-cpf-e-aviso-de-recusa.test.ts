/**
 * Captação pública (`POST /api/v1/webhooks/in/[token]`), decisões do dono do
 * produto de 17/10/2026:
 *
 *   1. campo reservado `tags` -> `crm_leads.tags` (lead novo) e UNIÃO no lead
 *      aberto do recadastro, sem tocar etapa/status e sem virar campo livre;
 *   2. campo reservado `cpf` (alias `cpf_cnpj`) -> contato, CIFRADO, e o número
 *      NUNCA em nenhum outro registro;
 *   3. toda recusa abre UM aviso por fonte por dia na Central.
 *
 * A rota, o recadastro, o registro de captação, o aviso e a gravação do CPF
 * rodam de verdade sobre o banco em memória. Só as bordas são simuladas: a RPC
 * de cifra (`fn_encrypt_oauth`, do Postgres), a criação do lead, o segredo da
 * fonte, o limite por IP, o audit e o motor local de eventos.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { hashCpf } from "@/lib/contacts/cpf";
import { cpfValido } from "@/lib/documentos/cpf-cnpj";
import { criarBancoEmMemoria, type BancoEmMemoria, type Linha } from "../helpers/banco-em-memoria";

const ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN = "token-publico-da-landing";
const FUNIL = "funil-da-fonte";
const TELEFONE = "+5511999990000";
const CPF = "52998224725";
const CPF_FORMATADO = "529.982.247-25";
const CIFRA_FALSA = "\\xc1f4a11ce0b0";
const SEGREDO = "segredo-da-fonte-de-teste";

let banco: BancoEmMemoria;
let sequencia = 0;
let seqLead = 0;
let planoNoLimite = false;
let cifraDisponivel = true;
/** Segredo que o dublê de decifra devolve; `null` = fonte sem segredo (formulário público). */
let segredoDaFonte: string | null = SEGREDO;
/** O próximo envio sai assinado (HMAC-SHA256 do corpo) quando a fonte tem segredo? */
let assinar = true;
const leadsCriados: Array<Record<string, unknown>> = [];
const auditorias: Array<Record<string, unknown>> = [];
const logs: unknown[] = [];

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (entrada: Record<string, unknown>) => {
    auditorias.push(entrada);
  }),
}));
vi.mock("@/lib/logger", () => {
  const guardar = (...args: unknown[]) => {
    logs.push(args);
  };
  return { logger: { info: guardar, warn: guardar, error: guardar, debug: guardar } };
});
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: vi.fn(async () => segredoDaFonte) }));
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
import { avisarRecusaDaFonte, tituloDoAvisoDeRecusa } from "@/lib/webhooks/aviso-de-recusa";

function chamar(corpo: string, tipo: "json" | "form" = "json", extra: Record<string, string> = {}) {
  const assinatura: Record<string, string> =
    segredoDaFonte && assinar ? { "x-hipercrm-signature": createHmac("sha256", segredoDaFonte).update(corpo).digest("hex") } : {};
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    headers: {
      "content-type": tipo === "form" ? "application/x-www-form-urlencoded" : "application/json",
      "x-forwarded-for": "203.0.113.7",
      ...assinatura,
      ...extra,
    },
    body: corpo,
  });
  return POST(req, { params: Promise.resolve({ token: TOKEN }) });
}
const json = (campos: Record<string, unknown>) => chamar(JSON.stringify(campos));

function leadAberto(parcial: Linha): Linha {
  return {
    organization_id: ORG,
    contact_id: "contato-1",
    pipeline_id: FUNIL,
    stage_id: "etapa-meio",
    status: "open",
    source: "manual",
    tags: [],
    external_id: null,
    last_activity_at: null,
    created_at: "2026-10-01T10:00:00.000Z",
    ...parcial,
  };
}

const tabela = (nome: string) => banco.tabelas[nome] ?? [];
const contato = (id: string) => tabela("contacts").find((c) => c.id === id)!;
// O cpf_hash agora é o HMAC com a chave do servidor (lib/contacts/cpf.ts), igual ao que o código grava.
process.env.CPF_ENCRYPTION_KEY = "chave-de-teste-do-cpf";
const sha = (d: string) => hashCpf(d) as string;

function montar(extras: { leads?: Linha[]; contatos?: Linha[]; fontes?: Linha[] } = {}) {
  banco = criarBancoEmMemoria(
    {
      webhook_sources: extras.fontes ?? [
        {
          id: "fonte-1",
          name: "Landing de Outubro",
          organization_id: ORG,
          path_token: TOKEN,
          secret_encrypted: segredoDaFonte ? "cifrado" : null,
          default_pipeline_id: FUNIL,
          default_stage_id: "etapa-entrada",
          field_map: {},
          redirect_to: null,
          is_active: true,
        },
      ],
      webhook_events_log: [],
      crm_leads: extras.leads ?? [],
      crm_lead_activities: [],
      webhook_lead_captures: [],
      agent_inbox_items: [],
      contacts: extras.contatos ?? [
        { id: "contato-1", organization_id: ORG, name: "Maria", phone_number: TELEFONE, is_merged_into: null, cpf_hash: null },
      ],
    },
    {
      aoEscrever: {
        contacts: (modo, linhas) => {
          if (modo === "insert") for (const l of linhas) l.id ??= `contato-novo-${++sequencia}`;
          return null;
        },
      },
      rpc: {
        fn_encrypt_oauth: () => (cifraDisponivel ? { data: CIFRA_FALSA } : { error: { message: "chave ausente" } }),
      },
    },
  );
}

/** Tudo o que o sistema gravou ou registrou, como texto — o CPF não pode estar em lugar nenhum. */
function tudoQueFoiGuardadoExcetoAColunaCifrada(): string {
  const tabelas = Object.fromEntries(
    Object.entries(banco.tabelas).map(([nome, linhas]) => [
      nome,
      linhas.map(({ cpf_hash: _h, cpf_encrypted: _c, ...resto }) => resto),
    ]),
  );
  return JSON.stringify({ tabelas, leadsCriados, auditorias, logs, rpc: banco.chamadasRpc.filter((c) => c.nome !== "fn_encrypt_oauth") });
}

beforeEach(() => {
  sequencia = 0;
  seqLead = 0;
  planoNoLimite = false;
  cifraDisponivel = true;
  leadsCriados.length = 0;
  auditorias.length = 0;
  logs.length = 0;
  segredoDaFonte = SEGREDO;
  assinar = true;
});

describe("fixtures", () => {
  it("o CPF de teste é válido pela régua do produto", () => {
    expect(cpfValido(CPF)).toBe(true);
  });
});

describe("tags: lead novo", () => {
  beforeEach(() => montar());

  it("array vira tags do lead, preservando a caixa, sem repetir e sem virar campo personalizado", async () => {
    const r = await json({ nome: "Maria", telefone: "11999990000", tags: [" VIP ", "vip", "Lead Quente", "", 7], cidade: "Varginha" });
    expect(r.status).toBe(200);
    expect(leadsCriados).toHaveLength(1);
    expect(leadsCriados[0]!.tags).toEqual(["VIP", "Lead Quente", "7"]);
    expect(leadsCriados[0]!.custom_fields).toEqual({ cidade: "Varginha" });
  });

  it("texto separado por vírgula ou barra vertical", async () => {
    await json({ nome: "Maria", telefone: "11999990000", tags: "Black Friday | Quente,  frio ,Quente" });
    expect(leadsCriados[0]!.tags).toEqual(["Black Friday", "Quente", "frio"]);
  });

  it("no máximo 20 etiquetas de no máximo 60 caracteres", async () => {
    const muitas = Array.from({ length: 30 }, (_, i) => `t${i}`);
    await json({ nome: "Maria", telefone: "11999990000", tags: [ "x".repeat(100), ...muitas ] });
    const tags = leadsCriados[0]!.tags as string[];
    expect(tags).toHaveLength(20);
    expect(tags[0]).toHaveLength(60);
  });

  it("formulário com tags repetidas (tags e tags[]) junta tudo", async () => {
    await chamar("nome=Maria&telefone=11999990000&tags=a&tags%5B%5D=b&tags=c", "form");
    expect(leadsCriados[0]!.tags).toEqual(["a", "b", "c"]);
    expect(leadsCriados[0]!.custom_fields).toEqual({});
  });

  it("sem o campo, o lead nasce sem etiqueta (como antes)", async () => {
    await json({ nome: "Maria", telefone: "11999990000" });
    expect(leadsCriados[0]!.tags).toEqual([]);
  });
});

describe("tags: recadastro no lead aberto", () => {
  beforeEach(() => montar({ leads: [leadAberto({ id: "lead-aberto", tags: ["Cliente", "vip"] })] }));

  it("une as etiquetas novas às existentes sem mexer em etapa nem status, e só emite lead.tag_added", async () => {
    const r = await json({ nome: "Maria", telefone: "11999990000", tags: "VIP, Novo, novo, Outra" });

    expect(r.status).toBe(200);
    expect(leadsCriados).toHaveLength(0);
    const lead = tabela("crm_leads")[0]!;
    expect(lead.tags).toEqual(["Cliente", "vip", "Novo", "Outra"]);
    expect(lead).toMatchObject({ stage_id: "etapa-meio", status: "open" });

    const eventos = banco.chamadasRpc.filter((c) => c.nome === "emit_event");
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.args).toMatchObject({
      p_event_type: "lead.tag_added",
      p_entity_id: "lead-aberto",
      p_organization_id: ORG,
      p_payload: { added_tags: ["Novo", "Outra"] },
    });
    expect(eventos.map((e) => e.args.p_event_type)).not.toContain("lead.won");
    expect(eventos.map((e) => e.args.p_event_type)).not.toContain("lead.lost");

    const atividade = tabela("crm_lead_activities")[0]!;
    expect(atividade.type).toBe("lead_reregistered");
    expect((atividade.payload as Record<string, unknown>).tags_adicionadas).toEqual(["Novo", "Outra"]);
  });

  it("etiquetas que o lead já tem não escrevem nada nem emitem evento", async () => {
    await json({ nome: "Maria", telefone: "11999990000", tags: ["CLIENTE", "Vip"] });
    expect(tabela("crm_leads")[0]!.tags).toEqual(["Cliente", "vip"]);
    expect(banco.chamadasRpc.filter((c) => c.nome === "emit_event")).toHaveLength(0);
  });

  it("reenvio do mesmo recadastro (external_id) não une de novo", async () => {
    await json({ nome: "Maria", telefone: "11999990000", external_id: "E-1", tags: "a" });
    await json({ nome: "Maria", telefone: "11999990000", external_id: "E-1", tags: "a,b" });
    expect(tabela("crm_leads")[0]!.tags).toEqual(["Cliente", "vip", "a"]);
    expect(tabela("crm_lead_activities")).toHaveLength(1);
  });

  it("lead fechado não é mexido: o recadastro vira lead novo com as etiquetas do envio", async () => {
    montar({ leads: [leadAberto({ id: "lead-ganho", status: "won", tags: ["Antigo"] })] });
    await json({ nome: "Maria", telefone: "11999990000", tags: "Novo" });
    expect(tabela("crm_leads").find((l) => l.id === "lead-ganho")!.tags).toEqual(["Antigo"]);
    expect(leadsCriados[0]!.tags).toEqual(["Novo"]);
  });
});

describe("CPF: gravação cifrada no contato, sem vazamento", () => {
  beforeEach(() => montar());

  it("contato novo: grava hash + cifra juntos e o número não aparece em NENHUM outro registro (JSON)", async () => {
    const r = await json({ nome: "Maria", telefone: "11999990001", cpf: CPF_FORMATADO, cidade: "Varginha" });
    expect(r.status).toBe(200);

    const novo = tabela("contacts").find((c) => c.phone_number === "+5511999990001")!;
    expect(novo.cpf_hash).toBe(sha(CPF));
    expect(novo.cpf_encrypted).toBe(CIFRA_FALSA);
    expect(banco.chamadasRpc.find((c) => c.nome === "fn_encrypt_oauth")!.args).toEqual({ plaintext: CPF });

    const guardado = tudoQueFoiGuardadoExcetoAColunaCifrada();
    expect(guardado).not.toContain(CPF);
    expect(guardado).not.toContain(CPF_FORMATADO);
    expect(guardado).not.toContain("529.982");
    expect(leadsCriados[0]!.custom_fields).toEqual({ cidade: "Varginha" });
    // o log forense guarda o corpo SEM o documento, mas guarda o resto
    const log = tabela("webhook_events_log")[0]!;
    expect(String(log.raw_body)).toContain("Varginha");
    expect(String(log.raw_body)).not.toContain("cpf");
  });

  it("formulário urlencoded e alias cpf_cnpj: mesmo resultado, corpo cru sem o número", async () => {
    await chamar(`nome=Ana&telefone=11999990002&CPF_CNPJ=${encodeURIComponent(CPF_FORMATADO)}&cidade=Lavras`, "form");
    const novo = tabela("contacts").find((c) => c.phone_number === "+5511999990002")!;
    expect(novo.cpf_hash).toBe(sha(CPF));
    const guardado = tudoQueFoiGuardadoExcetoAColunaCifrada();
    expect(guardado).not.toContain(CPF);
    expect(guardado).not.toContain("529.982");
    expect(String(tabela("webhook_events_log")[0]!.raw_body)).toContain("cidade=Lavras");
  });

  it("recadastro grava o CPF no contato existente e continua sem lead novo", async () => {
    montar({ leads: [leadAberto({ id: "lead-aberto" })] });
    await json({ nome: "Maria", telefone: "11999990000", cpf: CPF });
    expect(contato("contato-1").cpf_hash).toBe(sha(CPF));
    expect(contato("contato-1").cpf_encrypted).toBe(CIFRA_FALSA);
    expect(leadsCriados).toHaveLength(0);
    expect(tudoQueFoiGuardadoExcetoAColunaCifrada()).not.toContain(CPF);
  });

  it("CNPJ, CPF inválido e lixo são ignorados em silêncio (200), avisando no log sem o valor", async () => {
    for (const lixo of ["11.222.333/0001-81", "529.982.247-26", "111.111.111-11", "lixo-sem-digito"]) {
      logs.length = 0;
      const r = await json({ nome: "Maria", telefone: "11999990000", cpf: lixo });
      expect(r.status).toBe(200);
      expect(contato("contato-1").cpf_hash).toBeNull();
      expect(banco.chamadasRpc.filter((c) => c.nome === "fn_encrypt_oauth")).toHaveLength(0);
      expect(JSON.stringify(logs)).toContain("documento do envio ignorado");
      expect(tudoQueFoiGuardadoExcetoAColunaCifrada()).not.toContain(lixo);
      expect(JSON.stringify(logs)).not.toContain(lixo);
    }
  });

  it("contato que já tem CPF não é sobrescrito", async () => {
    montar({
      contatos: [{ id: "contato-1", organization_id: ORG, name: "Maria", phone_number: TELEFONE, is_merged_into: null, cpf_hash: "hash-antigo", cpf_encrypted: "\\xaa" }],
    });
    await json({ nome: "Maria", telefone: "11999990000", cpf: CPF });
    expect(contato("contato-1").cpf_hash).toBe("hash-antigo");
    expect(contato("contato-1").cpf_encrypted).toBe("\\xaa");
    expect(banco.chamadasRpc.filter((c) => c.nome === "fn_encrypt_oauth")).toHaveLength(0);
  });

  it("outro contato da organização com o mesmo CPF: pula o CPF, loga e a captação segue", async () => {
    montar({
      contatos: [
        { id: "contato-1", organization_id: ORG, name: "Maria", phone_number: TELEFONE, is_merged_into: null, cpf_hash: null },
        { id: "contato-2", organization_id: ORG, name: "Outro", phone_number: "+5511888880000", is_merged_into: null, cpf_hash: sha(CPF), cpf_encrypted: "\\xbb" },
      ],
    });
    const r = await json({ nome: "Maria", telefone: "11999990000", cpf: CPF });
    expect(r.status).toBe(200);
    expect(contato("contato-1").cpf_hash).toBeNull();
    expect(contato("contato-1").cpf_encrypted ?? null).toBeNull();
    expect(leadsCriados).toHaveLength(1);
    expect(JSON.stringify(logs)).toContain("cpf do envio não foi gravado");
    expect(JSON.stringify(logs)).toContain("duplicado");
    expect(JSON.stringify(logs)).not.toContain(CPF);
  });

  it("CPF de outra organização não conta como duplicado", async () => {
    montar({
      contatos: [
        { id: "contato-1", organization_id: ORG, name: "Maria", phone_number: TELEFONE, is_merged_into: null, cpf_hash: null },
        { id: "alheio", organization_id: "outra-org", name: "Outro", phone_number: "+5511888880000", is_merged_into: null, cpf_hash: sha(CPF), cpf_encrypted: "\\xbb" },
      ],
    });
    await json({ nome: "Maria", telefone: "11999990000", cpf: CPF });
    expect(contato("contato-1").cpf_hash).toBe(sha(CPF));
  });

  it("sem chave de cifra na instalação: nunca grava em claro nem só o hash", async () => {
    cifraDisponivel = false;
    const r = await json({ nome: "Maria", telefone: "11999990000", cpf: CPF });
    expect(r.status).toBe(200);
    expect(contato("contato-1").cpf_hash).toBeNull();
    expect(contato("contato-1").cpf_encrypted ?? null).toBeNull();
    expect(leadsCriados).toHaveLength(1);
    expect(tudoQueFoiGuardadoExcetoAColunaCifrada()).not.toContain(CPF);
  });

  it("envio recusado que traz CPF também não o deixa em registro nenhum", async () => {
    const r = await json({ cpf: CPF_FORMATADO, mensagem: "oi" });
    expect(r.status).toBe(400);
    expect(tabela("webhook_lead_captures")[0]).toMatchObject({ outcome: "recusado", reject_reason: "sem_campo_mapeavel" });
    const guardado = tudoQueFoiGuardadoExcetoAColunaCifrada();
    expect(guardado).not.toContain(CPF);
    expect(guardado).not.toContain("529.982");
  });

  it("lead sem telefone não tem contato: o CPF é descartado e a captação segue", async () => {
    const r = await json({ nome: "Sem Telefone", cpf: CPF });
    expect(r.status).toBe(200);
    expect(banco.chamadasRpc.filter((c) => c.nome === "fn_encrypt_oauth")).toHaveLength(0);
    expect(tudoQueFoiGuardadoExcetoAColunaCifrada()).not.toContain(CPF);
  });
});

describe("recusa abre aviso na Central: um por fonte por dia", () => {
  beforeEach(() => montar());
  const avisos = () => tabela("agent_inbox_items");

  it("envio sem campo reconhecível: aviso com o nome da fonte e o motivo em português", async () => {
    const r = await json({ qualquer: "coisa" });
    expect(r.status).toBe(400);
    expect(avisos()).toHaveLength(1);
    const a = avisos()[0]!;
    expect(a).toMatchObject({ organization_id: ORG, kind: "other", severity: "warn" });
    expect(String(a.title)).toContain("Landing de Outubro");
    expect(a.body).toBe(
      "A fonte Landing de Outubro recusou um lead: o envio não trazia nome, telefone nem e-mail reconhecíveis — confira os nomes dos campos do formulário. Veja em Webhooks › Leads recebidos.",
    );
  });

  it("uma rajada de recusas no mesmo dia continua sendo um aviso só", async () => {
    await json({ a: "1" });
    await json({ b: "2" });
    await chamar("{ não é json");
    expect(avisos()).toHaveLength(1);
    expect(tabela("webhook_lead_captures")).toHaveLength(3);
  });

  it("JSON inválido é recusa registrada, com aviso", async () => {
    const r = await chamar("{ não é json");
    expect(r.status).toBe(400);
    expect(tabela("webhook_lead_captures")[0]).toMatchObject({ outcome: "recusado", reject_reason: "corpo_invalido" });
    expect(String(avisos()[0]!.body)).toContain("não é um JSON válido");
  });

  it("limite do plano e erro ao criar também avisam, com o motivo certo", async () => {
    planoNoLimite = true;
    const r = await json({ nome: "Maria", telefone: "11999990000" });
    expect(r.status).toBe(402);
    expect(String(avisos()[0]!.body)).toContain("já está no limite de leads");
  });

  it("captação que dá certo ou é duplicada não avisa", async () => {
    await json({ nome: "Maria", telefone: "11999990000", external_id: "E-1" });
    await json({ nome: "Maria", telefone: "11999990000", external_id: "E-1" });
    expect(avisos()).toHaveLength(0);
  });

  it("outra fonte, ou o dia seguinte, abrem aviso novo; mesma fonte e mesmo dia, não", async () => {
    const hoje = new Date("2026-10-17T15:00:00Z");
    const amanha = new Date("2026-10-18T15:00:00Z");
    const entrada = { organizationId: ORG, sourceName: "Landing de Outubro", motivoLegivel: "Algo deu errado." };
    await avisarRecusaDaFonte(banco as never, entrada, hoje);
    await avisarRecusaDaFonte(banco as never, entrada, hoje);
    expect(avisos()).toHaveLength(1);
    await avisarRecusaDaFonte(banco as never, { ...entrada, sourceName: "Outra fonte" }, hoje);
    expect(avisos()).toHaveLength(2);
    await avisarRecusaDaFonte(banco as never, entrada, amanha);
    expect(avisos()).toHaveLength(3);
    expect(avisos()[0]!.title).toBe(tituloDoAvisoDeRecusa("Landing de Outubro", hoje));
    expect(String(avisos()[0]!.title)).toContain("17/10/2026");
    expect(String(avisos()[2]!.title)).toContain("18/10/2026");
  });

  it("não filtra por organização alheia: o aviso de outra organização não esconde o desta", async () => {
    banco.tabelas["agent_inbox_items"]!.push({ organization_id: "outra-org", kind: "other", title: tituloDoAvisoDeRecusa("Landing de Outubro", new Date()) });
    await json({ qualquer: "coisa" });
    expect(avisos().filter((a) => a.organization_id === ORG)).toHaveLength(1);
  });

  it("falha ao gravar o aviso não derruba a recusa", async () => {
    const sujo = {
      from: () => {
        throw new Error("banco fora");
      },
    };
    await expect(
      avisarRecusaDaFonte(sujo as never, { organizationId: ORG, sourceName: "X", motivoLegivel: "y" }),
    ).resolves.toBeUndefined();
  });
});

// ─── Auditoria de 17/10/2026: o que só a ORIGEM PROVADA (HMAC válido) pode afirmar ────────────────
//
// Fonte sem segredo é formulário público: o token está no HTML e qualquer um fala por ela. Etiqueta,
// CPF em contato que já existe e consentimento sobre contato que já existe só valem com a assinatura.

const RESPONDI = (respondenteId: string, resposta: string) => ({
  form: { form_id: "f1", form_name: "Form" },
  respondent: {
    respondent_id: respondenteId,
    answers: {
      "Qual é o seu nome?": "Maria",
      "Qual é o melhor WhatsApp para falarmos sobre essa análise?": "55 11988887777",
    },
    raw_answers: [{ question: { question_type: "legaltext" }, answer: resposta }],
  },
});

describe("etiquetas: só de origem provada", () => {
  it("fonte pública: `tags` é ignorada (log), não vira etiqueta nem campo personalizado", async () => {
    segredoDaFonte = null;
    montar();
    const r = await json({ nome: "Maria", telefone: "11999990000", tags: ["pago", "vip"], cidade: "Varginha" });
    expect(r.status).toBe(200);
    expect(leadsCriados[0]!.tags).toEqual([]);
    expect(leadsCriados[0]!.custom_fields).toEqual({ cidade: "Varginha" });
    expect(JSON.stringify(logs)).toContain("tags do envio ignoradas");
  });

  it("fonte com segredo mas SEM assinatura é recusada (401) e nada entra", async () => {
    montar();
    assinar = false;
    const r = await json({ nome: "Maria", telefone: "11999990000", tags: ["pago"] });
    expect(r.status).toBe(401);
    expect(leadsCriados).toHaveLength(0);
  });

  it("recadastro em fonte pública não une etiqueta nem emite lead.tag_added", async () => {
    segredoDaFonte = null;
    montar({ leads: [leadAberto({ id: "lead-aberto", tags: ["Cliente"] })] });
    await json({ nome: "Maria", telefone: "11999990000", tags: "pago" });
    expect(tabela("crm_leads")[0]!.tags).toEqual(["Cliente"]);
    expect(banco.chamadasRpc.filter((c) => c.nome === "emit_event")).toHaveLength(0);
  });

  it("origem provada: a etiqueta entra e os eventos carregam origin_proven", async () => {
    montar({ leads: [leadAberto({ id: "lead-aberto", tags: [] })] });
    await json({ nome: "Maria", telefone: "11999990000", tags: "pago" });
    const ev = banco.chamadasRpc.find((c) => c.nome === "emit_event")!;
    expect((ev.args.p_metadata as Record<string, unknown>).origin_proven).toBe(true);

    montar();
    await json({ nome: "Ana", telefone: "11999990009", tags: "novo" });
    expect(leadsCriados[0]!.tags).toEqual(["novo"]);
    expect(leadsCriados[0]!.origin_proven).toBe(true);
  });
});

describe("CPF: só de origem provada, ou em contato nascido neste envio", () => {
  it("fonte pública NÃO grava CPF em contato que já existe", async () => {
    segredoDaFonte = null;
    montar();
    const r = await json({ nome: "Maria", telefone: "11999990000", cpf: CPF });
    expect(r.status).toBe(200);
    expect(contato("contato-1").cpf_hash).toBeNull();
    expect(JSON.stringify(logs)).toContain("origem_nao_provada");
  });

  it("fonte pública grava o CPF do contato que ELA mesma criou", async () => {
    segredoDaFonte = null;
    montar();
    await json({ nome: "Nova", telefone: "11999990077", cpf: CPF });
    const novo = tabela("contacts").find((c) => c.phone_number === "+5511999990077")!;
    expect(novo.cpf_hash).toBe(sha(CPF));
  });
});

describe("consentimento: contato existente só muda com origem provada", () => {
  const contatoDeclinado = () => ({
    id: "contato-r",
    organization_id: ORG,
    name: "Maria",
    phone_number: "+5511988887777",
    is_merged_into: null,
    cpf_hash: null,
    consent: { marketing: { granted_at: null, declined_at: "2026-01-01T00:00:00.000Z", source: "manual", version: null } },
  });

  it("fonte pública: NÃO apaga o declined_at de quem já recusou", async () => {
    segredoDaFonte = null;
    montar({ contatos: [contatoDeclinado()] });
    const r = await json(RESPONDI("r1", "Sim"));
    expect(r.status).toBe(200);
    const marketing = (contato("contato-r").consent as { marketing: Record<string, unknown> }).marketing;
    expect(marketing.declined_at).toBe("2026-01-01T00:00:00.000Z");
    expect(marketing.granted_at).toBeNull();
    expect(auditorias.filter((a) => a.action === "lgpd.consent_changed")).toHaveLength(0);
  });

  it("origem provada: grava e audita lgpd.consent_changed com a fonte", async () => {
    montar({ contatos: [contatoDeclinado()] });
    await json(RESPONDI("r2", "Sim"));
    const marketing = (contato("contato-r").consent as { marketing: Record<string, unknown> }).marketing;
    expect(marketing.granted_at).toEqual(expect.any(String));
    const a = auditorias.find((x) => x.action === "lgpd.consent_changed")!;
    expect(a.resourceId).toBe("contato-r");
    expect(a.metadata).toMatchObject({ from: "recusado", to: "concedido", webhook_source_id: "fonte-1", origin_proven: true });
  });

  it("contato novo de fonte pública recebe o que o formulário disse (nada a sobrescrever)", async () => {
    segredoDaFonte = null;
    montar({ contatos: [] });
    await json(RESPONDI("r3", "Sim"));
    const novo = tabela("contacts")[0]!;
    expect((novo.consent as { marketing: { granted_at: unknown } }).marketing.granted_at).toEqual(expect.any(String));
  });
});

describe("corpo JSON que não é objeto", () => {
  beforeEach(() => montar());
  it.each(["null", "42", '"texto"', "[1,2]"])("%s -> 400 corpo_invalido, com rastro", async (corpo) => {
    const r = await chamar(corpo);
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain("corpo_invalido");
    expect(tabela("webhook_lead_captures")[0]).toMatchObject({ outcome: "recusado", reject_reason: "corpo_invalido" });
  });
});

describe("credenciais do envio não vão para o log forense", () => {
  it("assinatura e token do Turnstile ficam fora de headers, signature_header e raw_body", async () => {
    montar();
    await chamar(JSON.stringify({ nome: "Maria", telefone: "11999990000", "cf-turnstile-response": "TOKEN-TURNSTILE" }), "json", {
      "x-turnstile-token": "TOKEN-HEADER",
    });
    const log = tabela("webhook_events_log")[0]!;
    const guardado = JSON.stringify(log);
    expect(guardado).not.toContain("TOKEN-TURNSTILE");
    expect(guardado).not.toContain("TOKEN-HEADER");
    expect(Object.keys(log.headers as object).map((k) => k.toLowerCase())).not.toContain("x-hipercrm-signature");
    expect(log.signature_header).toBeNull();
    expect(log.valid_signature).toBe(true);
  });

  it("formulário: o campo do Turnstile também sai do corpo cru", async () => {
    segredoDaFonte = null;
    montar();
    await chamar("nome=Maria&telefone=11999990000&cf-turnstile-response=TOKEN-TURNSTILE", "form");
    expect(String(tabela("webhook_events_log")[0]!.raw_body)).not.toContain("TOKEN-TURNSTILE");
  });
});

describe("idempotência do recadastro depois que o lead aberto fecha", () => {
  it("reenvio com o mesmo external_id não cria lead novo mesmo com o lead já ganho", async () => {
    montar({ leads: [leadAberto({ id: "lead-aberto" })] });
    await json({ nome: "Maria", telefone: "11999990000", external_id: "E-9" });
    expect(tabela("webhook_lead_captures")[0]).toMatchObject({ outcome: "recadastro", external_id: "E-9" });

    tabela("crm_leads")[0]!.status = "won"; // o lead fechou
    const r = await json({ nome: "Maria", telefone: "11999990000", external_id: "E-9" });
    expect(r.status).toBe(200);
    expect(leadsCriados).toHaveLength(0);
    expect(tabela("webhook_lead_captures")[1]).toMatchObject({ outcome: "duplicado", lead_id: "lead-aberto" });
  });
});

describe("envio só com e-mail", () => {
  it("cria o contato pelo e-mail e liga o lead a ele", async () => {
    segredoDaFonte = null;
    montar({ contatos: [] });
    await json({ nome: "Só Email", email: "ana@exemplo.com" });
    expect(tabela("contacts")).toHaveLength(1);
    expect(tabela("contacts")[0]).toMatchObject({ email: "ana@exemplo.com", name: "Só Email" });
    expect(leadsCriados[0]!.contact_id).toBeTruthy();
  });
});

describe("aviso de recusa: corrida do INSERT", () => {
  it("23505 do índice único é 'já existe', sem log de falha", async () => {
    montar();
    const original = banco.from.bind(banco);
    (banco as { from: unknown }).from = (t: string) => {
      const q = original(t) as unknown as Record<string, unknown>;
      if (t === "agent_inbox_items") {
        q.insert = () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
      }
      return q;
    };
    logs.length = 0;
    await avisarRecusaDaFonte(banco as never, { organizationId: ORG, sourceName: "X", motivoLegivel: "y" });
    expect(JSON.stringify(logs)).not.toContain("aviso não gravado");
  });
});
