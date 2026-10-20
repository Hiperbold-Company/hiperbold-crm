/**
 * A RECUSA DE PROVEDOR/MODELO VALE NO SALVAR, NAS TRÊS PORTAS (20/10/2026).
 *
 * `recusaDaVersao` rodava só em `criarVersaoDoAgente` e no publicar. Salvar o rascunho pelo editor,
 * criar o assistente pela tela e o PATCH do rascunho pela API gravavam o par sem conferir: o rascunho
 * nascia com Anthropic sem credencial, com credencial de OUTRA organização ou com modelo fora do plano,
 * e só estourava na publicação. Aqui cada porta é exercitada de verdade (o admin é um dublê de banco;
 * a regra, o schema e a rota/action são os reais) e se prova o que importa: o erro certo volta E nada
 * é gravado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const VERSAO = "55555555-5555-4555-8555-555555555555";
const CRED_DA_ORG = "11111111-1111-4111-8111-111111111111";
const CRED_DE_OUTRA = "22222222-2222-4222-8222-222222222222";

/** O banco falso: credenciais por id (cada uma com a organização dona) e o registro de escritas. */
const banco = vi.hoisted(() => ({
  credenciais: {} as Record<string, { organization_id: string; provider: string; is_active: boolean }>,
  versaoExistente: null as Record<string, unknown> | null,
  escritas: [] as Array<{ tabela: string; op: string }>,
}));

function construtor(tabela: string) {
  const filtros: Record<string, unknown> = {};
  let op = "select";
  const q: Record<string, unknown> = {};
  const encadeia = (nome: string) => (...a: unknown[]) => {
    if (nome === "insert" || nome === "update") {
      op = nome;
      banco.escritas.push({ tabela, op: nome });
    }
    if (nome === "eq") filtros[a[0] as string] = a[1];
    return q;
  };
  for (const n of ["select", "insert", "update", "eq", "order", "limit", "in"]) q[n] = encadeia(n);
  const resolve = async () => {
    if (tabela === "ai_provider_credentials") {
      const c = banco.credenciais[filtros.id as string];
      // Filtro por organização: credencial de outra empresa não é achada.
      return { data: c && c.organization_id === filtros.organization_id ? c : null, error: null };
    }
    if (tabela === "ai_agents") {
      return {
        data: op === "insert" ? { id: AGENTE } : { id: AGENTE, kind: "mcp_agent", archived_at: null, name: "A", description: null, priority: 0, published_version_id: null },
        error: null,
      };
    }
    if (tabela === "ai_agent_versions") {
      return { data: banco.versaoExistente ?? { id: VERSAO, version_number: 1 }, error: null };
    }
    return { data: null, error: null };
  };
  q.maybeSingle = resolve;
  q.single = resolve;
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return q;
}
const adminFalso = { from: (t: string) => construtor(t) };

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminFalso }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "user-1", email: "u@example.com" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org", role: "admin" })),
  mfaEmDivida: vi.fn(async () => false),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/agents/escopo", () => ({
  validarEscopoDaVersao: vi.fn(async () => ({ ok: true })),
  mensagemDoEscopo: () => "Escopo inválido.",
}));
// A lista do plano: só o Luna.
vi.mock("@/lib/ai/modelos-da-instalacao-leitura", () => ({
  modelosDaInstalacao: vi.fn(async () => ["openai/gpt-6-luna"]),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual-admin", () => ({
  autorizarAdministracao: vi.fn(async () => ({
    ok: true,
    via: "session",
    organizationId: ORG,
    supabase: adminFalso,
    actor: { id: "user-1" },
    idioma: "pt-BR",
  })),
  atorDoAudit: () => ({ actorUserId: "user-1", actorApiTokenId: null }),
  traducaoDe: () => (t: string) => t,
}));

import { PATCH } from "@/app/api/v1/ai/agents/[id]/versions/[vid]/route";
import { createMcpAgentAction, saveAgentDraftAction } from "@/app/app/ai/agents/[id]/_actions";

const base = {
  system_prompt: "Você é a recepção da clínica. Atenda com educação.",
  tool_ids: [],
  channel_session_id: null,
  followup: {},
};
const doPlano = { ...base, provider: "openrouter", model: "openai/gpt-6-luna", credential_id: null };
const anthropicSemChave = { ...base, provider: "anthropic", model: "claude-sonnet-5", credential_id: null };
const modeloForaDoPlano = { ...base, provider: "openrouter", model: "anthropic/claude-opus-5", credential_id: null };
const credDeOutraOrg = { ...base, provider: "anthropic", model: "claude-sonnet-5", credential_id: CRED_DE_OUTRA };
const credDaOrg = { ...base, provider: "anthropic", model: "claude-sonnet-5", credential_id: CRED_DA_ORG };

