/**
 * Exclusão em lote, exportação, contagem e lista de contatos — comportamento das rotas sobre um
 * banco em memória que aplica os filtros de verdade (ver `helpers/supabase-em-memoria.ts`).
 * Autenticação, guarda de suporte, rate limit e audit são os colaboradores trocados; o código sob
 * teste (`bulk-delete`, `export`, `count`, `excluir-em-lote`, `alvo-de-lote`, `consulta`, o handler
 * da lista) é o real.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";

import { clienteEmMemoria, criarBanco, type BancoEmMemoria } from "./helpers/supabase-em-memoria";

const auditSpy = vi.fn(async (_e: unknown) => undefined);
vi.mock("@/lib/audit", () => ({ audit: auditSpy, isServiceRoleConfigured: () => false }));

const suporteBarra = vi.fn(async (): Promise<Response | null> => null);
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: () => suporteBarra() }));

const requireRoleMock = vi.fn();
vi.mock("@/lib/auth/require-role", () => ({ requireRole: (...a: unknown[]) => requireRoleMock(...a) }));

const clienteDaSessao = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => clienteDaSessao() }));

const limite = vi.fn(async (_bucket: string, _n: number, _s: number) => ({ allowed: true }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: (b: string, n: number, s: number) => limite(b, n, s),
}));

vi.mock("@/lib/contacts/cpf-do-contato", () => ({
  idsPorHashDeCpf: vi.fn(async () => ({ ids: [], error: null })),
  idsComCpf: vi.fn(async () => ({ ids: new Set<string>(), error: null })),
}));

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "99999999-9999-4999-8999-999999999999";
const F1 = "f1111111-1111-4111-8111-111111111111";
const F2 = "f2222222-2222-4222-8222-222222222222";
const E1 = "e1111111-1111-4111-8111-111111111111";
const uid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let banco: BancoEmMemoria;

type Linha = Record<string, unknown>;
const contato = (n: number, extra: Linha = {}): Linha => ({
  id: uid(n),
  organization_id: ORG_A,
  display_name: `Contato A${n}`,
  email: `a${n}@exemplo.com`,
  phone_number: `+55359999${String(n).padStart(4, "0")}`,
  tags: [],
  source: "manual",
  is_merged_into: null,
  is_anonymized: false,
  created_at: "2026-10-10T12:00:00Z",
  last_activity_at: "2026-10-10T12:00:00Z",
  custom_fields: {},
  ...extra,
});

/** Preenche `leads` de cada contato a partir de crm_leads (o que o embed do PostgREST devolveria). */
function ligarLeads(b: BancoEmMemoria): BancoEmMemoria {
  for (const c of b.tabelas.contacts!) {
    c.leads = (b.tabelas.crm_leads ?? [])
      .filter((l) => l.contact_id === c.id)
      .map((l) => ({ pipeline_id: l.pipeline_id, stage_id: l.stage_id }));
  }
  return b;
}

