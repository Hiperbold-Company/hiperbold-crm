import { describe, expect, it } from "vitest";

import { montarComponents } from "@/lib/channels/template-conteudo";
import { exportarModeloJson, importarModeloJson } from "./modelo-json";

/**
 * O JSON do modelo no painel do chat: importa o formato da Meta, recusa o que
 * está fora dele com mensagem legível, e o exportado volta igual.
 */
const VALIDO = {
  name: "boas_vindas",
  language: "pt_BR",
  category: "UTILITY",
  components: [
    { type: "HEADER", format: "TEXT", text: "Olá" },
    { type: "BODY", text: "Oi {{1}}, seu pedido saiu.", example: { body_text: [["Ana"]] } },
    { type: "FOOTER", text: "Equipe" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "Obrigado" },
        { type: "URL", text: "Rastrear", url: "https://loja.test/r" },
        { type: "PHONE_NUMBER", text: "Ligar", phone_number: "+5511999999999" },
      ],
    },
  ],
};

describe("importarModeloJson", () => {
  it("importa um modelo válido no formato da Meta", () => {
    const r = importarModeloJson(JSON.stringify(VALIDO));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.modelo.name).toBe("boas_vindas");
      expect(r.modelo.components).toHaveLength(4);
    }
  });

  it("exportar e importar fecham a ida e volta com o que o formulário monta", () => {
    const components = montarComponents({ body: "Oi {{1}}", exemplos: ["Ana"], footer: "Equipe", botoes: [] });
    const texto = exportarModeloJson({ name: "oi", language: "es", category: "MARKETING", components });
    const r = importarModeloJson(texto);
    expect(r).toEqual({ ok: true, modelo: { name: "oi", language: "es", category: "MARKETING", components } });
  });

  it("recusa texto que não é JSON, sem lançar", () => {
    expect(importarModeloJson("{ nome: ")).toEqual({ ok: false, erro: "O texto colado não é um JSON válido.", campo: null });
  });

  it("recusa categoria fora da lista e diz o campo", () => {
    const r = importarModeloJson(JSON.stringify({ ...VALIDO, category: "PROMO" }));
    expect(r).toMatchObject({ ok: false, campo: "category" });
    if (!r.ok) expect(r.erro).toMatch(/Categoria inválida/);
  });

  it("recusa corpo acima do limite da Meta apontando o componente", () => {
    const longo = { ...VALIDO, components: [{ type: "BODY", text: "x".repeat(1025) }] };
    expect(importarModeloJson(JSON.stringify(longo))).toEqual({
      ok: false,
      erro: "O corpo passa de 1024 caracteres.",
      campo: "components.0.text",
    });
  });

  it("recusa modelo sem corpo, nome com maiúscula e botão de link sem https", () => {
    const semCorpo = { ...VALIDO, components: [{ type: "FOOTER", text: "x" }] };
    expect(importarModeloJson(JSON.stringify(semCorpo))).toMatchObject({ ok: false, erro: "O modelo precisa de exatamente um corpo (BODY)." });
    expect(importarModeloJson(JSON.stringify({ ...VALIDO, name: "Boas Vindas" }))).toMatchObject({ ok: false, campo: "name" });
    const linkHttp = {
      ...VALIDO,
      components: [VALIDO.components[1], { type: "BUTTONS", buttons: [{ type: "URL", text: "Ir", url: "http://x.test" }] }],
    };
    expect(importarModeloJson(JSON.stringify(linkHttp))).toMatchObject({
      ok: false,
      erro: "O botão de link precisa de um endereço https://.",
      campo: "components.1.buttons.0.url",
    });
  });

  it("recusa cabeçalho de mídia e tipo de componente desconhecido (Flows fica fora)", () => {
    const midia = { ...VALIDO, components: [{ type: "HEADER", format: "IMAGE" }, VALIDO.components[1]] };
    expect(importarModeloJson(JSON.stringify(midia))).toMatchObject({ ok: false, campo: "components.0.format" });
    const flow = { ...VALIDO, components: [VALIDO.components[1], { type: "FLOW" }] };
    expect(importarModeloJson(JSON.stringify(flow))).toMatchObject({ ok: false, campo: "components.1.type" });
  });

  it("recusa mais botões do que o formulário edita", () => {
    const quatro = {
      ...VALIDO,
      components: [
        VALIDO.components[1],
        { type: "BUTTONS", buttons: ["a", "b", "c", "d"].map((text) => ({ type: "QUICK_REPLY", text })) },
      ],
    };
    expect(importarModeloJson(JSON.stringify(quatro))).toMatchObject({ ok: false, erro: "Este formulário edita até 3 botões." });
  });
});
