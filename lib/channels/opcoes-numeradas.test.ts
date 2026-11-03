import { describe, expect, it } from "vitest";

import {
  casarRespostaComOpcao,
  interactiveSchema,
  normalizarRotulo,
  opcoesNativasDaMensagem,
  textoComOpcoesNumeradas,
} from "./opcoes-numeradas";

const ITENS = [
  { id: "moradia", label: "Moradia" },
  { id: "investimento", label: "Investimento" },
  { id: "nao_sei", label: "Ainda não sei" },
];

describe("textoComOpcoesNumeradas", () => {
  it("corpo, linha em branco e uma opção numerada por linha", () => {
    expect(textoComOpcoesNumeradas("Qual o objetivo?", { kind: "buttons", items: ITENS })).toBe(
      "Qual o objetivo?\n\n1) Moradia\n2) Investimento\n3) Ainda não sei",
    );
  });

  it("na lista, a descrição segue o rótulo", () => {
    expect(
      textoComOpcoesNumeradas("Escolha:", {
        kind: "list",
        button_label: "Ver opções",
        items: [
          { id: "a", label: "Apartamento", description: "até 2 quartos" },
          { id: "c", label: "Casa" },
        ],
      }),
    ).toBe("Escolha:\n\n1) Apartamento - até 2 quartos\n2) Casa");
  });

  it("o número impresso é o que o casamento aceita", () => {
    const texto = textoComOpcoesNumeradas("?", { kind: "buttons", items: ITENS });
    const linha = texto.split("\n").find((l) => l.endsWith("Investimento"))!;
    const numero = linha.split(")")[0]!;
    expect(casarRespostaComOpcao({ texto: numero }, ITENS)).toBe("investimento");
  });
});

describe("casarRespostaComOpcao", () => {
  it("replyId da resposta nativa vence o texto", () => {
    expect(casarRespostaComOpcao({ texto: "1", replyId: "nao_sei" }, ITENS)).toBe("nao_sei");
  });

  it("replyId que não é de nenhuma opção cai para o texto", () => {
    expect(casarRespostaComOpcao({ texto: "Moradia", replyId: "outra" }, ITENS)).toBe("moradia");
    expect(casarRespostaComOpcao({ texto: "qualquer", replyId: "outra" }, ITENS)).toBeNull();
  });

  it.each([
    ["2", "investimento"],
    [" 2 ", "investimento"],
    ["2)", "investimento"],
    ["2 )", "investimento"],
    ["2.", "investimento"],
    ["opção 2", "investimento"],
    ["Opcao 2", "investimento"],
    ["OPÇÃO   3", "nao_sei"],
    ["op 1", "moradia"],
    ["#1", "moradia"],
  ])("número %j casa com %s", (texto, esperado) => {
    expect(casarRespostaComOpcao({ texto }, ITENS)).toBe(esperado);
  });

  it.each(["0", "4", "12", "opção 9"])("número fora da faixa (%j) não casa", (texto) => {
    expect(casarRespostaComOpcao({ texto }, ITENS)).toBeNull();
  });

  it.each([
    ["moradia", "moradia"],
    ["  MORADIA ", "moradia"],
    ["ainda nao sei", "nao_sei"],
    ["Ainda   NÃO sei", "nao_sei"],
  ])("rótulo normalizado %j casa com %s", (texto, esperado) => {
    expect(casarRespostaComOpcao({ texto }, ITENS)).toBe(esperado);
  });

  it.each([
    "quero moradia",
    "não é moradia, é investimento",
    "moradia?",
    "2 quartos",
    "a 2",
    "",
    "   ",
  ])("texto livre (%j) não casa", (texto) => {
    expect(casarRespostaComOpcao({ texto }, ITENS)).toBeNull();
  });

  it("texto nulo e lista vazia não casam", () => {
    expect(casarRespostaComOpcao({ texto: null }, ITENS)).toBeNull();
    expect(casarRespostaComOpcao({ texto: "1" }, [])).toBeNull();
  });

  it('número fora da faixa tenta o rótulo: opção chamada "10" ou "2024"', () => {
    const anos = [
      { id: "a", label: "2024" },
      { id: "b", label: "10" },
    ];
    expect(casarRespostaComOpcao({ texto: "2024" }, anos)).toBe("a");
    expect(casarRespostaComOpcao({ texto: "10" }, anos)).toBe("b");
    // Dentro da faixa, o número continua valendo pela posição.
    expect(casarRespostaComOpcao({ texto: "1" }, anos)).toBe("a");
  });

  it.each([
    ["2) Investimento", "investimento"],
    ["2 - investimento", "investimento"],
    ["2. INVESTIMENTO", "investimento"],
    ["3)ainda nao sei", "nao_sei"],
    ["1-Moradia", "moradia"],
  ])("número e rótulo que concordam (%j) casam com %s", (texto, esperado) => {
    expect(casarRespostaComOpcao({ texto }, ITENS)).toBe(esperado);
  });

  it.each(["1) Investimento", "2 - Moradia", "4. Moradia", "2) Investimento já"])(
    "número e rótulo que discordam (%j) não casam",
    (texto) => {
      expect(casarRespostaComOpcao({ texto }, ITENS)).toBeNull();
    },
  );

  it("dois rótulos iguais depois de normalizar: ambíguo, não casa", () => {
    const dup = [
      { id: "a", label: "Sim" },
      { id: "b", label: "SIM" },
    ];
    expect(casarRespostaComOpcao({ texto: "sim" }, dup)).toBeNull();
    // Pelo número continua inequívoco.
    expect(casarRespostaComOpcao({ texto: "2" }, dup)).toBe("b");
  });
});