function popular(): BancoEmMemoria {
  const contatos: Linha[] = [
    contato(1, { tags: ["vip"], custom_fields: { cargo: "Diretora", cpf: "111.222.333-44", rg: "MG-1", Documento: "x", passaporte: "p" } }),
    contato(2, { tags: ["vip"], created_at: "2026-09-01T12:00:00Z" }),
    contato(3, { custom_fields: { empresa: "50%_off*" } }),
    contato(4),
    contato(5, { source: "site", last_activity_at: "2026-10-18T12:00:00Z" }),
    contato(6, { is_anonymized: true }),
    contato(7, { is_merged_into: uid(1) }),
    contato(100, { organization_id: ORG_B, display_name: "Contato B1", tags: ["vip"] }),
  ];
  return ligarLeads(
    criarBanco({
      contacts: contatos,
      messages: [
        { id: "m1", organization_id: ORG_A, contact_id: uid(1) },
        { id: "m2", organization_id: ORG_B, contact_id: uid(100) },
      ],
      conversations: [
        { id: "cv1", organization_id: ORG_A, contact_id: uid(1) },
        { id: "cv2", organization_id: ORG_B, contact_id: uid(100) },
      ],
      calendar_appointments: [{ id: "ag1", organization_id: ORG_A, contact_id: uid(2) }],
      crm_leads: [
        // contato 4 tem DOIS negócios: um no funil F1 (utm instagram), outro no F2 (utm google)
        { id: "l1", organization_id: ORG_A, contact_id: uid(4), pipeline_id: F1, stage_id: E1, custom_fields: { utm_source: "instagram" } },
        { id: "l2", organization_id: ORG_A, contact_id: uid(4), pipeline_id: F2, stage_id: "e2", custom_fields: { utm_source: "google" } },
        // contato 5 tem UM negócio no F1 com utm google
        { id: "l3", organization_id: ORG_A, contact_id: uid(5), pipeline_id: F1, stage_id: E1, custom_fields: { utm_source: "Google Ads" } },
        { id: "l4", organization_id: ORG_B, contact_id: uid(100), pipeline_id: F1, stage_id: E1, custom_fields: { utm_source: "google" } },
      ],
      crm_pipelines: [{ id: F1, organization_id: ORG_A, name: "Vendas", settings: { fields: [{ key: "cargo", label: "Cargo" }] } }],
      crm_stages: [{ id: E1, organization_id: ORG_A, name: "Proposta" }],
    }),
  );
}

function sessaoComo(papel: "manager" | "agent"): void {
  if (papel === "agent") {
    requireRoleMock.mockResolvedValue({ ok: false, response: fail("forbidden_role", "Sem permissão.", 403, {}) });
    return;
  }
  requireRoleMock.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG_A, timezone: "America/Sao_Paulo", role: "manager" },
  });
  clienteDaSessao.mockResolvedValue(clienteEmMemoria(banco));
}

function post(url: string, corpo: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}
const get = (url: string) => new NextRequest(`http://localhost${url}`);

const ids = (b: BancoEmMemoria) => (b.tabelas.contacts ?? []).map((c) => c.id as string);

beforeEach(() => {
  vi.clearAllMocks();
  limite.mockResolvedValue({ allowed: true });
  suporteBarra.mockResolvedValue(null);
  banco = popular();
  sessaoComo("manager");
});

