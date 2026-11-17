// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { STATUS_OPERANTE } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";

/**
 * POST /api/v1/bug-reports. O `requireRole` real roda (sessão e org ativa vêm do dublê de
 * `lib/auth/server`, como em `app/api/v1/marca/logo/route.test.ts`), o rate limit real roda no
 * contador em memória (não há Upstash no ambiente de teste) e o Supabase é um espião que guarda
 * o que foi inserido e enviado ao Storage. A linha entra pelo ADMIN client (a migration 1018 não
 * dá privilégio nenhum a `authenticated`), com organização e usuário da sessão.
 */
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  orgAtivaSemPortao: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
  mfaEmDividaEstrita: vi.fn(async () => false),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
let contadorDeUsuario = 0;
let userId = "";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);

const espiao = {
  inserts: [] as Array<{ tabela: string; valores: Record<string, unknown> }>,
  updates: [] as Array<Record<string, unknown>>,
  uploads: [] as Array<{ bucket: string; caminho: string; tipo: string }>,
  removidos: [] as string[],
  erroNoInsert: false,
  erroNoUpload: false,
  ordem: [] as string[],
};

function novoUsuario(): string {
  contadorDeUsuario += 1;
  return `11111111-1111-4111-8111-${String(contadorDeUsuario).padStart(12, "0")}`;
}

/** O multipart serializado de verdade, com o `content-length` que o navegador manda. */
async function requisicao(
  campos: Record<string, string | Blob>,
  tamanho: (n: number) => string | null = (n) => String(n),
): Promise<NextRequest> {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.set(k, v);
  const serializado = new Response(form);
  const corpo = new Uint8Array(await serializado.arrayBuffer());
  const headers = new Headers({ "content-type": serializado.headers.get("content-type") ?? "" });
  const declarado = tamanho(corpo.byteLength);
  if (declarado !== null) headers.set("content-length", declarado);
  return new NextRequest("http://localhost/api/v1/bug-reports", { method: "POST", body: corpo, headers });
}

const DESCRICAO = "O botão de salvar não responde na tela de contatos.";

beforeEach(() => {
  vi.clearAllMocks();
  espiao.inserts = [];
  espiao.uploads = [];
  espiao.removidos = [];
  espiao.updates = [];
  espiao.erroNoInsert = false;
  espiao.erroNoUpload = false;
  espiao.ordem = [];
  userId = novoUsuario();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: userId,
    email: "pessoa@exemplo.test",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [],
  } as never);
  vi.mocked(orgAtivaSemPortao).mockResolvedValue({
    orgId: ORG,
    name: "Empresa A",
    role: "viewer",
    org_status: STATUS_OPERANTE,
  } as never);
  vi.mocked(createClient).mockResolvedValue({
    // O papel efetivo que o `requireRole` real pergunta ao banco.
    rpc: async () => ({ data: "viewer", error: null }),
    // A sessão NÃO grava: se a rota voltar a inserir por aqui, o teste vê.
    from: (tabela: string) => ({
      insert: async () => {
        espiao.ordem.push(`sessao:${tabela}`);
        return { error: { message: "permission denied" } };
      },
    }),
  } as never);
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => ({
      insert: async (valores: Record<string, unknown>) => {
        espiao.ordem.push("insert");
        espiao.inserts.push({ tabela, valores });
        return { error: espiao.erroNoInsert ? { message: "falhou" } : null };
      },
      update: (valores: Record<string, unknown>) => {
        const filtro = { eq: () => filtro, then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r) };
        espiao.ordem.push("update");
        espiao.updates.push(valores);
        return filtro;
      },
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async (caminho: string, _b: unknown, o: { contentType: string }) => {
          espiao.ordem.push("upload");
          espiao.uploads.push({ bucket, caminho, tipo: o.contentType });
          return { error: espiao.erroNoUpload ? { message: "storage fora" } : null };
        },
        remove: async (caminhos: string[]) => {
          espiao.removidos.push(...caminhos);
          return { error: null };
        },
      }),
    },
  } as never);
});