const gravou = () => banco.escritas.filter((e) => e.tabela === "ai_agents" || e.tabela === "ai_agent_versions");

beforeEach(() => {
  banco.escritas = [];
  banco.versaoExistente = null;
  banco.credenciais = {
    [CRED_DA_ORG]: { organization_id: ORG, provider: "anthropic", is_active: true },
    [CRED_DE_OUTRA]: { organization_id: OUTRA_ORG, provider: "anthropic", is_active: true },
  };
});

describe("saveAgentDraftAction recusa o par não permitido antes de gravar", () => {
  it.each([
    ["Anthropic sem credencial", anthropicSemChave, "provider_not_allowed"],
    ["modelo fora do plano na chave da instalação", modeloForaDoPlano, "model_not_allowed"],
    ["credencial de outra organização", credDeOutraOrg, "provider_not_allowed"],
  ])("%s", async (_n, payload, code) => {
    const r = await saveAgentDraftAction(AGENTE, payload);
    expect(r).toMatchObject({ ok: false, error: code });
    expect((r as { message?: string }).message).toMatch(/\S{10,}/);
    expect(gravou()).toEqual([]);
  });

  it("a chave do plano com o Luna e a credencial da própria empresa são salvas", async () => {
    expect(await saveAgentDraftAction(AGENTE, doPlano)).toMatchObject({ ok: true });
    banco.escritas = [];
    expect(await saveAgentDraftAction(AGENTE, credDaOrg)).toMatchObject({ ok: true });
    expect(gravou().length).toBeGreaterThan(0);
  });
});

describe("createMcpAgentAction recusa antes de criar o assistente", () => {
  it.each([
    ["Anthropic sem credencial", anthropicSemChave, "provider_not_allowed"],
    ["modelo fora do plano", modeloForaDoPlano, "model_not_allowed"],
    ["credencial de outra organização", credDeOutraOrg, "provider_not_allowed"],
  ])("%s", async (_n, version, code) => {
    const r = await createMcpAgentAction({ name: "Recepção", priority: 0, version });
    expect(r).toMatchObject({ ok: false, error: code });
    // Nem o agente nem a versão: nada de lixo arquivado.
    expect(gravou()).toEqual([]);
  });

  it("par permitido cria o agente e a versão", async () => {
    const r = await createMcpAgentAction({ name: "Recepção", priority: 0, version: doPlano });
    expect(r).toMatchObject({ ok: true });
    expect(gravou().map((e) => e.tabela)).toEqual(["ai_agents", "ai_agent_versions"]);
  });
});

describe("PATCH /ai/agents/:id/versions/:vid recusa o par resultante", () => {
  const chama = (corpo: unknown) =>
    PATCH(
      new Request("http://x/api/v1/ai/agents/a/versions/v", { method: "PATCH", body: JSON.stringify(corpo) }) as never,
      { params: Promise.resolve({ id: AGENTE, vid: VERSAO }) },
    );

  beforeEach(() => {
    // A linha já gravada é do plano (OpenRouter/Luna, chave da instalação).
    banco.versaoExistente = {
      id: VERSAO,
      status: "draft",
      agent_id: AGENTE,
      organization_id: ORG,
      followup: {},
      provider: "openrouter",
      model: "openai/gpt-6-luna",
      credential_id: null,
    };
  });

  it.each([
    ["trocar para Anthropic sem credencial", { provider: "anthropic", model: "claude-sonnet-5" }, "provider_not_allowed"],
    ["trocar só o modelo para fora do plano", { model: "anthropic/claude-opus-5" }, "model_not_allowed"],
    [
      "credencial de outra organização",
      { provider: "anthropic", model: "claude-sonnet-5", credential_id: CRED_DE_OUTRA },
      "provider_not_allowed",
    ],
  ])("%s", async (_n, corpo, code) => {
    const res = await chama(corpo);
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe(code);
    expect(json.error.message.length).toBeGreaterThan(10);
    expect(gravou()).toEqual([]);
  });

  it("par permitido passa; e editar outro campo não reabre a conferência (versão antiga não trava)", async () => {
    banco.versaoExistente = { ...banco.versaoExistente!, provider: "anthropic", model: "claude-sonnet-5" };
    const outro = await chama({ max_steps: 5 });
    expect(outro.status).toBe(200);
    banco.escritas = [];
    const certo = await chama({ provider: "anthropic", model: "claude-sonnet-5", credential_id: CRED_DA_ORG });
    expect(certo.status).toBe(200);
    expect(gravou().some((e) => e.op === "update")).toBe(true);
  });
});
