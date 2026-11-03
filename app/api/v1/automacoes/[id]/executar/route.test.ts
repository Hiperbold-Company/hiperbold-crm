import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/v1/automacoes/[id]/executar — os freios da porta manual (B9, B13).
 *
 * O que roda DE VERDADE: a rota, `iniciarAutomacao` (até a RPC do banco, que é
 * o dublê) e `comIdempotencia` (com `idempotency_keys` no dublê). O número que
 * decide cada caso é a CONTAGEM de chamadas à RPC `fn_automacao_iniciar`: um
 * caminho que devolvesse a resposta certa e iniciasse de novo passaria na
 * igualdade das respostas e abriria segunda execução.
 */
const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const POINTER = "aaaaaaaa-6666-4000-8000-000000000001";
const VERSAO = "aaaaaaaa-5555-4000-8000-000000000001";
const CONTATO = "aaaaaaaa-3333-4000-8000-000000000001";
const CHAVE = "aaaaaaaa-2222-4000-8000-000000000010";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/api/auth-dual", () => ({ tetoDeEscritaDoToken: vi.fn(async () => null) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/billing/assinatura/pode-produzir", () => ({ motivoDeNaoProduzir: vi.fn(async () => null) }));
vi.mock("@/lib/followup/porta", () => ({ entradaDeFluxo: vi.fn() }));
const servidor = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => servidor.db }));

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { motivoDeNaoProduzir } from "@/lib/billing/assinatura/pode-produzir";
import { entradaDeFluxo } from "@/lib/followup/porta";

import { POST } from "./route";

type Linha = Record<string, unknown>;
let chaves: Linha[] = [];
let chamadasDaRpc = 0;

const GRAFO_MANUAL = {
  nodes: [
    {
      id: "t",
      type: "trigger",
      label: "Início",
      position: { x: 0, y: 0 },
      config: { triggers: [{ kind: "manual" }], reentry: { policy: "skip_if_running", cooldown_minutes: 0 } },
    },
    { id: "f", type: "end", label: "Fim", position: { x: 0, y: 100 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "e1", source: "t", target: "f", priority: 0, condition: { type: "always" } }],
};

function admin() {
  function builder(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    let patch: Linha | null = null;
    let maiorQue: [string, unknown] | null = null;
    const casa = (l: Linha) =>
      filtros.every(([c, v]) => l[c] === v) && (maiorQue === null || String(l[maiorQue[0]]) > String(maiorQue[1]));
    const q = {
      select: () => q,
      insert: (v: Linha) => {
        chaves.push({ id: `chave-${chaves.length + 1}`, ...v });
        return { error: null };
      },
      update: (v: Linha) => ((patch = v), q),
      eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
      gt: (c: string, v: unknown) => ((maiorQue = [c, v]), q),
      maybeSingle: async () => {
        if (tabela === "followup_flow_pointers") {
          return { data: { id: POINTER, surface: "automacao", status: "active", active_version_id: VERSAO }, error: null };
        }
        if (tabela === "followup_flow_versions") return { data: { graph: GRAFO_MANUAL }, error: null };
        return { data: chaves.find(casa) ?? null, error: null };
      },
      then: (comOk: (v: unknown) => unknown, comErro: (e: unknown) => unknown) => {
        if (patch) {
          for (const l of chaves.filter(casa)) Object.assign(l, patch);
          patch = null;
        }
        return Promise.resolve({ data: null, error: null }).then(comOk, comErro);
      },
    };
    return q;
  }
  return {
    from: builder,
    rpc: async (nome: string) => {
      if (nome === "fn_automacao_iniciar") chamadasDaRpc += 1;
      return { data: { resultado: "iniciada", enrollment_id: "aaaaaaaa-7777-4000-8000-000000000001" }, error: null };
    },
  };
}

function req(body: unknown, chave?: string) {
  return new NextRequest(`http://localhost/api/v1/automacoes/${POINTER}/executar`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(chave ? { "Idempotency-Key": chave } : {}) },
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ id: POINTER }) };

beforeEach(() => {
  vi.clearAllMocks();
  chaves = [];
  chamadasDaRpc = 0;
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as Awaited<ReturnType<typeof checkRateLimit>>);
  vi.mocked(motivoDeNaoProduzir).mockResolvedValue(null);
  servidor.db = admin();
  vi.mocked(entradaDeFluxo).mockResolvedValue({
    requestId: "r1",
    authz: { via: "session", actor: { type: "user", id: "u1", role: "manager" }, organizationId: ORG },
    deps: { admin: servidor.db, organizationId: ORG, responsavel: "u1", t: (s: string) => s },
  } as unknown as Awaited<ReturnType<typeof entradaDeFluxo>>);
});

describe("executar automação: conta bloqueada (B9)", () => {
  it("assinatura suspensa: 402 e nenhuma execução aberta", async () => {
    vi.mocked(motivoDeNaoProduzir).mockResolvedValue("assinatura_suspensa");
    const r = await POST(req({ contact_id: CONTATO }), ctx);
    expect(r.status).toBe(402);
    expect(chamadasDaRpc).toBe(0);
  });

  it("organização suspensa pela plataforma: 403 e nenhuma execução aberta", async () => {
    vi.mocked(motivoDeNaoProduzir).mockResolvedValue("organizacao_inativa");
    const r = await POST(req({ contact_id: CONTATO }), ctx);
    expect(r.status).toBe(403);
    expect(chamadasDaRpc).toBe(0);
  });

  it("conta em dia: inicia (controle)", async () => {
    const r = await POST(req({ contact_id: CONTATO }), ctx);
    expect(r.status).toBe(201);
    expect(chamadasDaRpc).toBe(1);
  });
});

describe("executar automação: Idempotency-Key e teto de escrita (B13)", () => {
  it("a mesma chave duas vezes inicia UMA vez e devolve a mesma resposta", async () => {
    const r1 = await POST(req({ contact_id: CONTATO }, CHAVE), ctx);
    const r2 = await POST(req({ contact_id: CONTATO }, CHAVE), ctx);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect((await r2.json()).data).toEqual((await r1.json()).data);
    expect(chamadasDaRpc).toBe(1);
  });

  it("a mesma chave com outro contato: 409 sem iniciar", async () => {
    await POST(req({ contact_id: CONTATO }, CHAVE), ctx);
    const r = await POST(req({ contact_id: "aaaaaaaa-3333-4000-8000-000000000002" }, CHAVE), ctx);
    expect(r.status).toBe(409);
    expect(chamadasDaRpc).toBe(1);
  });

  it("chave que não é UUID: 400 sem iniciar", async () => {
    const r = await POST(req({ contact_id: CONTATO }, "nao-e-uuid"), ctx);
    expect(r.status).toBe(400);
    expect(chamadasDaRpc).toBe(0);
  });

  it("teto da sessão estourado: 429 com Retry-After, sem iniciar", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as Awaited<ReturnType<typeof checkRateLimit>>);
    const r = await POST(req({ contact_id: CONTATO }), ctx);
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBeTruthy();
    expect(chamadasDaRpc).toBe(0);
  });
});
