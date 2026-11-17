import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { traduzir } from "@/lib/i18n/dicionario";
import { TenantForm } from "@/app/app/settings/tenant/_form";
import { ProfileForm } from "./_form";

/**
 * A tela de perfil em espanhol — o que ela MOSTRA e o que ela NÃO pode perder.
 *
 * 1. HIDRATAÇÃO: o form nascia em "pt-BR" sem receber o idioma salvo —
 *    salvar qualquer campo gravava pt-BR por cima. Sabotagem: remover
 *    `initialLocale` das props reprova o caso 1.
 * 2. VOZ: o espanhol é tuteio neutro ("Escribe", "Elige"). Reintroduzir
 *    voseo ("Escribí") reprova o caso 3.
 */

vi.mock("@/app/actions/settings/updateProfile", () => ({
  updateProfile: vi.fn(async () => ({ ok: true })),
}));

function renderForm(locale: "pt-BR" | "es" | "en", initialLocale: "pt-BR" | "es" | "en") {
  return render(
    <IdiomaProvider locale={locale}>
      <ProfileForm
        email="dona@empresa.com"
        initialFullName="Dona da Empresa"
        initialAvatarUrl={null}
        initialLocale={initialLocale}
        initialTimezone="America/Sao_Paulo"
      />
    </IdiomaProvider>,
  );
}

describe("ProfileForm em espanhol", () => {
  it("hidrata o idioma salvo — não nasce em pt-BR", () => {
    // Espanhol e inglês saíram do seletor em 17/11/2026, mas a página entrega o
    // idioma GRAVADO (`normalizarIdioma(user.locale)`) e `idiomasDoSeletor` o
    // acrescenta às opções: quem tem espanhol salvo o vê selecionado, e salvar
    // outro campo não troca o idioma da conta.
    renderForm("es", "es");
    // O Radix Select também espelha as opções num <select> nativo oculto (por
    // acessibilidade), então "Español" aparece nele mesmo sem ser o valor
    // selecionado — asserção tem que mirar o valor VISÍVEL do combobox, não o
    // texto solto, senão a sabotagem (remover initialLocale) não reprova nada.
    expect(screen.getByRole("combobox", { name: "Idioma" })).toHaveTextContent("Español");
  });

  it("o mesmo para quem tem inglês gravado", () => {
    renderForm("pt-BR", "en");
    expect(screen.getByRole("combobox", { name: "Idioma" })).toHaveTextContent("English");
  });

  it("com locale es, os rótulos vêm do dicionário", () => {
    renderForm("es", "es");
    expect(screen.getByText("Nombre completo")).toBeTruthy();
    expect(screen.getByText("Zona horaria")).toBeTruthy();
    expect(screen.queryByText("Nome completo")).toBeNull();
  });

  it("a voz do espanhol é tuteio neutro — voseo reprova", () => {
    expect(traduzir("Escreva uma mensagem…", "es")).toBe("Escribe un mensaje…");
    expect(traduzir("Escolha um modelo aprovado…", "es")).toBe("Elige una plantilla aprobada…");
  });
});

describe("TenantForm com idioma gravado fora do seletor", () => {
  it.each([
    ["es", "Español"],
    ["en", "English"],
  ] as const)("organização em %s: o Select mostra %s, e não pt-BR", (locale, nome) => {
    render(
      <IdiomaProvider locale="pt-BR">
        <TenantForm
          initial={{
            display_name: "Empresa",
            legal_name: "Empresa Ltda",
            cnpj: null,
            timezone: "America/Sao_Paulo",
            locale,
            currency: "BRL",
            media_retention_days: 365,
            media_retention_enforced: true,
            dpo_email: null,
            privacy_policy_url: null,
          }}
        />
      </IdiomaProvider>,
    );
    expect(screen.getByRole("combobox", { name: "Idioma" })).toHaveTextContent(nome);
  });
});
