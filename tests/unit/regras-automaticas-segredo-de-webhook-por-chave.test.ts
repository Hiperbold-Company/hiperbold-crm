import { describe, expect, it, vi } from "vitest";

import { alterarRegra, criarRegra, type DepsDeRegras } from "@/lib/operacao/regras-automaticas-admin";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

/**
 * Editar `actions` por TOKEN/MCP não pode zerar em silêncio o segredo de um
 * `call_webhook`: a chave só lê `has_secret: true` (nunca o `secret_enc`) e, ao
 * reenviar a lista, não tinha como devolvê-lo. A pessoa (sessão) segue como era.
 */
const ORG = "00000000-0000-4000-8000-000000000001";
const REGRA = "00000000-0000-4000-8000-0000000000aa";
const URL = "https://exemplo.test/hook";

type Acao = { type: string; config?: Record<string, unknown> };

function montar(actionsGravadas: Acao[], ator: DepsDeRegras["actor"]) {
  const gravado: { patch?: Record<string, unknown>; inserido?: Record<string, unknown> } = {};
  const consulta: Record<string, unknown> = {
    select: () => consulta,
    eq: () => consulta,
    maybeSingle: async () => ({ data: { id: REGRA, actions: actionsGravadas }, error: null }),
    single: async () => ({
      data: { id: REGRA, ...(gravado.patch ?? gravado.inserido ?? {}) },
      error: null,
    }),
    update: (patch: Record<string, unknown>) => {
      gravado.patch = patch;
      return consulta;
    },
    insert: (linha: Record<string, unknown>) => {
      gravado.inserido = linha;
      return consulta;
    },
  };
  const deps = {
    supabase: { from: () => consulta },
    // Cifra de mentira, determinística: o que importa é QUEM chega a ela.
    admin: { rpc: async (_n: string, a: { plaintext: string }) => ({ data: `\\xCIFRA(${a.plaintext})`, error: null }) },
    organizationId: ORG,
    actor: ator,
    requestId: "req-1",
    responsavel: null,
  } as unknown as DepsDeRegras;
  return { deps, gravado };
}

const token = { type: "api_token", id: "tok-1" } as DepsDeRegras["actor"];
const pessoa = { type: "user", id: "u-1" } as DepsDeRegras["actor"];
const gravadas: Acao[] = [
  { type: "send_message", config: { text: "oi" } },
  { type: "call_webhook", config: { url: URL, secret_enc: "ABCDEF" } },
];

describe("regras automáticas: segredo de call_webhook ao editar por chave", () => {
  it("chave reenvia a ação sem `secret`: o secret_enc gravado é preservado", async () => {
    const { deps, gravado } = montar(gravadas, token);
    await alterarRegra(deps, REGRA, {
      actions: [
        { type: "send_message", config: { text: "oi" } },
        { type: "call_webhook", config: { url: URL, has_secret: true } },
      ],
    } as never);
    const wh = (gravado.patch?.actions as Acao[])[1]!;
    expect(wh.config).toEqual({ url: URL, secret_enc: "ABCDEF" });
    expect(wh.config).not.toHaveProperty("has_secret");
  });

  it("chave reenvia sem nem mandar has_secret: também preserva (não zera em silêncio)", async () => {
    const { deps, gravado } = montar(gravadas, token);
    await alterarRegra(deps, REGRA, {
      actions: [{ type: "send_message", config: { text: "oi" } }, { type: "call_webhook", config: { url: URL } }],
    } as never);
    expect((gravado.patch?.actions as Acao[])[1]!.config?.secret_enc).toBe("ABCDEF");
  });

  it("chave com `secret` novo: cifra o novo, não o antigo", async () => {
    const { deps, gravado } = montar(gravadas, token);
    await alterarRegra(deps, REGRA, {
      actions: [
        { type: "send_message", config: { text: "oi" } },
        { type: "call_webhook", config: { url: URL, secret: "novo-segredo" } },
      ],
    } as never);
    const wh = (gravado.patch?.actions as Acao[])[1]!;
    expect(wh.config?.secret_enc).toBe("CIFRA(novo-segredo)");
    expect(wh.config).not.toHaveProperty("secret");
  });

  it("chave com has_secret:false remove o segredo de propósito", async () => {
    const { deps, gravado } = montar(gravadas, token);
    await alterarRegra(deps, REGRA, {
      actions: [
        { type: "send_message", config: { text: "oi" } },
        { type: "call_webhook", config: { url: URL, has_secret: false } },
      ],
    } as never);
    expect((gravado.patch?.actions as Acao[])[1]!.config).toEqual({ url: URL });
  });

  it("ação que mudou de posição ou de url e já tinha segredo: 422, nada é gravado", async () => {
    const { deps, gravado } = montar(gravadas, token);
    await expect(
      alterarRegra(deps, REGRA, {
        actions: [
          { type: "call_webhook", config: { url: URL } },
          { type: "send_message", config: { text: "oi" } },
        ],
      } as never),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      alterarRegra(deps, REGRA, {
        actions: [
          { type: "send_message", config: { text: "oi" } },
          { type: "call_webhook", config: { url: "https://outro.test/hook" } },
        ],
      } as never),
    ).rejects.toMatchObject({ status: 422 });
    expect(gravado.patch).toBeUndefined();
  });

  it("chave não injeta secret_enc próprio: ele é descartado (e has_secret sem segredo gravado é 422)", async () => {
    const { deps, gravado } = montar([{ type: "send_message", config: { text: "oi" } }], token);
    await alterarRegra(deps, REGRA, {
      actions: [{ type: "call_webhook", config: { url: URL, secret_enc: "FORJADO" } }],
    } as never);
    expect((gravado.patch?.actions as Acao[])[0]!.config).toEqual({ url: URL });
    await expect(
      alterarRegra(deps, REGRA, { actions: [{ type: "call_webhook", config: { url: URL, has_secret: true } }] } as never),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("criar por chave também descarta secret_enc forjado", async () => {
    const { deps, gravado } = montar([], token);
    await criarRegra(deps, {
      name: "r",
      trigger_event: "message.received",
      conditions: [],
      actions: [{ type: "call_webhook", config: { url: URL, secret_enc: "FORJADO" } }],
    } as never);
    expect((gravado.inserido?.actions as Acao[])[0]!.config).toEqual({ url: URL });
  });

  it("PESSOA (sessão): o round-trip do editor com secret_enc segue passando intacto (controle)", async () => {
    const { deps, gravado } = montar(gravadas, pessoa);
    await alterarRegra(deps, REGRA, {
      actions: [
        { type: "send_message", config: { text: "oi" } },
        { type: "call_webhook", config: { url: URL, secret_enc: "ABCDEF" } },
      ],
    } as never);
    expect((gravado.patch?.actions as Acao[])[1]!.config).toEqual({ url: URL, secret_enc: "ABCDEF" });
  });
});