describe("normalizarRotulo", () => {
  it("tira acento, baixa a caixa e colapsa espaços", () => {
    expect(normalizarRotulo("  Ação   Imediata ")).toBe("acao imediata");
  });
});

describe("interactiveSchema", () => {
  it("aceita até 3 botões com rótulo até 20", () => {
    expect(interactiveSchema.safeParse({ kind: "buttons", items: ITENS }).success).toBe(true);
  });

  it("recusa 4 botões, rótulo de 21 e ids repetidos", () => {
    expect(
      interactiveSchema.safeParse({ kind: "buttons", items: [...ITENS, { id: "x", label: "X" }] })
        .success,
    ).toBe(false);
    expect(
      interactiveSchema.safeParse({ kind: "buttons", items: [{ id: "a", label: "x".repeat(21) }] })
        .success,
    ).toBe(false);
    expect(
      interactiveSchema.safeParse({
        kind: "buttons",
        items: [
          { id: "a", label: "A" },
          { id: "a", label: "B" },
        ],
      }).success,
    ).toBe(false);
  });

  it("lista: até 10 itens, rótulo até 24, descrição até 72, botão até 20", () => {
    const item = (i: number) => ({
      id: `i${i}`,
      label: "x".repeat(24),
      description: "d".repeat(72),
    });
    const dez = Array.from({ length: 10 }, (_, i) => item(i));
    expect(
      interactiveSchema.safeParse({ kind: "list", button_label: "b".repeat(20), items: dez })
        .success,
    ).toBe(true);
    expect(
      interactiveSchema.safeParse({ kind: "list", button_label: "Ver", items: [...dez, item(10)] })
        .success,
    ).toBe(false);
    expect(
      interactiveSchema.safeParse({ kind: "list", button_label: "b".repeat(21), items: [item(0)] })
        .success,
    ).toBe(false);
    expect(
      interactiveSchema.safeParse({
        kind: "list",
        button_label: "Ver",
        items: [{ id: "a", label: "x".repeat(25) }],
      }).success,
    ).toBe(false);
    expect(
      interactiveSchema.safeParse({
        kind: "list",
        button_label: "Ver",
        items: [{ id: "a", label: "A", description: "d".repeat(73) }],
      }).success,
    ).toBe(false);
  });

  it("recusa lista vazia e kind desconhecido", () => {
    expect(interactiveSchema.safeParse({ kind: "buttons", items: [] }).success).toBe(false);
    expect(interactiveSchema.safeParse({ kind: "carrossel", items: ITENS }).success).toBe(false);
  });
});

describe("opcoesNativasDaMensagem", () => {
  it("devolve as opções quando a entrega foi nativa", () => {
    expect(
      opcoesNativasDaMensagem({
        interactive: { kind: "buttons", items: ITENS, entrega: "nativa" },
      }),
    ).toEqual({ kind: "buttons", items: ITENS });
  });

  it("texto numerado, metadata sem opções ou opções corrompidas: null", () => {
    expect(
      opcoesNativasDaMensagem({
        interactive: { kind: "buttons", items: ITENS, entrega: "texto_numerado" },
      }),
    ).toBeNull();
    expect(opcoesNativasDaMensagem({})).toBeNull();
    expect(opcoesNativasDaMensagem(null)).toBeNull();
    expect(
      opcoesNativasDaMensagem({ interactive: { kind: "buttons", items: "x", entrega: "nativa" } }),
    ).toBeNull();
  });
});
