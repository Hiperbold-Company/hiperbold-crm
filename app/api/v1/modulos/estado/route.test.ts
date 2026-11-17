/**
 * POST /api/v1/modulos/estado — desligar e religar um módulo de tabela (migration 1016). O mesmo
 * gate e o mesmo contrato do instalar: só o administrador da instalação, `Idempotency-Key`
 * obrigatório, e o estado que a tela viu vai junto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { requireExtensionPlatform } from "@/lib/extensions/http";
import { definirEstadoDoModulo } from "@/lib/modulos/service";

vi.mock("@/lib/extensions/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extensions/http")>()),
  requireExtensionPlatform: vi.fn(),
}));
vi.mock("@/lib/modulos/service", () => ({
  ESTADOS_DO_MODULO: ["ativo", "suspenso", "desligado"],
  definirEstadoDoModulo: vi.fn(),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ACTOR = "11111111-1111-4111-8111-111111111111";
const OPERATION = "22222222-2222-4222-8222-222222222222";

function req(body: unknown, headers: HeadersInit = { "Idempotency-Key": OPERATION }): Request {
  return new Request("http://localhost/api/v1/modulos/estado", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

function admin(): void {
  vi.mocked(requireExtensionPlatform).mockResolvedValue({ ok: true, user: { id: ACTOR } as never });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/modulos/estado", () => {
  it("administrador da instalação desliga, passando o estado que a tela viu", async () => {
    admin();
    vi.mocked(definirEstadoDoModulo).mockResolvedValue({ operationId: OPERATION, appliedNow: true });

    const { POST } = await import("./route");
    const res = await POST(req({ modulo: "financeiro", ligado: false, estado_visto: "ativo" }));

    expect(res.status).toBe(200);
    expect(definirEstadoDoModulo).toHaveBeenCalledWith(ACTOR, OPERATION, "financeiro", false, "ativo");
  });

  it("quem não é administrador da instalação recebe 403, sem chamar o serviço", async () => {
    vi.mocked(requireExtensionPlatform).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "Só o administrador da instalação pode gerenciar os pacotes.", 403),
    });

    const { POST } = await import("./route");
    const res = await POST(req({ modulo: "financeiro", ligado: false, estado_visto: "ativo" }));

    expect(res.status).toBe(403);
    expect(definirEstadoDoModulo).not.toHaveBeenCalled();
  });

  it("sem Idempotency-Key, ou sem o estado visto, é 422 e nada muda", async () => {
    admin();
    const { POST } = await import("./route");

    const semChave = await POST(req({ modulo: "financeiro", ligado: false, estado_visto: "ativo" }, {}));
    const semEstado = await POST(req({ modulo: "financeiro", ligado: false }));

    expect(semChave.status).toBe(422);
    expect(semEstado.status).toBe(422);
    expect(definirEstadoDoModulo).not.toHaveBeenCalled();
  });
});
