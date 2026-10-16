import { describe, expect, it } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";
import { montarEmailDeConta, validarDados, type ContextoDoEmail } from "@/lib/email/conta-e-cobranca/montar";

/** COB-12: o texto do dono do produto, a data em dd/mm/aaaa, a variante manual e o formato dos dados. */
const MARCA: MarcaDeSaida = {
  nome: "Hiperbold CRM",
  logoUrl: "https://crm.exemplo.com.br/logo.png",
  accent: "#0139B0",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};
const ctx = (idioma: "pt-BR" | "es" = "pt-BR"): ContextoDoEmail => ({
  organizationId: "org",
  empresa: "Empresa do Diego",
  idioma,
  marca: MARCA,
  appUrl: "https://crm.exemplo.com.br",
  nome: null,
  base: (url) => ({ marca: MARCA, idioma, empresa: "Empresa do Diego", url }),
});

describe("COB-12, exclusão dos dados programada", () => {
  it("diz a data, o nome do CRM e as duas saídas (exportar ou reativar)", () => {
    const m = montarEmailDeConta("COB-12", { excluirEm: "2026-12-31", dias: 30, motivo: "cancelada" }, ctx());
    expect(m.subject).toBe("Seus dados serão excluídos em 31/12/2026");
    expect(m.text).toContain(
      "Seus dados no Hiperbold CRM serão excluídos em 31/12/2026. Exporte o que precisar em Configurações ou reative a assinatura para manter tudo.",
    );
    expect(m.text).toContain("https://crm.exemplo.com.br/app/settings/plano");
  });

  it("programação feita à mão não manda reativar uma assinatura que não existe", () => {
    const m = montarEmailDeConta("COB-12", { excluirEm: "2026-12-31", dias: 7, motivo: "manual" }, ctx());
    expect(m.text).not.toContain("reative a assinatura");
    expect(m.text).toContain("fale com a nossa equipe");
  });

  it("sai em espanhol", () => {
    const m = montarEmailDeConta("COB-12", { excluirEm: "2026-12-31", dias: 7, motivo: "suspensa" }, ctx("es"));
    expect(m.text).toContain("31/12/2026");
    expect(m.text).not.toContain("serão excluídos");
  });

  it("recusa dados fora do formato", () => {
    expect(() => validarDados("COB-12", { excluirEm: "31/12/2026", dias: 30, motivo: "cancelada" })).toThrow();
    expect(() => validarDados("COB-12", { excluirEm: "2026-12-31", dias: 15, motivo: "cancelada" })).toThrow();
    expect(() => validarDados("COB-12", { excluirEm: "2026-12-31", dias: 30, motivo: "outro" })).toThrow();
  });
});