describe("POST /api/v1/contacts/bulk-delete", () => {
  it("exclui os selecionados: mensagens, conversas e ficha; emite contact.deleted por contato", async () => {
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    const res = await POST(post("/api/v1/contacts/bulk-delete", { ids: [uid(1), uid(3)] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ excluidos: 2, bloqueados: 0, ignorados: 0, inexistentes: 0 });
    expect(ids(banco)).not.toContain(uid(1));
    expect(ids(banco)).not.toContain(uid(3));
    expect(banco.tabelas.messages!.map((m) => m.id)).toEqual(["m2"]);
    expect(banco.tabelas.conversations!.map((c) => c.id)).toEqual(["cv2"]);
    expect(banco.chamadasRpc.filter((r) => r.nome === "emit_event" && r.args.p_event_type === "contact.deleted")).toHaveLength(2);
  });

  it("contato com compromisso na agenda NÃO é apagado e nada dele é tocado", async () => {
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    const res = await POST(post("/api/v1/contacts/bulk-delete", { ids: [uid(2), uid(4)] }));
    expect(((await res.json()) as { data: unknown }).data).toEqual({ excluidos: 1, bloqueados: 1, ignorados: 0, inexistentes: 0 });
    expect(ids(banco)).toContain(uid(2));
    expect(ids(banco)).not.toContain(uid(4));
  });

  it("anonimizado e lápide de fusão NÃO são apagados (o lote só opera contato vivo)", async () => {
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    const res = await POST(post("/api/v1/contacts/bulk-delete", { ids: [uid(6), uid(7), uid(3)] }));
    expect(((await res.json()) as { data: unknown }).data).toEqual({ excluidos: 1, bloqueados: 0, ignorados: 2, inexistentes: 0 });
    expect(ids(banco)).toContain(uid(6));
    expect(ids(banco)).toContain(uid(7));
  });

  it("ISOLAMENTO: id de outra organização não é apagado nem tocado, e toda consulta leva a organização", async () => {
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    const res = await POST(post("/api/v1/contacts/bulk-delete", { ids: [uid(100), uid(3)] }));
    expect(((await res.json()) as { data: unknown }).data).toEqual({ excluidos: 1, bloqueados: 0, ignorados: 0, inexistentes: 1 });
    expect(ids(banco)).toContain(uid(100));
    expect(banco.tabelas.messages!.map((m) => m.id)).toContain("m2");
    expect(banco.tabelas.conversations!.map((c) => c.id)).toContain("cv2");
    for (const q of banco.consultas) {
      expect(q.filtros.some(([op, col, val]) => op === "eq" && col === "organization_id" && val === ORG_A), `${q.tabela}/${q.operacao}`).toBe(true);
    }
    const rpc = banco.chamadasRpc.find((r) => r.nome === "fn_excluir_contatos_em_lote")!;
    expect(rpc.args.p_organization_id).toBe(ORG_A);
  });

  it("organization_id no corpo é ignorado: a organização vem da sessão", async () => {
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    await POST(post("/api/v1/contacts/bulk-delete", { ids: [uid(100)], organization_id: ORG_B }));
    expect(ids(banco)).toContain(uid(100));
  });

  it("reenvio é seguro: o que já foi apagado conta como inexistente", async () => {
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    await POST(post("/api/v1/contacts/bulk-delete", { ids: [uid(1)] }));
    const res = await POST(post("/api/v1/contacts/bulk-delete", { ids: [uid(1)] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ excluidos: 0, bloqueados: 0, ignorados: 0, inexistentes: 1 });
  });

  it("todos do filtro: o servidor resolve o filtro, na organização, e apaga só esse conjunto", async () => {
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    // vivos da org A com origem manual: 1,2,3,4 (6 é anonimizado, 7 é lápide, 5 é "site")
    const res = await POST(post("/api/v1/contacts/bulk-delete", { filtro: { source: "manual" }, esperado: 4 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { excluidos: number; bloqueados: number } }).data).toMatchObject({ excluidos: 3, bloqueados: 1 });
    expect(ids(banco)).toEqual(expect.arrayContaining([uid(2), uid(5), uid(6), uid(7), uid(100)]));
  });

  it("todos do filtro: contagem diferente da que a pessoa viu → 409 e nada é apagado", async () => {
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    const res = await POST(post("/api/v1/contacts/bulk-delete", { filtro: { source: "manual" }, esperado: 99 }));
    expect(res.status).toBe(409);
    expect(banco.tabelas.contacts).toHaveLength(8);
    expect(banco.chamadasRpc).toHaveLength(0);
  });

  it("acima do teto de 5.000 → 422, sem tocar em nada", async () => {
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    const lista = Array.from({ length: 5_001 }, (_, i) => uid(i + 1000));
    const res = await POST(post("/api/v1/contacts/bulk-delete", { ids: lista }));
    expect(res.status).toBe(422);
    expect(banco.consultas).toHaveLength(0);
  });

  it("corpo inválido → 422 (id que não é uuid, lista vazia, campo sem valor, data absurda, campo de documento)", async () => {
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    for (const corpo of [
      { ids: ["x"] },
      { ids: [] },
      { filtro: { campo: "cargo" }, esperado: 1 },
      { filtro: { criado_ate: "9999-12-31" }, esperado: 1 },
      { filtro: { campo: "cpf", campo_valor: "1" }, esperado: 1 },
      {},
    ]) {
      expect((await POST(post("/api/v1/contacts/bulk-delete", corpo))).status, JSON.stringify(corpo)).toBe(422);
    }
  });

  it("acompanhamento de suporte somente-leitura não apaga: a guarda vem antes de qualquer efeito", async () => {
    suporteBarra.mockResolvedValue(fail("support_readonly", "Somente leitura.", 403, {}));
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    const res = await POST(post("/api/v1/contacts/bulk-delete", { ids: [uid(1)] }));
    expect(res.status).toBe(403);
    expect(requireRoleMock).not.toHaveBeenCalled();
    expect(banco.consultas).toHaveLength(0);
  });

  it("atendente NÃO apaga em lote: o piso é gerente e nada é tocado", async () => {
    sessaoComo("agent");
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    const res = await POST(post("/api/v1/contacts/bulk-delete", { ids: [uid(1)] }));
    expect(res.status).toBe(403);
    expect(requireRoleMock.mock.calls[0]![0]).toBe("manager");
    expect(banco.consultas).toHaveLength(0);
  });

  it("limite de chamadas por usuário: estourou → 429, nada é tocado", async () => {
    limite.mockResolvedValue({ allowed: false });
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    const res = await POST(post("/api/v1/contacts/bulk-delete", { ids: [uid(1)] }));
    expect(res.status).toBe(429);
    expect(limite.mock.calls[0]![0]).toBe(`contacts:bulk-delete:${USER}`);
    expect(banco.consultas).toHaveLength(0);
  });

  it("audita UMA linha com contagens, ids e resumo do filtro — sem texto pessoal", async () => {
    const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
    await POST(post("/api/v1/contacts/bulk-delete", { filtro: { source: "manual", search: "Contato A1" }, esperado: 1 }));
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const entrada = auditSpy.mock.calls[0]![0] as { action: string; organizationId: string; metadata: Record<string, unknown> };
    expect(entrada.action).toBe("contacts.bulk_deleted");
    expect(entrada.organizationId).toBe(ORG_A);
    expect(entrada.metadata).toMatchObject({ modo: "filtro", excluidos: 1, filtro: { busca: true, origem: "manual" } });
    expect(JSON.stringify(entrada.metadata)).not.toContain("Contato A1");
    expect(JSON.stringify(entrada.metadata)).not.toContain("@exemplo.com");
  });

  describe("blocos de 20, cada um tudo-ou-nada", () => {
    function comMuitos(n: number): number[] {
      const extras = Array.from({ length: n }, (_, i) => contato(1000 + i));
      banco.tabelas.contacts!.push(...extras);
      for (const e of extras) banco.tabelas.messages!.push({ id: `mm${e.id}`, organization_id: ORG_A, contact_id: e.id });
      return extras.map((_, i) => 1000 + i);
    }

    it("45 ids viram 3 chamadas à função (20 + 20 + 5), nunca mais de 20 por vez", async () => {
      const nums = comMuitos(45);
      const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
      const res = await POST(post("/api/v1/contacts/bulk-delete", { ids: nums.map(uid) }));
      expect(res.status).toBe(200);
      const chamadas = banco.chamadasRpc.filter((r) => r.nome === "fn_excluir_contatos_em_lote");
      expect(chamadas.map((c) => (c.args.p_contact_ids as string[]).length)).toEqual([20, 20, 5]);
      expect(((await res.json()) as { data: { excluidos: number } }).data.excluidos).toBe(45);
    });

    it("falha no 2º bloco: o 1º ficou apagado inteiro, o 2º NÃO foi tocado, o 3º nem foi tentado", async () => {
      const nums = comMuitos(45);
      banco.falhaNaExclusaoDoBloco = 2;
      const { POST } = await import("@/app/api/v1/contacts/bulk-delete/route");
      const res = await POST(post("/api/v1/contacts/bulk-delete", { ids: nums.map(uid) }));
      expect(res.status).toBe(500);
      const vivos = new Set(ids(banco));
      expect(nums.slice(0, 20).every((n) => !vivos.has(uid(n)))).toBe(true);
      expect(nums.slice(20).every((n) => vivos.has(uid(n)))).toBe(true);
      // mensagens do 2º bloco continuam lá: nada meio apagado
      const msgs = new Set(banco.tabelas.messages!.map((m) => m.contact_id));
      expect(nums.slice(20).every((n) => msgs.has(uid(n)))).toBe(true);
      expect(banco.chamadasRpc.filter((r) => r.nome === "fn_excluir_contatos_em_lote")).toHaveLength(2);
      const entrada = auditSpy.mock.calls[0]![0] as { metadata: Record<string, unknown> };
      expect(entrada.metadata).toMatchObject({ interrompido: true, excluidos: 20 });
      expect((entrada.metadata.falhou as string[]).length).toBe(20);
    });
  });
});

describe("POST /api/v1/contacts/export", () => {
  it("manager exporta os selecionados: CSV com BOM, sem documentos, só da organização", async () => {
    const { POST } = await import("@/app/api/v1/contacts/export/route");
    const res = await POST(post("/api/v1/contacts/export", { ids: [uid(1), uid(100)] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-contatos-exportados")).toBe("1");
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = await res.text();
    expect(csv).toContain("Contato A1");
    expect(csv).toContain("Diretora");
    expect(csv).not.toContain("Contato B1"); // outra organização
    // CPF, RG, documento e passaporte guardados como campo livre nunca saem
    expect(csv).not.toMatch(/cpf|111\.222\.333-44|MG-1|passaporte|documento|\brg\b/i);
  });

  it("não exporta anonimizado nem lápide de fusão", async () => {
    const { POST } = await import("@/app/api/v1/contacts/export/route");
    expect((await POST(post("/api/v1/contacts/export", { ids: [uid(6)] }))).status).toBe(404);
    expect((await POST(post("/api/v1/contacts/export", { ids: [uid(7)] }))).status).toBe(404);
  });

  it("todos do filtro com `esperado` diferente → 409; igual → exporta", async () => {
    const { POST } = await import("@/app/api/v1/contacts/export/route");
    const errado = await POST(post("/api/v1/contacts/export", { filtro: { source: "manual" }, esperado: 99 }));
    expect(errado.status).toBe(409);
    const certo = await POST(post("/api/v1/contacts/export", { filtro: { source: "manual" }, esperado: 4 }));
    expect(certo.status).toBe(200);
    expect(certo.headers.get("x-contatos-exportados")).toBe("4");
  });

  it("atendente não exporta: o piso é gerente e nada é lido", async () => {
    sessaoComo("agent");
    const { POST } = await import("@/app/api/v1/contacts/export/route");
    const res = await POST(post("/api/v1/contacts/export", { ids: [uid(1)] }));
    expect(res.status).toBe(403);
    expect(requireRoleMock.mock.calls[0]![0]).toBe("manager");
    expect(banco.consultas).toHaveLength(0);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("suporte somente-leitura não leva a base para fora", async () => {
    suporteBarra.mockResolvedValue(fail("support_readonly", "Somente leitura.", 403, {}));
    const { POST } = await import("@/app/api/v1/contacts/export/route");
    expect((await POST(post("/api/v1/contacts/export", { ids: [uid(1)] }))).status).toBe(403);
    expect(banco.consultas).toHaveLength(0);
  });

  it("limite de chamadas por usuário: estourou → 429", async () => {
    limite.mockResolvedValue({ allowed: false });
    const { POST } = await import("@/app/api/v1/contacts/export/route");
    expect((await POST(post("/api/v1/contacts/export", { ids: [uid(1)] }))).status).toBe(429);
    expect(limite.mock.calls[0]![0]).toBe(`contacts:export:${USER}`);
    expect(banco.consultas).toHaveLength(0);
  });

  it("audita contacts.exported com a contagem e sem dado pessoal", async () => {
    const { POST } = await import("@/app/api/v1/contacts/export/route");
    await POST(post("/api/v1/contacts/export", { filtro: { source: "manual" } }));
    const entrada = auditSpy.mock.calls[0]![0] as { action: string; actorUserId: string; metadata: Record<string, unknown> };
    expect(entrada.action).toBe("contacts.exported");
    expect(entrada.actorUserId).toBe(USER);
    expect(entrada.metadata).toMatchObject({ modo: "filtro", linhas: 4, filtro: { origem: "manual" } });
    expect(JSON.stringify(entrada.metadata)).not.toContain("a1@exemplo.com");
  });

  it("acima de 20.000 ids → 422", async () => {
    const { POST } = await import("@/app/api/v1/contacts/export/route");
    const lista = Array.from({ length: 20_001 }, (_, i) => uid(i + 5000));
    expect((await POST(post("/api/v1/contacts/export", { ids: lista }))).status).toBe(422);
  });
});

/**
 * LISTA, CONTAGEM, LOTE e EXPORTAÇÃO concordam sobre "quem é o conjunto": a mesma consulta
 * (`consultaDeContatos`) sob cada uma. Cada caso é um filtro; o esperado é escrito À MÃO a partir
 * dos dados, não calculado pelo código sob teste.
 */
describe("lista, contagem, lote e exportação concordam", () => {
  const AGORA = new Date("2026-10-19T15:00:00Z");

  const casos: Array<{ nome: string; filtro: Record<string, string>; esperado: number[] }> = [
    { nome: "etiqueta vip", filtro: { tag: "vip" }, esperado: [1, 2] },
    { nome: "entrou no CRM em setembro (de/até)", filtro: { criado_de: "2026-09-01", criado_ate: "2026-09-30" }, esperado: [2] },
    { nome: "última atividade de/até 18/10", filtro: { ativ_de: "2026-10-18", ativ_ate: "2026-10-18" }, esperado: [5] },
    { nome: "funil F1", filtro: { funil: F1 }, esperado: [4, 5] },
    { nome: "funil F1 + etapa E1", filtro: { funil: F1, etapa: E1 }, esperado: [4, 5] },
    { nome: "campo do contato 'cargo contém dir'", filtro: { campo: "cargo", campo_valor: "dir" }, esperado: [1] },
    { nome: "campo do contato igual (sem curinga)", filtro: { campo: "cargo", campo_op: "igual", campo_valor: "dir" }, esperado: [] },
    { nome: "campo do negócio utm_source contém google", filtro: { campo_escopo: "negocio", campo: "utm_source", campo_valor: "google" }, esperado: [4, 5] },
    // O defeito que a junção única corrige: o contato 4 tem um negócio no F1 (instagram) e OUTRO
    // com google no F2; "funil F1 E google" tem de casar o MESMO negócio — só o contato 5.
    { nome: "funil F1 + utm google no MESMO negócio", filtro: { funil: F1, campo_escopo: "negocio", campo: "utm_source", campo_valor: "google" }, esperado: [5] },
    { nome: "% e _ no valor são literais", filtro: { campo: "empresa", campo_valor: "50%_off" }, esperado: [3] },
    { nome: "% sozinho NÃO é curinga", filtro: { campo: "empresa", campo_valor: "%" }, esperado: [3] },
    { nome: "* é texto, não curinga", filtro: { campo: "empresa", campo_valor: "off*" }, esperado: [3] },
    // Se `*` valesse como curinga ("50, qualquer coisa, off") isto casaria o contato 3; como texto, não.
    { nome: "* no meio não casa 'qualquer coisa'", filtro: { campo: "empresa", campo_valor: "50*off" }, esperado: [] },
  ];

  for (const caso of casos) {
    it(caso.nome, async () => {
      // vivos da org A (anonimizado 6 e lápide 7 fora de todos)
      const esperadoIds = caso.esperado.map(uid).sort();

      const { consultaDeContatos, contarContatos, idsDoFiltro } = await import("@/lib/contacts/consulta");
      const { filtrosDeContatosSchema } = await import("@/lib/schemas");
      const filtro = filtrosDeContatosSchema.parse(caso.filtro);
      const cliente = clienteEmMemoria(banco);
      const ctx = { organizationId: ORG_A, requestId: "r", timezone: "America/Sao_Paulo", agora: AGORA, somenteOperaveis: true };

      // contagem
      expect(await contarContatos(cliente, filtro, ctx)).toBe(esperadoIds.length);
      // ids do filtro
      expect((await idsDoFiltro(cliente, filtro, ctx, 5000)).ids.sort()).toEqual(esperadoIds);

      // lista (o handler real); a lista mostra também o anonimizado — nenhum dos casos o alcança
      const { listContactsHandler } = await import("@/app/api/v1/contacts/_handler");
      const lista = await listContactsHandler(
        cliente,
        { organization_id: ORG_A, actor: { type: "user", id: USER }, requestId: "r" },
        { ...caso.filtro, limit: 100 },
        { timezone: "America/Sao_Paulo" },
      );
      expect(lista.contacts.map((c) => c.id).sort()).toEqual(esperadoIds);
      expect(lista.contacts.every((c) => !("lf" in c))).toBe(true);

      // consulta com junção devolve o contato UMA vez (sem duplicar por negócio)
      const { query } = await consultaDeContatos(cliente, "id", filtro, ctx);
      const { data } = await query;
      expect((data as unknown as Array<{ id: string }>).length).toBe(esperadoIds.length);

      if (esperadoIds.length === 0) return;

      // exportação (todos do filtro, com o esperado que a tela mandaria)
      const { POST: exportar } = await import("@/app/api/v1/contacts/export/route");
      const exp = await exportar(post("/api/v1/contacts/export", { filtro: caso.filtro, esperado: esperadoIds.length }));
      expect(exp.status).toBe(200);
      expect(exp.headers.get("x-contatos-exportados")).toBe(String(esperadoIds.length));

      // lote (todos do filtro): apaga exatamente o conjunto, menos quem tem compromisso na agenda (contato 2)
      const { POST: excluir } = await import("@/app/api/v1/contacts/bulk-delete/route");
      const antes = new Set(ids(banco));
      const del = await excluir(post("/api/v1/contacts/bulk-delete", { filtro: caso.filtro, esperado: esperadoIds.length }));
      expect(del.status).toBe(200);
      const apagados = [...antes].filter((i) => !new Set(ids(banco)).has(i)).sort();
      expect(apagados).toEqual(esperadoIds.filter((i) => i !== uid(2)));
    });
  }

  it("período 'hoje' é o dia da organização (fuso), igual na contagem e no lote", async () => {
    // 19/10 15:00Z é 12:00 em São Paulo; o contato 5 teve atividade em 18/10 12:00Z (09:00 do dia 18).
    const { contarContatos } = await import("@/lib/contacts/consulta");
    const { filtrosDeContatosSchema } = await import("@/lib/schemas");
    const cliente = clienteEmMemoria(banco);
    const ctx = { organizationId: ORG_A, requestId: "r", timezone: "America/Sao_Paulo", agora: AGORA, somenteOperaveis: true };
    expect(await contarContatos(cliente, filtrosDeContatosSchema.parse({ ativ: "hoje" }), ctx)).toBe(0);
    // 7 dias = 13/10..19/10: só o contato 5 (18/10); 1..4 ficaram em 10/10. 30 dias pega os cinco vivos.
    expect(await contarContatos(cliente, filtrosDeContatosSchema.parse({ ativ: "7d" }), ctx)).toBe(1);
    expect(await contarContatos(cliente, filtrosDeContatosSchema.parse({ ativ: "30d" }), ctx)).toBe(5);
  });

  it("a rota de contagem não conta anonimizado nem lápide, e é a mesma conta do lote", async () => {
    const { GET } = await import("@/app/api/v1/contacts/count/route");
    const r = await GET(get("/api/v1/contacts/count"));
    expect(((await r.json()) as { data: { total: number } }).data.total).toBe(5); // 1..5; 6 anonimizado e 7 lápide fora
    const r2 = await GET(get("/api/v1/contacts/count?campo_escopo=negocio&campo=utm_source&campo_valor=google&funil=" + F1));
    expect(((await r2.json()) as { data: { total: number } }).data.total).toBe(1);
  });
});