describe("POST /api/v1/bug-reports", () => {
  it("sem sessão dá 401 e não grava nada", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null);
    const { POST } = await import("./route");
    const res = await POST(await requisicao({ description: DESCRICAO }));
    expect(res.status).toBe(401);
    expect(espiao.inserts).toEqual([]);
  });

  it("caminho feliz: grava com a organização da sessão e sobe o print em <org>/<id>.webp", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await requisicao({
        description: DESCRICAO,
        context: JSON.stringify({ url: "/app/contacts?aba=2", viewport: { largura: 1440, altura: 900 }, erros: ["x"] }),
        screenshot: new Blob([WEBP], { type: "image/webp" }),
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(espiao.uploads).toEqual([{ bucket: "bug-reports", caminho: `${ORG}/${data.id}.webp`, tipo: "image/webp" }]);
    expect(espiao.inserts).toHaveLength(1);
    expect(espiao.inserts[0]!.tabela).toBe("bug_reports");
    expect(espiao.inserts[0]!.valores).toMatchObject({
      id: data.id,
      organization_id: ORG,
      user_id: userId,
      description: DESCRICAO,
      page_url: "/app/contacts?aba=2",
      screenshot_path: null,
    });
    // A linha antes, o arquivo depois, o ponteiro por último — e nada pela sessão.
    expect(espiao.ordem).toEqual(["insert", "upload", "update"]);
    expect(espiao.updates).toEqual([{ screenshot_path: `${ORG}/${data.id}.webp` }]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "bug_report.created",
        organizationId: ORG,
        resourceId: data.id,
        metadata: { tela: "/app/contacts", tem_print: true },
      }),
    );
  });

  it("organization_id e user_id no corpo são ignorados", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await requisicao({ description: DESCRICAO, organization_id: OUTRA_ORG, user_id: "x", context: JSON.stringify({ organization_id: OUTRA_ORG }) }),
    );
    expect(res.status).toBe(201);
    expect(espiao.inserts[0]!.valores.organization_id).toBe(ORG);
    expect(espiao.inserts[0]!.valores.user_id).toBe(userId);
    expect(JSON.stringify(espiao.inserts[0]!.valores)).not.toContain(OUTRA_ORG);
  });

  it("sem print: grava com screenshot_path nulo e não sobe nada", async () => {
    const { POST } = await import("./route");
    const res = await POST(await requisicao({ description: DESCRICAO }));
    expect(res.status).toBe(201);
    expect(espiao.uploads).toEqual([]);
    expect(espiao.inserts[0]!.valores.screenshot_path).toBeNull();
  });

  it("descrição curta dá 400", async () => {
    const { POST } = await import("./route");
    const res = await POST(await requisicao({ description: "   curta   " }));
    expect(res.status).toBe(400);
    expect(espiao.inserts).toEqual([]);
  });

  it("arquivo que não é imagem (magic bytes) dá 400, mesmo declarando image/webp", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      await requisicao({ description: DESCRICAO, screenshot: new Blob([new TextEncoder().encode("<svg>oi</svg>")], { type: "image/webp" }) }),
    );
    expect(res.status).toBe(400);
    expect(espiao.uploads).toEqual([]);
    expect(espiao.inserts).toEqual([]);
  });

  it("arquivo acima de 3 MB dá 400", async () => {
    const grande = new Uint8Array(3 * 1024 * 1024 + 10);
    grande.set(PNG);
    const { POST } = await import("./route");
    const res = await POST(await requisicao({ description: DESCRICAO, screenshot: new Blob([grande], { type: "image/png" }) }));
    expect(res.status).toBe(400);
    expect(espiao.uploads).toEqual([]);
  });

  it("o 11º relato do mesmo usuário na hora dá 429 com Retry-After", async () => {
    const { POST } = await import("./route");
    for (let i = 0; i < 10; i += 1) {
      expect((await POST(await requisicao({ description: DESCRICAO }))).status).toBe(201);
    }
    const res = await POST(await requisicao({ description: DESCRICAO }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("falha ao gravar a linha dá 500 e não sobe arquivo nenhum", async () => {
    espiao.erroNoInsert = true;
    const { POST } = await import("./route");
    const res = await POST(await requisicao({ description: DESCRICAO, screenshot: new Blob([PNG], { type: "image/png" }) }));
    expect(res.status).toBe(500);
    expect(espiao.uploads).toEqual([]);
  });

  it("upload que falha deixa o relato sem print (201, sem ponteiro, sem órfão)", async () => {
    espiao.erroNoUpload = true;
    const { POST } = await import("./route");
    const res = await POST(await requisicao({ description: DESCRICAO, screenshot: new Blob([PNG], { type: "image/png" }) }));
    expect(res.status).toBe(201);
    expect(espiao.inserts[0]!.valores.screenshot_path).toBeNull();
    expect(espiao.updates).toEqual([]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ tem_print: false }) }));
  });

  it("page_url externo, `//host` ou com barra invertida dá 400", async () => {
    const { POST } = await import("./route");
    for (const url of ["https://golpe.test/x", "//golpe.test", "/\\golpe.test", "javascript:alert(1)"]) {
      const res = await POST(await requisicao({ description: DESCRICAO, context: JSON.stringify({ url }) }));
      expect(res.status, url).toBe(400);
    }
    expect(espiao.inserts).toEqual([]);
  });

  it("sem content-length, ou com lixo nele, dá 411 antes de ler o corpo", async () => {
    const { POST } = await import("./route");
    expect((await POST(await requisicao({ description: DESCRICAO }, () => null))).status).toBe(411);
    expect((await POST(await requisicao({ description: DESCRICAO }, () => "abc"))).status).toBe(411);
    expect(espiao.inserts).toEqual([]);
  });
});
