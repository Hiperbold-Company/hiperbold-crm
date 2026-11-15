/**
 * A leitura das mensagens do popup do Cadastro Incorporado. O que importa provar: a ORIGEM é conferida
 * pelo host (o popup é a única fonte confiável de `phone_number_id`), e a v4 e a v5 do evento dão o mesmo
 * resultado, mesmo trocando o nome do campo da WABA.
 */
import { describe, expect, it } from "vitest";

import { lerEventoDoCadastroIncorporado } from "@/lib/channels/meta/cadastro-incorporado/evento";

const FINISH_V4 = {
  type: "WA_EMBEDDED_SIGNUP",
  event: "FINISH",
  data: { phone_number_id: "1103328999528818", waba_id: "2434045433735175" },
};

describe("lerEventoDoCadastroIncorporado: origem", () => {
  it.each(["https://www.facebook.com", "https://web.facebook.com", "https://facebook.com"])(
    "aceita %s",
    (origem) => {
      expect(lerEventoDoCadastroIncorporado(origem, FINISH_V4)?.tipo).toBe("finalizado");
    },
  );

  it.each([
    "https://facebook.com.evil.com",
    "https://evilfacebook.com",
    "https://www.facebook.com.evil.com",
    "http://www.facebook.com",
    "https://evil.com/.facebook.com",
    "null",
    "",
  ])("recusa %s", (origem) => {
    expect(lerEventoDoCadastroIncorporado(origem, FINISH_V4)).toBeNull();
  });
});

describe("lerEventoDoCadastroIncorporado: formato", () => {
  const origem = "https://www.facebook.com";

  it("aceita string JSON e objeto, com o mesmo resultado", () => {
    expect(lerEventoDoCadastroIncorporado(origem, JSON.stringify(FINISH_V4))).toEqual(
      lerEventoDoCadastroIncorporado(origem, FINISH_V4),
    );
  });

  it("v4: usa waba_id", () => {
    expect(lerEventoDoCadastroIncorporado(origem, FINISH_V4)).toEqual({
      tipo: "finalizado",
      evento: "FINISH",
      phoneNumberId: "1103328999528818",
      wabaId: "2434045433735175",
    });
  });

  it("v5: waba_id some e vale messaging_account_ids[0]", () => {
    const v5 = {
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      data: { phone_number_id: "111", messaging_account_ids: ["222", "333"] },
    };
    expect(lerEventoDoCadastroIncorporado(origem, v5)).toMatchObject({
      tipo: "finalizado",
      phoneNumberId: "111",
      wabaId: "222",
    });
  });

  it("FINISH_ONLY_WABA sem número: finalizado com phoneNumberId nulo (a tela decide)", () => {
    const e = lerEventoDoCadastroIncorporado(origem, {
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH_ONLY_WABA",
      data: { waba_ids: ["999"] },
    });
    expect(e).toEqual({ tipo: "finalizado", evento: "FINISH_ONLY_WABA", phoneNumberId: null, wabaId: "999" });
  });

  it("CANCEL devolve a etapa em que o usuário parou", () => {
    expect(
      lerEventoDoCadastroIncorporado(origem, {
        type: "WA_EMBEDDED_SIGNUP",
        event: "CANCEL",
        data: { current_step: "PHONE_NUMBER_SETUP" },
      }),
    ).toEqual({ tipo: "cancelado", etapa: "PHONE_NUMBER_SETUP" });
  });

  it("ERROR devolve a mensagem da Meta", () => {
    expect(
      lerEventoDoCadastroIncorporado(origem, {
        type: "WA_EMBEDDED_SIGNUP",
        event: "ERROR",
        data: { error_message: "Algo deu errado" },
      }),
    ).toEqual({ tipo: "erro", mensagem: "Algo deu errado" });
  });

  it.each([
    ["texto que não é JSON", "oi"],
    ["JSON de outro tipo", JSON.stringify({ type: "OUTRO", event: "FINISH" })],
    ["evento desconhecido", { type: "WA_EMBEDDED_SIGNUP", event: "STEP_X", data: {} }],
    ["sem evento", { type: "WA_EMBEDDED_SIGNUP" }],
    ["null", null],
    ["número", 42],
    ["array", []],
  ])("lixo (%s) vira null, sem exceção", (_nome, dado) => {
    expect(lerEventoDoCadastroIncorporado(origem, dado)).toBeNull();
  });
});
