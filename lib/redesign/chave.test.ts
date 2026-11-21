import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A chave é lida pelo schema de `lib/env.ts` no import; por isso cada caso
 * reimporta os módulos com o ambiente do caso, em vez de mockar o `env`.
 */
async function lerCom(valor: string | undefined): Promise<boolean> {
  vi.resetModules();
  if (valor === undefined) {
    vi.stubEnv("REDESIGN_HIPERBOLD", "");
    delete process.env.REDESIGN_HIPERBOLD;
  } else {
    vi.stubEnv("REDESIGN_HIPERBOLD", valor);
  }
  const { redesignLigado } = await import("./chave");
  return redesignLigado();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("redesignLigado", () => {
  it("ausente → desligado", async () => {
    expect(await lerCom(undefined)).toBe(false);
  });

  it('"desligado" → desligado', async () => {
    expect(await lerCom("desligado")).toBe(false);
  });

  it('"ligado" → ligado', async () => {
    expect(await lerCom("ligado")).toBe(true);
  });

  it("valor torto não derruba o app e fica desligado", async () => {
    expect(await lerCom("true")).toBe(false);
    expect(await lerCom("LIGADO")).toBe(false);
  });
});
