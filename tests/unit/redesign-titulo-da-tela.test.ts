import { describe, expect, it } from "vitest";

import { estaEm, tituloDaTela } from "@/components/shell/redesign/navegacao";
import { searchable } from "@/lib/navigation/registry";

describe("tituloDaTela (faixa do celular em Configurações)", () => {
  const visiveis = searchable(false, "admin", undefined, [], []);
  const atualDe = (p: string) =>
    visiveis.filter((d) => estaEm(p, d.href)).sort((a, b) => b.href.length - a.href.length)[0];

  it("o hub /app/settings se chama Configurações", () => {
    expect(atualDe("/app/settings")).toBeUndefined();
    expect(tituloDaTela("/app/settings", undefined)).toBe("Configurações");
  });
  it("telas de Configurações sem porta no catálogo também", () => {
    expect(tituloDaTela("/app/settings/billing", atualDe("/app/settings/billing"))).toBe("Configurações");
    expect(tituloDaTela("/app/settings/templates", atualDe("/app/settings/templates"))).toBe("Configurações");
  });
  it("tela com porta no catálogo usa o nome dela", () => {
    expect(tituloDaTela("/app/settings/profile", atualDe("/app/settings/profile"))).toBe("Perfil");
  });
  it("fora de Configurações sem destino, continua sem nome", () => {
    expect(tituloDaTela("/app/outra-coisa", undefined)).toBeUndefined();
    expect(tituloDaTela("/app/settingsx", undefined)).toBeUndefined();
  });
});
