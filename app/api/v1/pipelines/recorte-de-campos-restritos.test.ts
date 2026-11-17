/**
 * 1015: a DEFINIÇÃO de campo não público (`publico:false`) só vai para administrador — também pela
 * lista de funis e pela configuração de um funil.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";


vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { PIPE, authOk, funilRow, makeDb } from "@/tests/helpers/stages-db-double";

const CAMPOS = [
  { key: "cidade", label: "Cidade", type: "text" },
  { key: "renda", label: "Renda", type: "number", publico: false },
  { key: "origem", label: "Origem", type: "text", publico: true },
];

const funis = () => [
  funilRow({ id: PIPE, name: "Pedidos", slug: "pedidos", is_default: true, settings: { fields: CAMPOS, lost_reasons: ["x"] } }),
];

const chaves = (campos: Array<{ key: string }>) => campos.map((c) => c.key);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/pipelines — settings.fields por papel", () => {
  it("gerente não recebe o campo restrito; o resto de settings segue", async () => {
    authOk("manager");
    makeDb({ pipelines: funis() });
    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/v1/pipelines"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ settings: { fields: Array<{ key: string }>; lost_reasons: string[] } }> };
    expect(chaves(corpo.data[0]!.settings.fields)).toEqual(["cidade", "origem"]);
    expect(corpo.data[0]!.settings.lost_reasons).toEqual(["x"]);
  });

  it("administrador recebe tudo", async () => {
    authOk("admin");
    makeDb({ pipelines: funis() });
    const { GET } = await import("./route");
    const res = await GET(new NextRequest("http://localhost/api/v1/pipelines"));
    const corpo = (await res.json()) as { data: Array<{ settings: { fields: Array<{ key: string }> } }> };
    expect(chaves(corpo.data[0]!.settings.fields)).toEqual(["cidade", "renda", "origem"]);
  });
});

describe("GET /api/v1/pipelines/[id]/config — settings.fields por papel", () => {
  const ctx = () => ({ params: Promise.resolve({ id: PIPE }) });
  const req = () => new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/config`);

  it("gerente não recebe o campo restrito", async () => {
    authOk("manager");
    makeDb({ pipelines: funis() });
    const { GET } = await import("./[id]/config/route");
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { settings: { fields: Array<{ key: string }> } } };
    expect(chaves(corpo.data.settings.fields)).toEqual(["cidade", "origem"]);
  });

  it("administrador recebe tudo", async () => {
    authOk("admin");
    makeDb({ pipelines: funis() });
    const { GET } = await import("./[id]/config/route");
    const res = await GET(req(), ctx());
    const corpo = (await res.json()) as { data: { settings: { fields: Array<{ key: string }> } } };
    expect(chaves(corpo.data.settings.fields)).toEqual(["cidade", "renda", "origem"]);
  });
});
