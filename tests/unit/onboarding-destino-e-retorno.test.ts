/**
 * Funções puras do caminho "paga primeiro": a decisão do roteador, a pré-seleção do plano do site e a
 * URL de retorno do cartão. Comando: npx vitest run tests/unit/onboarding-destino-e-retorno.test.ts
 */
import { describe, expect, it } from "vitest";

import { planoPreSelecionado, sanitizarPlano } from "@/lib/auth/plano-escolhido";
import { urlDeRetornoDoCartao } from "@/lib/billing/asaas/retorno-do-cartao";
import {
  CAMINHO_DEPOIS_DE_PAGO,
  destinoDoRoteador,
  destinoSeJaConcluido,
} from "@/lib/onboarding/destino";

describe("destinoDoRoteador", () => {
  it("com passo pendente vai a ele, em qualquer caminho", () => {
    expect(destinoDoRoteador({ segmento: "plano" }, { pagarPrimeiro: true })).toEqual({
      tipo: "passo",
      caminho: "/onboarding/plano",
    });
    expect(destinoDoRoteador({ segmento: "welcome" }, { pagarPrimeiro: false })).toEqual({
      tipo: "passo",
      caminho: "/onboarding/welcome",
    });
  });

  it("sem passo pendente e paga-primeiro: conclui e entra no Início", () => {
    expect(destinoDoRoteador(null, { pagarPrimeiro: true })).toEqual({ tipo: "concluir", caminho: "/app/inicio" });
    expect(CAMINHO_DEPOIS_DE_PAGO).toBe("/app/inicio");
  });

  it("sem passo pendente no wizard antigo: a tela final, sem concluir sozinho", () => {
    expect(destinoDoRoteador(null, { pagarPrimeiro: false })).toEqual({ tipo: "passo", caminho: "/onboarding/done" });
  });
});

describe("destinoSeJaConcluido", () => {
  it("compra ligada: a entrada de /app decide entre Início e Inbox; desligada: o inbox", () => {
    expect(destinoSeJaConcluido(true)).toBe("/app");
    expect(destinoSeJaConcluido(false)).toBe("/app/inbox");
  });
});

describe("planoPreSelecionado: o ?plano= do site é só uma dica", () => {
  const AVENDA = ["pro", "max", "escale"];

  it("usa o da URL quando está à venda", () => {
    expect(planoPreSelecionado(AVENDA, ["max", "pro"])).toBe("max");
  });

  it("na falta da URL, cai para o que o cadastro guardou", () => {
    expect(planoPreSelecionado(AVENDA, [undefined, "pro"])).toBe("pro");
  });

  it("plano inválido, de forma estranha ou fora de venda é ignorado em silêncio — e o seguinte vale", () => {
    expect(planoPreSelecionado(AVENDA, ["enterprise", "max"])).toBe("max");
    expect(planoPreSelecionado(AVENDA, ["../../admin", "<script>", "", 42, null, ["x"]])).toBeNull();
    expect(planoPreSelecionado(AVENDA, ["a".repeat(41)])).toBeNull();
    expect(planoPreSelecionado([], ["pro"])).toBeNull();
  });

  it("normaliza caixa e espaços; ?plano=a&plano=b vale o primeiro", () => {
    expect(planoPreSelecionado(AVENDA, ["  MAX "])).toBe("max");
    expect(planoPreSelecionado(AVENDA, [["pro", "max"]])).toBe("pro");
    expect(sanitizarPlano("Pro")).toBe("pro");
  });

  it("o apelido 'scale' do site chega ao código 'escale' da cobrança", () => {
    expect(planoPreSelecionado(AVENDA, ["scale"])).toBe("escale");
    expect(planoPreSelecionado(["pro", "max"], ["scale"])).toBeNull();
  });
});

describe("urlDeRetornoDoCartao", () => {
  it("cliente novo volta ao passo de pagamento; quem já usa o CRM volta ao plano", () => {
    expect(urlDeRetornoDoCartao("https://crm.hiperbold.com.br", true)).toBe("https://crm.hiperbold.com.br/onboarding/plano");
    expect(urlDeRetornoDoCartao("https://crm.hiperbold.com.br", false)).toBe(
      "https://crm.hiperbold.com.br/app/settings/plano",
    );
  });

  it("usa só a origem: barra final, caminho e consulta da configuração não vazam para o retorno", () => {
    expect(urlDeRetornoDoCartao("https://crm.hiperbold.com.br/qualquer/coisa/?x=1", true)).toBe(
      "https://crm.hiperbold.com.br/onboarding/plano",
    );
  });

  it("base que não é http(s) válida: sem retorno, a compra segue como antes", () => {
    expect(urlDeRetornoDoCartao("não é url", true)).toBeUndefined();
    expect(urlDeRetornoDoCartao("javascript:alert(1)", true)).toBeUndefined();
  });
});
