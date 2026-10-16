/**
 * A fonte da chave do Jev, sobre linhas já lidas: a credencial própria da
 * organização vence, depois a da instalação, depois nada. Pura — não toca em env.
 */
import { describe, expect, it } from "vitest";

import { credencialEmUsoPeloJev, fonteDaChaveDoJev } from "./credencial";

const linha = (over: Partial<Parameters<typeof credencialEmUsoPeloJev>[0][number]> = {}) => ({
  provider: "typesafe",
  is_active: true,
  validated_at: "2026-10-01T00:00:00.000Z",
  created_at: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("fonteDaChaveDoJev", () => {
  it("a credencial validada da organização vence a da instalação", () => {
    const propria = linha();
    expect(fonteDaChaveDoJev([propria], true)).toEqual({ origem: "credencial_da_organizacao", credencial: propria });
  });

  it("sem credencial utilizável da organização, vale a da instalação", () => {
    for (const linhas of [
      [],
      [linha({ validated_at: null })],
      [linha({ is_active: false })],
      [linha({ provider: "openai" })],
    ]) {
      expect(fonteDaChaveDoJev(linhas, true)).toEqual({ origem: "chave_da_instalacao", credencial: null });
    }
  });

  it("sem as duas, nada: o caminho de sempre", () => {
    expect(fonteDaChaveDoJev([], false)).toBeNull();
    expect(fonteDaChaveDoJev([linha({ validated_at: null })], false)).toBeNull();
  });

  it("credencialEmUsoPeloJev continua respondendo só pela linha da organização", () => {
    expect(credencialEmUsoPeloJev([])).toBeNull();
  });
});
